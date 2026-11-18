import express from 'express';
import type { Request, Response } from 'express';
import multer from 'multer';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import {
  getDb, searchMessageIds, refreshFolderCounts, indexMessageFts,
  readBodyFiles, bodyHtmlPath, bodyTextPath,
} from '../db.js';
import type { MessageRow, AttachmentRow } from '../db.js';
import { envelopeOf } from '../engine.js';
import type { SyncEngine } from '../engine.js';
import { sendMail, buildRawMail } from '../smtpUtil.js';
import { smtpResponseCode, isTransientSmtpError, isPermanentSmtpError, isAuthError } from '../imapUtil.js';
import { claimSendKey, completeSendKey, releaseSendKey, newPlannedMessageId } from '../idempotency.js';
import { decryptSecret } from '../cryptoUtil.js';
import { emit } from '../hub.js';
import { log } from '../config.js';
import type { Ctx } from './accountRoutes.js';

// B14: 发信附件改磁盘临时存储（os.tmpdir()）——内存存储下 10 个 25MB
// 附件能把 250MB 全塞进进程内存；落盘后发完清理临时文件。
// 单文件仍限 25MB（server.ts 的 MulterError 处理不变），总大小另限 50MB
// （路由里校验，见 send）。
const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, os.tmpdir()),
    filename: (_req, _file, cb) =>
      cb(null, `luck-mail-upload-${process.pid}-${Date.now()}-${crypto.randomUUID()}`),
  }),
  limits: { fileSize: 25 * 1024 * 1024, files: 10 },
});
const MAX_TOTAL_ATTACHMENT_BYTES = 50 * 1024 * 1024;

// 批量删除任务状态（单进程内存）：前端刷新/切页回来后，靠它继续显示“删除中…”。
// 删完（或出错）后 running=false；重启后任务丢失，等同于未在删除。
// view 记下发起删除的视图（{kind, accountId, folderId}）：刷新后前端靠 delete-status
// 拿回它，删除中提示只显示在发起删除的那个视图（所有已删除/所有未读/所有草稿等聚合视图通用）。
// B13: deleteTask 从模块单例改为按 taskId 隔离的 Map——两个标签页/两次
// 批量删除不再互相覆盖进度；旧的单任务字段（running/total/deleted/
// startedAt/view）原样保留在每个任务对象里。
interface DeleteTask {
  taskId: string;
  running: boolean;
  total: number;
  deleted: number;
  failed: Array<{ id: number; error: string }>;
  startedAt: number;
  finishedAt: number | null;
  view: { kind: string; accountId: number | null; folderId: number | null } | null;
}
const deleteTasks = new Map<string, DeleteTask>();
// 空任务（前端轮询时兜底）：保持旧 delete-status 在无任务时的返回形状。
const EMPTY_DELETE_TASK: Omit<DeleteTask, 'taskId' | 'failed' | 'finishedAt'> = {
  running: false, total: 0, deleted: 0, startedAt: 0, view: null,
};

function pruneDeleteTasks(): void {
  const now = Date.now();
  for (const [id, t] of deleteTasks) {
    if (!t.running && t.finishedAt && now - t.finishedAt > 60 * 60 * 1000) deleteTasks.delete(id);
  }
  // 兜底上限：只留最近 20 个任务。L5: 只删已完成的任务——正在跑的
  // 任务删掉后前端轮询会 404，进度直接丢了。
  if (deleteTasks.size > 20) {
    const doneIds = [...deleteTasks.entries()].filter(([, t]) => !t.running).map(([id]) => id);
    const excess = deleteTasks.size - 20;
    for (const id of doneIds.slice(0, Math.max(0, excess))) deleteTasks.delete(id);
  }
}

// Audit #9 M3：async 路由处理器统一兜底——Express 4.21.2 无
// express-async-errors，async 处理器返回 rejected promise 时 Express 4
// 不接管，会变成未处理 rejection。wrapAsync 把它转成统一 500 JSON。
// 已有内层 try/catch 的逻辑不动，只在外层兜底未覆盖的异常。
function wrapAsync(fn: (req: Request, res: Response) => Promise<void>): (req: Request, res: Response) => void {
  return (req: Request, res: Response) => {
    void fn(req, res).catch((e: unknown) => {
      log('async route failed', req.method, req.path, (e as Error)?.message || e);
      if (!res.headersSent) res.status(500).json({ ok: false, error: '服务器内部错误，请重试' });
    });
  };
}

// Audit #9 L10：发信前基本邮箱格式校验（只拦明显非法格式，不做
// MX/DNS 校验；SMTP 侧仍是最终判定）。
function isValidEmail(addr: string): boolean {
  return /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(addr);
}

// multer/busboy 把 multipart 文件名按 Latin-1 解码，中文等非 ASCII 文件名会变成乱码
// （UTF-8 字节被当成 Latin-1 读，如“门槛”变成“é—¨æ§”）。把 Latin-1 再转回 UTF-8
// 即可还原；用往返校验兜底：只有“转回 UTF-8 再按 Latin-1 读回去等于原值”时才采用，
// 避免把本来就正确的名字改坏。
function fixMultipartFilename(name: string): string {
  try {
    const fixed = Buffer.from(name, 'latin1').toString('utf8');
    if (fixed !== name && Buffer.from(fixed, 'utf8').toString('latin1') === name) return fixed;
    return name;
  } catch {
    return name;
  }
}

function messageRowQuery(): string {
  return `SELECT m.*, a.email AS account_email, f.path AS folder_path
          FROM messages m
          JOIN accounts a ON a.id = m.account_id
          LEFT JOIN folders f ON f.id = m.folder_id`;
}

// Build the WHERE clause for a list view. Returns {where, params} or an
// error string when required params are missing.
function viewFilter(
  view: string | undefined,
  accountId: string | undefined,
  folderId: string | undefined,
): { where: string; params: unknown[] } | { error: string } {
  const where: string[] = [];
  const params: unknown[] = [];
  const folderType = (t: string): string => `m.folder_id IN (SELECT id FROM folders WHERE type='${t}')`;
  switch (view) {
    case 'all-inbox': where.push(folderType('inbox')); break;
    case 'all-unread': where.push('m.is_read=0'); break;
    case 'all-sent': where.push(folderType('sent')); break;
    case 'all-drafts': where.push(folderType('drafts')); break;
    case 'all-trash': where.push(folderType('trash')); break;
    case 'folder':
      if (!accountId || !folderId) return { error: 'view=folder 需要 accountId 与 folderId' };
      where.push('m.account_id=?', 'm.folder_id=?');
      params.push(Number(accountId), Number(folderId));
      break;
    case undefined:
    case '':
    case null:
      break;
    default:
      return { error: `未知 view: ${view}` };
  }
  if (accountId && view !== 'folder') {
    where.push('m.account_id=?');
    params.push(Number(accountId));
  }
  return { where: where.join(' AND '), params };
}

function listMessages(req: Request, res: Response): void {
  const db = getDb();
  const { view, accountId, folderId, q, limit, offset } = req.query as Record<string, string | undefined>;
  const lim = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const off = Math.max(Number(offset) || 0, 0);
  const vf = viewFilter(view, accountId, folderId);
  if ('error' in vf) {
    res.status(400).json({ ok: false, error: vf.error });
    return;
  }
  let where = vf.where;
  let params: unknown[] = [...vf.params];

  if (q && String(q).trim()) {
    // 搜索默认全局：不按当前视图过滤。以前搜只在当前视图里找，
    // 150/209 封信在“其他文件夹”（如广告邮件）里，在“所有收件箱”里搜
    // 永远搜不到，用户会以为搜索坏了。搜到后结果里带 folder_path，
    // 用户能看到每封信在哪个文件夹。
    // searchMessageIds 已按相关度排好序：直接按此顺序分页、展示，不再按时间重排。
    // Audit #9 L5：命中达 2000 时 searchMessageIds 截断并置 truncated，
    // 这里原样透传；total 仍是本次返回的 id 列表长度（不悄悄改语义），
    // 前端凭 truncated:true 提示“仅显示前 2000 条”。
    const searchResult = searchMessageIds(String(q));
    const ids = searchResult?.ids ?? null;
    const truncated = searchResult?.truncated ?? false;
    if (!ids || ids.length === 0) {
      res.json({ ok: true, messages: [], total: 0, ...(truncated ? { truncated: true } : {}) });
      return;
    }
    const total = ids.length;
    const pageIds = ids.slice(off, off + lim);
    if (!pageIds.length) {
      res.json({ ok: true, messages: [], total, ...(truncated ? { truncated: true } : {}) });
      return;
    }
    const placeholders = pageIds.map(() => '?').join(',');
    const rows = db.prepare(
      `${messageRowQuery()} WHERE m.id IN (${placeholders})`,
    ).all(...(pageIds as never[])) as MessageRow[];
    const order = new Map(pageIds.map((id, i) => [id, i]));
    rows.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
    res.json({ ok: true, messages: rows.map((row) => envelopeOf(row, row.account_email || '')), total, ...(truncated ? { truncated: true } : {}) });
    return;
  }
  const whereSql = where ? `WHERE ${where}` : '';
  const total = (db.prepare(`SELECT COUNT(*) c FROM messages m ${whereSql}`).get(...(params as never[])) as { c: number }).c;
  const rows = db.prepare(
    `${messageRowQuery()} ${whereSql} ORDER BY m.date DESC, m.id DESC LIMIT ? OFFSET ?`,
  ).all(...(params as never[]), lim, off) as MessageRow[];
  res.json({ ok: true, messages: rows.map((row) => envelopeOf(row, row.account_email || '')), total });
}

// Audit #5b：崩溃窗口重认领时，查指定 Message-ID 的信是不是已经在
// 已发送文件夹里了——先查本地 messages 表（已发送文件夹），本地没有
// 再查服务器已发送文件夹（engine.findSentByMessageId，F3 做法）。
// 查到返回 { localId }（本地没有时 localId 为 null，下次同步会取回）；
// 查不到返回 null。服务器查不到/IMAP 不通时当作没查到（继续发送，
// 但复用同一个 planned Message-ID，收件方仍可凭 ID 去重）。
async function findAlreadySent(
  engine: SyncEngine, accountId: number, messageId: string,
): Promise<{ localId: number | null } | null> {
  const db = getDb();
  const local = db.prepare(
    `SELECT id FROM messages WHERE account_id=? AND folder_id IN
       (SELECT id FROM folders WHERE account_id=? AND type='sent')
     AND message_id=? LIMIT 1`,
  ).get(accountId, accountId, messageId) as { id: number } | undefined;
  if (local) return { localId: local.id };
  try {
    const onServer = await engine.findSentByMessageId(accountId, messageId);
    if (onServer) return { localId: null };
  } catch (e) {
    log('send re-claim server sent check failed', accountId, (e as Error)?.message || e);
  }
  return null;
}

export function messageRoutes(ctx: Ctx): express.Router {
  const { engine, masterKey } = ctx;
  const r = express.Router();

  r.get('/messages', (req: Request, res: Response) => listMessages(req, res));

  // 批量删除任务状态：前端刷新/切页回来后查它，任务未完成时继续显示“删除中…”。
  // 必须放在 /messages/:id 前面，否则 Express 会把 delete-status 当成 :id 匹配掉。
  // B13: ?taskId= 查指定任务；不传则返回最近一个任务（兼容旧前端），
  // 无任何任务时返回空任务（running:false）。
  r.get('/messages/delete-status', (req: Request, res: Response) => {
    const taskId = typeof req.query.taskId === 'string' ? req.query.taskId : '';
    if (taskId) {
      const task = deleteTasks.get(taskId);
      if (!task) {
        res.status(404).json({ ok: false, error: '删除任务不存在' });
        return;
      }
      res.json({ ok: true, ...task });
      return;
    }
    const tasks = [...deleteTasks.values()];
    const latest = tasks.length ? tasks[tasks.length - 1] : null;
    if (!latest) {
      res.json({ ok: true, ...EMPTY_DELETE_TASK });
      return;
    }
    res.json({ ok: true, ...latest });
  });

  r.get('/messages/:id', wrapAsync(async (req: Request, res: Response) => {
    const db = getDb();
    const id = Number(req.params.id);
    const row0 = db.prepare('SELECT * FROM messages WHERE id=?').get(id) as MessageRow | undefined;
    if (!row0) {
      res.status(404).json({ ok: false, error: '邮件不存在' });
      return;
    }
    try {
      await engine.fetchFullMessage(row0.account_id, id);
    } catch (e) {
      // Full fetch failed (e.g. IMAP down): still serve the cached envelope.
      log('fetchFullMessage failed', id, (e as Error)?.message || e);
    }
    const row = db.prepare(`${messageRowQuery()} WHERE m.id=?`).get(id) as MessageRow | undefined;
    if (!row) {
      res.status(404).json({ ok: false, error: '邮件不存在' });
      return;
    }
    const attachments = (db.prepare(
      'SELECT id, filename, content_type AS contentType, size, cached FROM attachments WHERE message_id=?',
    ).all(id) as { id: number; filename: string; contentType: string; size: number; cached: number }[])
      .map((a) => ({
        id: a.id,
        filename: a.filename,
        size: a.size,
        contentType: a.contentType,
        large: false, // 附件默认不下载、无“较大”之分；下载一律从 IMAP 实时取
        cached: !!a.cached,
      }));
    // Audit #9 L16：GET 只读返回，不再标已读（GET 有写副作用违反安全语义）。
    // 部署依赖：前端侧同步改 openMessage——拿到正文后显式调 POST
    // /messages/:id/read（setRead），两边同一批部署、无窗口期。
    // Audit #9 L2：复用上面已查到的 row，不再第 3 次查同一封信
    // （第 1 次 SELECT *、第 2 次 messageRowQuery 已够；fetchFullMessage
    // 只补正文文件，不改行内容）。
    // Bodies live on disk (contract): read the sanitized HTML + plain text.
    const { bodyText, bodyHtml } = readBodyFiles(id);
    res.json({
      ok: true,
      message: {
        ...envelopeOf(row, row.account_email || ''),
        cc: JSON.parse(row.cc_json || '[]') as string[],
        bodyText,
        bodyHtml,
        attachments,
      },
    });
  }));

  r.post('/messages/:id/read', wrapAsync(async (req: Request, res: Response) => {
    const db = getDb();
    const id = Number(req.params.id);
    const row = db.prepare('SELECT * FROM messages WHERE id=?').get(id) as MessageRow | undefined;
    if (!row) {
      res.status(404).json({ ok: false, error: '邮件不存在' });
      return;
    }
    const read = (req.body as Record<string, unknown> | undefined)?.read !== false;
    try {
      await engine.setRead(row.account_id, id, read);
    } catch (e) {
      // Audit #8 LOW-7：IMAP 暂时不通时先本地更新、待同步回补（与打开
      // 邮件的路径一致），不再一直 502——用户点“标为已读/未读”在断网
      // 时也能生效，下次同步时服务器 flags 会再对账。
      log('mark-read failed, falling back to local-only', id, (e as Error)?.message || e);
      db.prepare('UPDATE messages SET is_read=?, updated_at=datetime(\'now\') WHERE id=?').run(read ? 1 : 0, id);
      if (row.folder_id) refreshFolderCounts(row.folder_id);
      emit('mail-updated', { messageId: id, accountId: row.account_id, folderId: row.folder_id, changes: { isRead: read } });
    }
    res.json({ ok: true });
  }));

  r.post('/messages/:id/move', wrapAsync(async (req: Request, res: Response) => {
    const db = getDb();
    const id = Number(req.params.id);
    const row = db.prepare('SELECT * FROM messages WHERE id=?').get(id) as MessageRow | undefined;
    if (!row) {
      res.status(404).json({ ok: false, error: '邮件不存在' });
      return;
    }
    const folderId = Number((req.body as Record<string, unknown> | undefined)?.folderId);
    if (!folderId) {
      res.status(400).json({ ok: false, error: 'folderId 必填' });
      return;
    }
    try {
      await engine.moveMessage(row.account_id, id, folderId);
    } catch (e) {
      res.status(502).json({ ok: false, error: `IMAP 移动失败：${String((e as Error)?.message || e).slice(0, 300)}` });
      return;
    }
    res.json({ ok: true });
  }));

  r.delete('/messages/:id', wrapAsync(async (req: Request, res: Response) => {
    const db = getDb();
    const id = Number(req.params.id);
    // L1（后端半边）：删信幂等键。响应丢失后用户重试同一动作时，
    // 同一 key 直接返回第一次的结果，不再执行第二次删除——否则一次
    // “移到已删除”重试后会变成永久删除。key 由前端每次删除动作生成
    // 一个新 UUID 传下来（query 或 body 都认）；未传 key 时保持现有行为。
    const rawKey = (req.query.idempotencyKey as string | undefined)
      ?? (req.body as Record<string, unknown> | undefined)?.idempotencyKey;
    const delKey = typeof rawKey === 'string' ? rawKey.trim() : '';
    if (delKey && delKey.length > 128) {
      res.status(400).json({ ok: false, error: 'idempotencyKey 过长' });
      return;
    }
    if (delKey) {
      const prior = db.prepare('SELECT message_db_id, failed_at FROM delete_idempotency WHERE idempotency_key=?').get(delKey) as { message_db_id: number | null; failed_at: string | null } | undefined;
      if (prior) {
        // Audit #9 L14：占位行带 failed_at 时表示上次删除失败过——重试
        // 不再谎报 duplicate:true，返回 502 让用户用新 key 再删。
        if (prior.failed_at) {
          res.status(502).json({ ok: false, error: '上次删除失败（IMAP 删除未成功），请用新的删除操作重试' });
          return;
        }
        if (prior.message_db_id === id) {
          res.json({ ok: true, duplicate: true });
          return;
        }
        res.status(409).json({ ok: false, error: 'idempotencyKey 已用于另一封邮件' });
        return;
      }
    }
    const row = db.prepare('SELECT * FROM messages WHERE id=?').get(id) as MessageRow | undefined;
    if (!row) {
      res.status(404).json({ ok: false, error: '邮件不存在' });
      return;
    }
    // 是否永久删除由后端按邮件实际所在文件夹决定（只看 folder.type），
    // 不再信任客户端传的 permanent（搜索是全局的，视图判断会错删）。
    // Audit #7 MED-1：先占位、后删除——查 prior 与执行删除之间夹着一次
    // await（IMAP），两路并发带同一 key 时都会查不到、都执行删除，
    // 第二路会把第一路刚移进已删除的信彻底删除。占位用 INSERT OR IGNORE
    //（key 是 PRIMARY KEY，原子抢占）：抢不到的重读返回 duplicate/409，
    // 不执行删除。占位即使删除失败也保留（删信记录保留 7 天才清），但 Audit #9 L14
    // 给失败占位行打 failed_at 标记：同一 key 重试时不再谎报
    // duplicate:true（见上面 prior 检查，返回 502），用户用新 key
    // 再删即可——比“重试变彻底删除”的不可逆误删安全，也比谎报成功诚实。
    if (delKey) {
      const claim = db.prepare('INSERT OR IGNORE INTO delete_idempotency (idempotency_key, message_db_id) VALUES (?,?)')
        .run(delKey, id);
      if (claim.changes === 0) {
        const prior2 = db.prepare('SELECT message_db_id, failed_at FROM delete_idempotency WHERE idempotency_key=?').get(delKey) as { message_db_id: number | null; failed_at: string | null } | undefined;
        if (prior2?.failed_at) {
          res.status(502).json({ ok: false, error: '上次删除失败（IMAP 删除未成功），请用新的删除操作重试' });
          return;
        }
        if (prior2?.message_db_id === id) {
          res.json({ ok: true, duplicate: true });
          return;
        }
        res.status(409).json({ ok: false, error: 'idempotencyKey 已用于另一封邮件' });
        return;
      }
    }
    try {
      await engine.deleteMessage(row.account_id, id);
    } catch (e) {
      // Audit #9 M1：另一路正在删同一封信——报 409 冲突，不当作删除失败
      //（不打 failed_at、不走 502），前端可稍后用新 key 重试。
      const ec = e as Error & { status?: number; code?: string };
      if (ec?.status === 409 || ec?.code === 'DELETE_IN_FLIGHT') {
        res.status(409).json({ ok: false, error: ec.message || '该邮件正在删除中，请稍后再试' });
        return;
      }
      // B19: 删除失败可观测性——记下账号、消息 id 与错误，否则 502 只在
      // 前端闪一下，服务端日志里查不到是哪封、哪个账号失败。
      log('delete failed', `account=${row.account_id} message=${id}`, (e as Error)?.message || e);
      // Audit #9 L14：删除失败给占位行打 failed_at，同一 key 重试不再谎报成功。
      if (delKey) {
        try { db.prepare("UPDATE delete_idempotency SET failed_at=datetime('now') WHERE idempotency_key=?").run(delKey); } catch { /* ignore */ }
      }
      res.status(502).json({ ok: false, error: `IMAP 删除失败：${String((e as Error)?.message || e).slice(0, 300)}` });
      return;
    }
    res.json({ ok: true });
  }));

  // 批量删除：一次删多封（移到已删除；已在已删除里的彻底删除）。
  // B13: 不再队头阻塞——立即返回 {ok, taskId, status:'running'}，删除在
  // 后台逐封跑（与单封删除同一语义）；进度与最终结果走
  // GET /api/messages/delete-status?taskId=… 轮询。任务按 taskId 隔离，
  // 多个批量删除互不覆盖。
  r.post('/messages/batch-delete', (req: Request, res: Response) => {
    const raw = Array.isArray(req.body?.ids) ? req.body.ids : [];
    // Audit #9 H1：同一请求内 id 重复会确定性永久删除（第 1 轮移入已删除，
    // 第 2 轮读到已在 trash 走彻底删除分支）——循环前先去重。
    // 注：不用 [...new Set(raw.map(...))] 的写法——tsc 在此会把结果推断为
    // unknown[]（TS2322），改用显式循环去重。
    const ids: number[] = [];
    for (const x of raw as unknown[]) {
      const n = Number(x);
      if (Number.isFinite(n) && n > 0 && !ids.includes(n)) ids.push(n);
    }
    if (!ids.length) {
      res.status(400).json({ ok: false, error: 'ids 不能为空' });
      return;
    }
    if (ids.length > 200) {
      res.status(400).json({ ok: false, error: '一次最多删除 200 封' });
      return;
    }
    // L1（后端半边）：批量删信幂等键。同一 key 重复提交时直接返回
    // 第一次的任务 id（前端继续轮询同一任务），不另起任务、不重复删。
    // key 由前端每次批量删除动作生成一个新 UUID 传下来；未传时保持现有行为。
    const batchKey = typeof req.body?.idempotencyKey === 'string' ? req.body.idempotencyKey.trim() : '';
    if (batchKey && batchKey.length > 128) {
      res.status(400).json({ ok: false, error: 'idempotencyKey 过长' });
      return;
    }
    if (batchKey) {
      const prior = getDb().prepare('SELECT task_id FROM delete_idempotency WHERE idempotency_key=?').get(batchKey) as { task_id: string | null } | undefined;
      if (prior) {
        if (prior.task_id) {
          const priorTask = deleteTasks.get(prior.task_id);
          res.json({
            ok: true,
            taskId: prior.task_id,
            // Audit #7 LOW-1：任务已不在内存（重启/剪枝）时返回 'unknown'，
            // 不要谎报 'finished'——前端轮询不到任务时会按失败对账重拉列表。
            status: priorTask ? (priorTask.running ? 'running' : 'finished') : 'unknown',
            duplicate: true,
          });
          return;
        }
        // 记录存在但无 task_id（该 key 曾被单删用过）：不复用，直接 409，
        // 不让批量任务顶掉单删的幂等记录。
        res.status(409).json({ ok: false, error: 'idempotencyKey 已用于其他删除' });
        return;
      }
    }
    // 记下发起删除的视图，供刷新后 delete-status 返回（前端据此只在该视图显示删除中）。
    const v = req.body?.view as { kind?: unknown; accountId?: unknown; folderId?: unknown } | undefined;
    const view = (v && typeof v.kind === 'string')
      ? {
        kind: v.kind,
        accountId: typeof v.accountId === 'number' ? v.accountId : null,
        folderId: typeof v.folderId === 'number' ? v.folderId : null,
      }
      : null;
    pruneDeleteTasks();
    // Audit #7 MED-1：先占位再建任务——与单删同理，INSERT OR IGNORE 原子
    // 抢占；抢不到的重读返回已有 taskId，不另起任务、不重复删。
    // （本处理器全程同步、单进程内本无交错点，占位是防御性收紧，
    // 也防以后重构加 await 或多进程部署时复发。）
    const taskId = crypto.randomUUID();
    if (batchKey) {
      const claim = getDb().prepare('INSERT OR IGNORE INTO delete_idempotency (idempotency_key, task_id) VALUES (?,?)')
        .run(batchKey, taskId);
      if (claim.changes === 0) {
        const prior = getDb().prepare('SELECT task_id FROM delete_idempotency WHERE idempotency_key=?').get(batchKey) as { task_id: string | null } | undefined;
        if (prior?.task_id) {
          const priorTask = deleteTasks.get(prior.task_id);
          res.json({
            ok: true,
            taskId: prior.task_id,
            status: priorTask ? (priorTask.running ? 'running' : 'finished') : 'unknown',
            duplicate: true,
          });
          return;
        }
        res.status(409).json({ ok: false, error: 'idempotencyKey 已用于其他删除' });
        return;
      }
    }
    const task: DeleteTask = {
      taskId,
      running: true,
      total: ids.length,
      deleted: 0,
      failed: [],
      startedAt: Date.now(),
      finishedAt: null,
      view,
    };
    deleteTasks.set(task.taskId, task);
    // 后台跑：逐封走 engine.deleteMessage；跑完 running=false。
    // 注意不在请求上下文里抛错——失败记进 task.failed，前端轮询可见。
    // L2: 循环本身抛错（非单封失败，如 getDb 异常）时也要把任务置完成，
    // 否则前端永远轮询一个 running=true 的死任务。
    void (async () => {
      const db = getDb();
      // Audit #9 H1（第二道防线）：本次任务内已处理过的 id 直接跳过，
      // 不再执行第二次删除（即使上游某处又传进重复 id）。
      const seen = new Set<number>();
      for (const id of ids) {
        if (seen.has(id)) continue;
        seen.add(id);
        // Audit #5b：单行 SELECT 也包进按行 try/catch——之前只有
        // deleteMessage 在 try 里，某行 SELECT 一抛错（如表损坏/锁），
        // 剩余 id 不进 failed 列表，任务直接置 finished，前端以为
        // “删完了”其实一批都没删。出错的行进 failed，批次继续。
        let row: MessageRow | undefined;
        try {
          row = db.prepare('SELECT * FROM messages WHERE id=?').get(id) as MessageRow | undefined;
        } catch (e) {
          task.failed.push({ id, error: String((e as Error)?.message || e).slice(0, 200) });
          continue;
        }
        if (!row) { task.failed.push({ id, error: '邮件不存在' }); continue; }
        try {
          await engine.deleteMessage(row.account_id, id);
          task.deleted += 1;
        } catch (e) {
          task.failed.push({ id, error: String((e as Error)?.message || e).slice(0, 200) });
        }
      }
      task.running = false;
      task.finishedAt = Date.now();
    })().catch((e: unknown) => {
      log('batch-delete task failed', task.taskId, (e as Error)?.message || e);
      task.running = false;
      task.finishedAt = Date.now();
    });
    res.json({ ok: true, taskId: task.taskId, status: 'running' });
  });

  // ---- 正文翻译：英文 → 中文（只用 DeepL）----
  // 前端点阅读窗右上角“翻译”后调它；返回译文纯文本，前端在 iframe 里以译文/原文切换显示。
  // DeepL 分批翻译：先按段落、再按句子切成 <=450 字节的小段，逐段翻译再拼接。
  function splitForTranslate(text: string, maxBytes = 450): string[][] {
    const paras = text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
    return paras.map((para) => {
      const chunks: string[] = [];
      const sentences = para.split(/(?<=[.!?。！？；;])\s+/).filter(Boolean);
      let cur = '';
      const flush = () => { if (cur.trim()) { chunks.push(cur.trim()); cur = ''; } };
      for (const s of sentences) {
        const cand = cur ? `${cur} ${s}` : s;
        if (Buffer.byteLength(cand, 'utf8') > maxBytes) {
          flush();
          if (Buffer.byteLength(s, 'utf8') > maxBytes) {
            // 单句本身超长：按字符硬切（不拆多字节字符）。
            let buf = '';
            for (const ch of s) {
              if (Buffer.byteLength(buf + ch, 'utf8') > maxBytes) { chunks.push(buf); buf = ch; }
              else buf += ch;
            }
            if (buf) chunks.push(buf);
          } else cur = s;
        } else cur = cand;
      }
      flush();
      return chunks.length ? chunks : [para];
    });
  }

  // ---- 正文翻译：只用 DeepL ----
  // 用户 2026-11-17 决定：换成 DeepL，用外贸站的 DeepL 免费密钥；DeepL 验证
  // 通过后，百度和腾讯已彻底去掉（代码、密钥、SDK 均已删除，不再备用）。
  // DeepL 密钥只放服务器 /opt/luck-mail/.deepl-env（0600），经 systemd
  // EnvironmentFile= 加载；绝不写进单元文件、不进仓库/聊天/记忆。
  // DeepL 无百度式敏感词过滤，白宫类邮件也能翻；且实测从国内服务器可直连
  // api-free.deepl.com。免费 Key（:fx 结尾）走 api-free，付费 Key 走 api。
  // 外贸站密钥为 100 万字符免费额度，有效期至 2027-11-01；邮件翻译量小够用。
  // Audit #9 M6：翻译总预算与上限——单段 15 秒不变，另加总预算 25 秒、
  // 正文 20000 字符 / 200 段 / 300 小段上限，超限直接 413 不调接口。
  const TRANSLATE_TOTAL_TIMEOUT_MS = 25 * 1000;
  const TRANSLATE_MAX_CHARS = 20000;
  const TRANSLATE_MAX_PARAS = 200;
  const TRANSLATE_MAX_CHUNKS = 300;

  async function translateWithDeepL(text: string, attempt = 0): Promise<string> {
    const key = process.env.DEEPL_API_KEY;
    if (!key) throw new Error('未配置 DeepL 密钥');
    const host = key.endsWith(':fx') ? 'api-free.deepl.com' : 'api.deepl.com';
    const body = new URLSearchParams({ text, source_lang: 'EN', target_lang: 'ZH' });
    const resp = await fetch(`https://${host}/v2/translate`, {
      method: 'POST',
      headers: { Authorization: `DeepL-Auth-Key ${key}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.timeout(15000),
    });
    // Audit #9 M6：429 按 Retry-After 退避一次再试（封顶 5 秒）；仍 429
    // 或 5xx 时带 code 抛出，由调用方区分返回，不再一律通用错。
    if (resp.status === 429) {
      if (attempt === 0) {
        const retryAfter = Number(resp.headers.get('retry-after') || '1');
        const waitMs = Math.min(Math.max(Number.isFinite(retryAfter) ? retryAfter * 1000 : 1000, 1000), 5000);
        await new Promise((r) => setTimeout(r, waitMs));
        return translateWithDeepL(text, 1);
      }
      const err = new Error('DeepL 限流') as Error & { code?: string };
      err.code = 'RATE_LIMITED';
      throw err;
    }
    if (!resp.ok) {
      const err = new Error(`DeepL 返回 ${resp.status}`) as Error & { code?: string };
      err.code = resp.status >= 500 ? 'UPSTREAM_5XX' : 'UPSTREAM_ERROR';
      throw err;
    }
    const data = await resp.json() as { message?: string; translations?: { text?: string }[] };
    if ((data as { message?: string }).message) throw new Error(`DeepL 错误：${(data as { message?: string }).message}`);
    const t = data?.translations?.[0]?.text;
    if (typeof t !== 'string' || !t.trim()) throw new Error('DeepL 翻译无返回');
    return t;
  }

  r.post('/messages/:id/translate', wrapAsync(async (req: Request, res: Response) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) { res.status(400).json({ ok: false, error: 'id 无效' }); return; }
    const db = getDb();
    const row = db.prepare('SELECT id, account_id FROM messages WHERE id=?').get(id) as { id: number; account_id: number } | undefined;
    if (!row) { res.status(404).json({ ok: false, error: '邮件不存在' }); return; }
    let { bodyText } = readBodyFiles(id);
    if (!bodyText.trim()) {
      try { await engine.fetchFullMessage(row.account_id, id); } catch (e) {
        log('translate fetchFullMessage failed', id, (e as Error)?.message || e);
      }
      bodyText = readBodyFiles(id).bodyText;
    }
    const text = bodyText.trim();
    if (!text) { res.status(400).json({ ok: false, error: '正文为空，无法翻译' }); return; }
    // 正文已基本是中文时不调翻译接口（免得把中文再“翻”坏，也省免费额度）。
    const letters = text.replace(/[^A-Za-z\u4e00-\u9fff]/g, '');
    const cjk = (letters.match(/[\u4e00-\u9fff]/g) || []).length;
    if (letters.length > 0 && cjk / letters.length > 0.8) {
      res.json({ ok: true, translated: '', alreadyChinese: true });
      return;
    }
    if (text.length > TRANSLATE_MAX_CHARS) {
      res.status(413).json({ ok: false, error: `正文过长（超过 ${TRANSLATE_MAX_CHARS} 字符），无法翻译` });
      return;
    }
    const paras = splitForTranslate(text);
    const totalChunks = paras.reduce((n, p) => n + p.length, 0);
    if (paras.length > TRANSLATE_MAX_PARAS || totalChunks > TRANSLATE_MAX_CHUNKS) {
      res.status(413).json({ ok: false, error: '正文段落过多，无法翻译' });
      return;
    }
    // Audit #9 M6：总预算 25 秒 + 监听请求断开——客户端已断开或超时
    // 时取消后续段落，不再白做功。
    const deadline = Date.now() + TRANSLATE_TOTAL_TIMEOUT_MS;
    let cancelled = false;
    req.on('close', () => { cancelled = true; });
    try {
      const outParas: string[] = [];
      // DeepL 不限流，无需段间延迟（1.1 秒延迟是为百度 QPS=1 加的，DeepL 为主后已去掉）。
      for (const chunks of paras) {
        if (cancelled) return;
        if (Date.now() > deadline) {
          const err = new Error('翻译超时') as Error & { code?: string };
          err.code = 'TIMEOUT';
          throw err;
        }
        const parts: string[] = [];
        for (const c of chunks) {
          if (cancelled) return;
          if (Date.now() > deadline) {
            const err = new Error('翻译超时') as Error & { code?: string };
            err.code = 'TIMEOUT';
            throw err;
          }
          parts.push(await translateWithDeepL(c));
        }
        outParas.push(parts.join(' '));
      }
      if (cancelled) return;
      res.json({ ok: true, translated: outParas.join('\n\n'), alreadyChinese: false });
    } catch (e) {
      if (cancelled) return;
      log('translate failed', id, (e as Error)?.message || e);
      const code = (e as { code?: string })?.code;
      if (code === 'RATE_LIMITED') {
        res.status(429).json({ ok: false, error: '翻译服务限流，请稍后重试' });
        return;
      }
      if (code === 'TIMEOUT') {
        res.status(504).json({ ok: false, error: '翻译超时（超过 25 秒），请缩短正文后重试' });
        return;
      }
      res.status(502).json({ ok: false, error: '翻译服务暂时不可用，请稍后重试' });
    }
  }));

  // 附件下载：附件是元数据-only（不落盘），一律从 IMAP 按 part 号实时流式取回。
  // B18: 磁盘缓存分支已删——生产库查证：attachments 表 0 行、cached=1 的行
  // 0 行（mailStream 从不写 cached 文件，旧分支永远走不到）；磁盘上残留
  // 的 20 个孤儿文件无任何行引用，删分支不影响任何可下载附件。
  r.get('/messages/:id/attachments/:attId', wrapAsync(async (req: Request, res: Response) => {
    const db = getDb();
    const id = Number(req.params.id);
    const attId = Number(req.params.attId);
    const att = db.prepare('SELECT * FROM attachments WHERE id=? AND message_id=?').get(attId, id) as AttachmentRow | undefined;
    if (!att) {
      res.status(404).json({ ok: false, error: '附件不存在' });
      return;
    }
    const msg = db.prepare('SELECT * FROM messages WHERE id=?').get(id) as MessageRow | undefined;
    if (!msg) {
      res.status(404).json({ ok: false, error: '邮件不存在' });
      return;
    }
    const sendHeaders = (): void => {
      res.setHeader('Content-Type', att.content_type || 'application/octet-stream');
      res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(att.filename)}`);
      // D9: 不再按 DB 里记的 size 发 Content-Length——附件是 IMAP 实时流，
      // DB 元数据里的 size 与实际流长度可能不符，错的 Content-Length
      // 会让下载截断或挂起；改走 chunked，由流结束决定长度。
    };
    if (!att.part) {
      res.status(404).json({ ok: false, error: '该附件未缓存且无法从邮箱实时取回' });
      return;
    }
    try {
      sendHeaders();
      await engine.streamAttachment(msg.account_id, id, att, res);
    } catch (e) {
      if (!res.headersSent) {
        res.status(502).json({ ok: false, error: `从邮箱取附件失败：${String((e as Error)?.message || e).slice(0, 300)}` });
        return;
      }
      res.end();
    }
  }));

  // Send: accepts multipart/form-data (attachments) or JSON (no attachments).
  // B14: 附件经 multer diskStorage 落到 os.tmpdir()，发完（无论成功失败）
  // 在 finally 里删临时文件；附件总大小另限 50MB。
  r.post('/messages/send', upload.any(), async (req: Request, res: Response) => {
    const files = (req.files as Express.Multer.File[] | undefined) || [];
    const cleanupUploads = (): void => {
      for (const f of files) {
        try { if (f.path) fs.unlinkSync(f.path); } catch { /* ignore */ }
      }
    };
    // Audit #5b：外层 catch 要用到这些状态，必须提在 try 外面——
    // try 块内声明的变量 catch 里看不到。
    let accountId = NaN;
    let claimed = false;
    let idemKey = '';
    let generatedIdemKey = false;
    // Audit #9 M7（选方案 a）：过期占位重认领后查不到已发送时置 true，
    // 成功响应里标 duplicateUnverified（见下）。
    let reclaimedUnverified = false;
    let effectiveMessageId: string | null = null;
    let smtpSucceeded = false;
    let sentMessageId: string | null = null;
    try {
      const db = getDb();
      const b = (req.body || {}) as Record<string, unknown>;
      accountId = Number(b.accountId);
      const account = db.prepare('SELECT * FROM accounts WHERE id=?').get(accountId) as
        | import('../db.js').AccountRow
        | undefined;
      if (!account) {
        res.status(404).json({ ok: false, error: '发件账号不存在' });
        return;
      }
      if (!account.enabled) {
        res.status(400).json({ ok: false, error: '发件账号已停用' });
        return;
      }
      const to = b.to as string | string[] | undefined;
      const toList = Array.isArray(to) ? to : String(to || '').split(',').map((s) => s.trim()).filter(Boolean);
      if (!toList.length) {
        res.status(400).json({ ok: false, error: '收件人必填' });
        return;
      }
      const ccList = Array.isArray(b.cc) ? (b.cc as string[]) : String(b.cc || '').split(',').map((s) => s.trim()).filter(Boolean);
      const bccList = Array.isArray(b.bcc) ? (b.bcc as string[]) : String(b.bcc || '').split(',').map((s) => s.trim()).filter(Boolean);
      // Audit #9 L10：收件人基本格式校验——"not-an-email" 以前能通过
      // 校验直至 SMTP 550 才报 502；非法地址现在前置 400。
      const invalidAddrs = [...toList, ...ccList, ...bccList].filter((a) => !isValidEmail(a));
      if (invalidAddrs.length) {
        res.status(400).json({ ok: false, error: `收件人地址格式无效：${invalidAddrs.slice(0, 5).join('、')}${invalidAddrs.length > 5 ? ' 等' : ''}` });
        return;
      }
      // B16: 收件人上限——to+cc+bcc 合计 50 人，前置校验（防一次发信被
      // 服务器按群发/滥用拒收，也防误操作群发）。
      if (toList.length + ccList.length + bccList.length > 50) {
        res.status(400).json({ ok: false, error: '收件人合计超过 50 人上限，请分批发送' });
        return;
      }
      // Audit #8 LOW-3：主题/正文不能全空——前端要求主题，但后端不拦
      // 等于信任客户端；subject、text、html 至少一项非空。
      const subjectRaw = typeof b.subject === 'string' ? b.subject.trim() : '';
      const textRaw = typeof b.text === 'string' ? b.text.trim() : '';
      const htmlRaw = typeof b.html === 'string' ? b.html.trim() : '';
      if (!subjectRaw && !textRaw && !htmlRaw) {
        res.status(400).json({ ok: false, error: '主题、正文不能全为空' });
        return;
      }
      // B14: 附件总大小上限 50MB（单文件 25MB 由本文件 :32 的 multer limits 限）。
      const totalBytes = files.reduce((s, f) => s + (f.size || 0), 0);
      if (totalBytes > MAX_TOTAL_ATTACHMENT_BYTES) {
        res.status(413).json({ ok: false, error: '附件总大小超过 50MB 上限' });
        return;
      }
      // Audit #5b：发信带 draftId 时校验草稿归属——草稿的 account_id
      // 必须与发信账号一致，不一致返回 400（发信前校验，绝不在发完
      // 后再报）；草稿不存在时忽略、不报错（与旧行为一致）。
      const draftIdEarly = Number((b as Record<string, unknown>).draftId);
      if (Number.isFinite(draftIdEarly) && draftIdEarly > 0) {
        const draftOwner = db.prepare('SELECT account_id FROM drafts WHERE id=?').get(draftIdEarly) as { account_id: number } | undefined;
        if (draftOwner && draftOwner.account_id !== accountId) {
          res.status(400).json({ ok: false, error: '草稿不属于该发件账号' });
          return;
        }
      }
      // Audit #9 L8 连带：duplicate 认领等提前 return 路径也要删掉本次
      // 发送认领到的那一行草稿（只删 draftId 这一行，绝不删用户仍在
      // 编辑的另一行草稿）；草稿不存在时忽略。
      const deleteClaimedDraft = (): void => {
        if (Number.isFinite(draftIdEarly) && draftIdEarly > 0) {
          try { db.prepare('DELETE FROM drafts WHERE id=?').run(draftIdEarly); } catch { /* ignore */ }
        }
      };
      // B12: 发信幂等键——前端每封新邮件生成一个 UUID 随请求传，同一封
      // 重试复用同一 key。占位冲突时：已发过直接返回原结果；进行中返回 409。
      const rawKey = b.idempotencyKey;
      idemKey = typeof rawKey === 'string' ? rawKey.trim() : '';
      if (idemKey.length > 128) {
        res.status(400).json({ ok: false, error: 'idempotencyKey 过长' });
        return;
      }
      // Audit #9 M2：前端核查——ComposeModal.vue 每次打开写信弹窗都生成
      // 一个 key（新开 newIdempotencyKey()、重开草稿复用草稿存的 key），
      // FormData 与 JSON 两路发信都必带 idempotencyKey；无 key 的只剩
      // 直调 API 的客户端。不要直接 400 打断现有前端：缺失时服务端
      // 生成一个 key 并随 201 响应返回（向后兼容），约定客户端保存它、
      // 重试时复用同一 key；无 key 的单次发送同样走完整流程
      // （planned_message_id + completeIfAlreadySent），不再现生成 Message-ID。
      if (!idemKey) {
        idemKey = crypto.randomUUID();
        generatedIdemKey = true;
      }
      {
        // Audit #5b：认领时预生成 Message-ID 并存进行（重认领沿用），
        // 本次发送全程用它，不再每次请求现生成。
        const claim = claimSendKey(accountId, idemKey, newPlannedMessageId());
        if (claim.status === 'duplicate') {
          deleteClaimedDraft();
          res.status(200).json({
            ok: true,
            id: claim.row.message_db_id,
            messageId: claim.row.message_id,
            duplicate: true,
          });
          return;
        }
        if (claim.status === 'in-progress') {
          res.status(409).json({ ok: false, error: '发送进行中，请勿重复提交' });
          return;
        }
        claimed = true;
        // Audit #5b：过期占位重认领——先查这封是不是已经发出去了
        // （SMTP 成功后、回填前崩溃的窗口）：先查本地已发送文件夹，
        // 本地没有再查服务器已发送文件夹；查到就直接返回原结果，不重发。
        if (claim.reclaimed && claim.plannedMessageId) {
          const already = await findAlreadySent(engine, accountId, claim.plannedMessageId);
          if (already) {
            try { completeSendKey(accountId, idemKey, already.localId, claim.plannedMessageId); } catch { /* ignore */ }
            deleteClaimedDraft();
            res.status(200).json({
              ok: true,
              id: already.localId,
              messageId: claim.plannedMessageId,
              duplicate: true,
            });
            return;
          }
          // Audit #9 M7（选方案 a：文档化 + 标注，不做延迟再查）：
          // 查不到不等于没发过——不自动保存已发送副本的服务商在已发送
          // 文件夹里永远查不到，且 engine.findSentByMessageId 默认只查
          // 最近 100 个 UID；本次若重发可能重复。继续发送，但在成功
          // 响应里标 duplicateUnverified:true，供客户端/用户核对已发送。
          reclaimedUnverified = true;
        }
        // 本次发送用的 Message-ID：新认领是刚生成的，重认领沿用旧行的。
        effectiveMessageId = claim.plannedMessageId;
      }
      const signature = (db.prepare("SELECT value FROM settings WHERE key='signature'").get() as { value: string } | undefined)?.value || '';
      let text = (b.text as string) || '';
      let html = (b.html as string) || '';
      if (signature) {
        if (text) text += `\n\n${signature}`;
        if (html) html += `<br><br>${signature.replace(/</g, '&lt;')}`;
      }
      // 磁盘临时文件：nodemailer 直接按 path 流式读盘，不再把附件全读进内存。
      const attachments = files.map((f) => ({
        filename: fixMultipartFilename(f.originalname),
        path: f.path,
        contentType: f.mimetype,
        size: f.size || 0,
      }));
      let password: string;
      try {
        password = decryptSecret(account.password_enc, masterKey);
      } catch {
        if (claimed) releaseSendKey(accountId, idemKey);
        res.status(500).json({ ok: false, error: '账号凭据解密失败' });
        return;
      }
      const mailInput = {
        to: toList, cc: ccList, bcc: bccList,
        subject: (b.subject as string) || '', text, html, attachments,
        // 回复 threading 头（审计 #2 缺口，后端半边）：前端回复时传原信
        // 的 Message-ID（inReplyTo）与 References 链；不传则不带头。
        inReplyTo: b.inReplyTo as string | undefined,
        references: b.references as string | string[] | undefined,
      };
      // Audit #7 LOW-2：释放占位前先按本次 planned Message-ID 查一次
      // 已发送——SMTP 已接受、响应丢失时，查到了就按已发送完成认领
      // （返回 duplicate，不让用户以为失败而重发）；查不到再释放，
      // 真失败仍可快速重试。复用 findAlreadySent（本地+服务器两路）。
      // 注意：只有对方自动保存已发送副本的服务商（163/QQ）才能查到；
      // 不自动保存的服务商查不到，仍会释放后重发。Audit #9 M7 选方案 a：
      // 该残留窗口已文档化（见重认领处的 reclaimedUnverified 注释），
      // 重认领查不到时成功响应标 duplicateUnverified:true，不做延迟再查。
      const completeIfAlreadySent = async (): Promise<{ localId: number | null } | null> => {
        if (!claimed || !effectiveMessageId) return null;
        const already = await findAlreadySent(engine, accountId, effectiveMessageId);
        if (!already) return null;
        try { completeSendKey(accountId, idemKey, already.localId, effectiveMessageId); } catch { /* ignore */ }
        return already;
      };
      const failSend = async (e: unknown): Promise<void> => {
        const already = await completeIfAlreadySent();
        if (already) {
          deleteClaimedDraft();
          res.status(200).json({ ok: true, id: already.localId, messageId: effectiveMessageId, duplicate: true });
          return;
        }
        if (claimed) releaseSendKey(accountId, idemKey);
        const code = smtpResponseCode(e);
        const detail = String((e as Error)?.message || e).slice(0, 400);
        // L1: 535（认证失败）先判——旧版先按 5xx 归类，报的是
        // “收件人/内容问题”，用户会去改收件人，实际是密码/授权码错了。
        const error = isAuthError(e)
          ? 'SMTP 认证失败，请检查发件账号的密码/授权码'
          : code === 451
            ? '对方服务器暂时拒收（灰名单），请 5 分钟后再发'
            : isPermanentSmtpError(e)
            ? `发信失败：对方服务器拒绝了这封邮件（${code}），请检查收件人地址或内容后重试`
            : `发信失败：${detail}`;
        res.status(502).json({ ok: false, error });
      };
      let sent: { messageId: string | null; raw: Buffer; rejected: string[] };
      // F4: raw / Message-ID 只编译一次，重试复用同一份——重调 sendMail
      // 会重新 new MailComposer、生成新的 Message-ID，APPEND 的副本就
      // 与实际发出的邮件对不上号。编译失败时 prebuilt 仍为 undefined，
      // 但编译错误不是 SMTP 4xx，不会进重试分支，直接按原路径失败。
      let prebuilt: { raw: Buffer; messageId: string | null } | undefined;
      try {
        // Audit #5b：用认领时预生成的 Message-ID 编译（重认领沿用旧
        // 行的值）；没有幂等键时不传，MailComposer 照旧现生成。
        prebuilt = await buildRawMail(account, mailInput, effectiveMessageId ?? undefined);
        sent = await sendMail(account, password, mailInput, prebuilt);
        smtpSucceeded = true;
        sentMessageId = sent.messageId;
      } catch (e) {
        // B15: 4xx（对方繁忙等）5 秒后最多重试 1 次。451 灰名单例外：
        // 灰名单希望几分钟后重试，请求内等 5 分钟会先触发前端 30 秒超时——
        // 用户看到失败、信却可能稍后发出；所以 451 不重试、直接失败，
        // 让用户 5 分钟后手动重发（见 failSend 的 451 文案，幂等键防重发）。
        if (isTransientSmtpError(e) && smtpResponseCode(e) !== 451) {
          log('send smtp 4xx, retry once after 5s', accountId, smtpResponseCode(e));
          await new Promise((r) => setTimeout(r, 5 * 1000));
          try {
            sent = await sendMail(account, password, mailInput, prebuilt);
            smtpSucceeded = true;
            sentMessageId = sent.messageId;
          } catch (e2) {
            // 与 failSend 同理：重试也可能在对方已接受后断连，先查已发送
            // 再释放（见 completeIfAlreadySent）。
            const already = await completeIfAlreadySent();
            if (already) {
              deleteClaimedDraft();
              res.status(200).json({ ok: true, id: already.localId, messageId: effectiveMessageId, duplicate: true });
              return;
            }
            if (claimed) releaseSendKey(accountId, idemKey);
            res.status(502).json({ ok: false, error: `发信失败：对方服务器临时拒绝（${smtpResponseCode(e2) ?? '4xx'}），请稍后重试` });
            return;
          }
        } else {
          await failSend(e);
          return;
        }
      }
      // 草稿：发信成功后删除该草稿行（无论之后 APPEND/缓存是否 warning）；
      // 发信失败时保留。draftId 不存在时忽略、不报错。
      const draftId = Number((b as Record<string, unknown>).draftId);
      if (Number.isFinite(draftId) && draftId > 0) {
        db.prepare('DELETE FROM drafts WHERE id=?').run(draftId);
      }
      // APPEND a copy to Sent and cache it locally (bodies on disk, FTS indexed).
      // 邮件已发出：之后任何一步失败都只记 warning，仍返回 201，不让用户以为
      // “发送失败”而重发。
      const warnings: string[] = [];
      const sentFolder = await engine.appendToSent(accountId, sent.raw, sent.messageId);
      let localId: number | null = null;
      if (!sentFolder) {
        warnings.push('未找到已发送文件夹，邮件已发出但未存入已发送');
      } else if (!sentFolder.ok) {
        warnings.push('邮件已发出，但未能存入已发送');
      } else if (sentFolder.uid) {
        const folder = db.prepare('SELECT * FROM folders WHERE id=?').get(sentFolder.id) as { id: number } | undefined;
        if (!folder) {
          warnings.push('邮件已发出，但未能存入已发送');
        } else {
          const uid = sentFolder.uid;
          try {
            const existing = db.prepare('SELECT id FROM messages WHERE account_id=? AND folder_id=? AND uid=?').get(accountId, folder.id, uid) as { id: number } | undefined;
            if (existing) {
              localId = existing.id;
            } else if (sent.messageId) {
              // F1: 发信缓存也按同文件夹内 Message-ID 去重——APPEND 与
              // 缓存入库之间若有一次同步先跑完，服务器自动保存的那份
              // （同一 Message-ID、不同 UID）已被同步插进来，再按 UID
              // 插缓存行就会造出第二行。已有同 Message-ID 的行时直接
              // 用它（localId 指向那行，前端据此打开）。
              const dup = db.prepare('SELECT id FROM messages WHERE account_id=? AND folder_id=? AND message_id=? LIMIT 1').get(accountId, folder.id, sent.messageId) as { id: number } | undefined;
              if (dup) localId = dup.id;
            }
            if (localId == null) {
              const info = db.prepare(
                `INSERT INTO messages (account_id, folder_id, uid, message_id, subject, from_addr,
                  from_name, to_json, cc_json, date, snippet, body_path, is_read,
                  has_attachments, size, flags_json)
                 VALUES (?,?,?,?,?,?,?,?,?,?,?,?,1,?,?,?)`,
              ).run(
                accountId, folder.id, uid, sent.messageId, (b.subject as string) || '', account.email,
                account.display_name || '', JSON.stringify(toList),
                JSON.stringify(ccList),
                new Date().toISOString(),
                String(text || '').replace(/\s+/g, ' ').trim().slice(0, 200),
                null, // body_path: fixed below once we know the id
                attachments.length ? 1 : 0, sent.raw.length, JSON.stringify(['\\Seen']),
              );
              localId = Number(info.lastInsertRowid);
              const bodyPath = `bodies/${localId}.html`;
              fs.writeFileSync(bodyHtmlPath(localId), html || '');
              fs.writeFileSync(bodyTextPath(localId), text || '');
              db.prepare('UPDATE messages SET body_path=? WHERE id=?').run(bodyPath, localId);
              indexMessageFts(localId, (b.subject as string) || '', account.email, text || '');
              // 已发附件只记元信息、不落盘（附件本体在邮件服务器的已发送文件夹里）。
              // 下载时凭 part 号从 IMAP 实时取：part 号是 appendToSent 在同一次
              // IMAP 会话里取回的（B11），按顺序（索引）匹配；取不到记 NULL。
              const sentParts = sentFolder.parts || [];
              for (let i = 0; i < attachments.length; i++) {
                const f = attachments[i];
                // 按顺序匹配：同名附件用文件名匹配会串到同一个 part。
                const m = sentParts[i] || null;
                db.prepare('INSERT INTO attachments (message_id, filename, content_type, size, path, cached, part) VALUES (?,?,?,?,?,?,?)')
                  .run(localId, f.filename, f.contentType || 'application/octet-stream', f.size, null, 0, m?.part || null);
              }
              // L9: part 没取到的附件不再静默记 NULL——用户发完才发现
              // 下载不了；直接在 warning 里告诉他是哪几个附件。
              const noPartNames = attachments
                .filter((_f, i) => !(sentParts[i]?.part))
                .map((f) => f.filename);
              if (noPartNames.length) {
                warnings.push(`附件 ${noPartNames.join('、')} 未能记录服务器位置，下载可能失败`);
              }
            }
            refreshFolderCounts(folder.id);
          } catch (e) {
            log('send local cache failed', accountId, (e as Error)?.message || e);
            warnings.push('邮件已发出，但本地已发送记录保存失败');
            localId = null;
          }
        }
      }
      // （uid 为 null 且 ok=true：APPEND 成功、服务器没返回 UID、按 Message-ID
      // 反查也没找到——不入库，下次同步会从已发送文件夹取回来；不报 warning，
      // 邮件确实已存入已发送。）
      // B12: 成功后回填幂等记录（localId 可能为 null——uid 未取回时本地无行，
      // 但 message_id 已有，重复 key 仍可凭 message_id 返回原结果）。
      if (claimed) {
        try {
          completeSendKey(accountId, idemKey, localId, sent.messageId);
        } catch (e) {
          log('send idempotency complete failed', accountId, (e as Error)?.message || e);
        }
      }
      res.status(201).json({
        ok: true,
        id: localId,
        messageId: sent.messageId,
        // Audit #9 M2：服务端生成的 key 随响应返回，客户端重试时复用它。
        ...(generatedIdemKey ? { idempotencyKey: idemKey } : {}),
        // Audit #9 M7（方案 a）：重认领后查不到已发送、仍重发的成功响应。
        ...(reclaimedUnverified ? { duplicateUnverified: true } : {}),
        ...(sent.rejected.length ? { rejected: sent.rejected } : {}),
        ...(warnings.length ? { warning: warnings.join('；') } : {}),
      });
    } catch (e) {
      // Audit #5b：发信路由此前只有 try/finally、没有 catch——try 内
      // 未被 5 处局部 catch 覆盖的异常（如草稿 DELETE、settings 查询
      // 等 DB I/O 错误）会逃逸成未处理 rejection，Node 默认崩溃进程，
      // systemd 重启后幂等占位仍卡“进行中”直至 10 分钟过期。
      // 这里兜底：记日志、返回 500 JSON、不让异常逃逸；占位按 SMTP
      // 是否已成功处理——已成功则回填完成（不再重发），未成功则释放
      // 占位让重试能继续。
      log('send unexpected error', accountId, (e as Error)?.message || e);
      if (claimed) {
        if (smtpSucceeded) {
          try { completeSendKey(accountId, idemKey, null, sentMessageId); } catch { /* ignore */ }
        } else {
          releaseSendKey(accountId, idemKey);
        }
      }
      if (!res.headersSent) res.status(500).json({ ok: false, error: '服务器内部错误，请重试' });
    } finally {
      cleanupUploads();
    }
  });

  return r;
}
