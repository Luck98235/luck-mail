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
import { sendMail, buildRawMail } from '../smtpUtil.js';
import { smtpResponseCode, isTransientSmtpError, isPermanentSmtpError } from '../imapUtil.js';
import { claimSendKey, completeSendKey, releaseSendKey } from '../idempotency.js';
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
  // 兜底上限：只留最近 20 个任务。
  if (deleteTasks.size > 20) {
    const ids = [...deleteTasks.keys()];
    for (const id of ids.slice(0, deleteTasks.size - 20)) deleteTasks.delete(id);
  }
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
    const ids = searchMessageIds(String(q));
    if (!ids || ids.length === 0) {
      res.json({ ok: true, messages: [], total: 0 });
      return;
    }
    const total = ids.length;
    const pageIds = ids.slice(off, off + lim);
    if (!pageIds.length) {
      res.json({ ok: true, messages: [], total });
      return;
    }
    const placeholders = pageIds.map(() => '?').join(',');
    const rows = db.prepare(
      `${messageRowQuery()} WHERE m.id IN (${placeholders})`,
    ).all(...(pageIds as never[])) as MessageRow[];
    const order = new Map(pageIds.map((id, i) => [id, i]));
    rows.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
    res.json({ ok: true, messages: rows.map((row) => envelopeOf(row, row.account_email || '')), total });
    return;
  }
  const whereSql = where ? `WHERE ${where}` : '';
  const total = (db.prepare(`SELECT COUNT(*) c FROM messages m ${whereSql}`).get(...(params as never[])) as { c: number }).c;
  const rows = db.prepare(
    `${messageRowQuery()} ${whereSql} ORDER BY m.date DESC, m.id DESC LIMIT ? OFFSET ?`,
  ).all(...(params as never[]), lim, off) as MessageRow[];
  res.json({ ok: true, messages: rows.map((row) => envelopeOf(row, row.account_email || '')), total });
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

  r.get('/messages/:id', async (req: Request, res: Response) => {
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
    // Open marks as read (contract). IMAP failure must not break the open:
    // fall back to a local-only mark.
    if (!row.is_read) {
      try {
        await engine.setRead(row.account_id, id, true);
      } catch (e) {
        log('mark-read on open failed', id, (e as Error)?.message || e);
        db.prepare('UPDATE messages SET is_read=1 WHERE id=?').run(id);
        if (row.folder_id) refreshFolderCounts(row.folder_id);
        emit('mail-updated', { messageId: id, accountId: row.account_id, folderId: row.folder_id, changes: { isRead: true } });
      }
    }
    const fresh = db.prepare(`${messageRowQuery()} WHERE m.id=?`).get(id) as MessageRow;
    // Bodies live on disk (contract): read the sanitized HTML + plain text.
    const { bodyText, bodyHtml } = readBodyFiles(id);
    res.json({
      ok: true,
      message: {
        ...envelopeOf(fresh, fresh.account_email || ''),
        cc: JSON.parse(fresh.cc_json || '[]') as string[],
        bodyText,
        bodyHtml,
        attachments,
      },
    });
  });

  r.post('/messages/:id/read', async (req: Request, res: Response) => {
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
      res.status(502).json({ ok: false, error: `IMAP 标记失败：${String((e as Error)?.message || e).slice(0, 300)}` });
      return;
    }
    res.json({ ok: true });
  });

  r.post('/messages/:id/move', async (req: Request, res: Response) => {
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
  });

  r.delete('/messages/:id', async (req: Request, res: Response) => {
    const db = getDb();
    const id = Number(req.params.id);
    const row = db.prepare('SELECT * FROM messages WHERE id=?').get(id) as MessageRow | undefined;
    if (!row) {
      res.status(404).json({ ok: false, error: '邮件不存在' });
      return;
    }
    // 是否永久删除由后端按邮件实际所在文件夹决定（只看 folder.type），
    // 不再信任客户端传的 permanent（搜索是全局的，视图判断会错删）。
    try {
      await engine.deleteMessage(row.account_id, id);
    } catch (e) {
      // B19: 删除失败可观测性——记下账号、消息 id 与错误，否则 502 只在
      // 前端闪一下，服务端日志里查不到是哪封、哪个账号失败。
      log('delete failed', `account=${row.account_id} message=${id}`, (e as Error)?.message || e);
      res.status(502).json({ ok: false, error: `IMAP 删除失败：${String((e as Error)?.message || e).slice(0, 300)}` });
      return;
    }
    res.json({ ok: true });
  });

  // 批量删除：一次删多封（移到已删除；已在已删除里的彻底删除）。
  // B13: 不再队头阻塞——立即返回 {ok, taskId, status:'running'}，删除在
  // 后台逐封跑（与单封删除同一语义）；进度与最终结果走
  // GET /api/messages/delete-status?taskId=… 轮询。任务按 taskId 隔离，
  // 多个批量删除互不覆盖。
  r.post('/messages/batch-delete', (req: Request, res: Response) => {
    const raw = Array.isArray(req.body?.ids) ? req.body.ids : [];
    const ids = raw.map((x: unknown) => Number(x)).filter((n: number) => Number.isFinite(n) && n > 0);
    if (!ids.length) {
      res.status(400).json({ ok: false, error: 'ids 不能为空' });
      return;
    }
    if (ids.length > 200) {
      res.status(400).json({ ok: false, error: '一次最多删除 200 封' });
      return;
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
    const task: DeleteTask = {
      taskId: crypto.randomUUID(),
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
    void (async () => {
      const db = getDb();
      for (const id of ids) {
        const row = db.prepare('SELECT * FROM messages WHERE id=?').get(id) as MessageRow | undefined;
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
    })();
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
  // DeepL 密钥只放服务器 systemd 环境变量 DEEPL_API_KEY，不进仓库/聊天/记忆。
  // DeepL 无百度式敏感词过滤，白宫类邮件也能翻；且实测从国内服务器可直连
  // api-free.deepl.com。免费 Key（:fx 结尾）走 api-free，付费 Key 走 api。
  // 外贸站密钥为 100 万字符免费额度，有效期至 2027-11-01；邮件翻译量小够用。
  async function translateWithDeepL(text: string): Promise<string> {
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
    if (!resp.ok) throw new Error(`DeepL 返回 ${resp.status}`);
    const data = await resp.json() as { message?: string; translations?: { text?: string }[] };
    if ((data as { message?: string }).message) throw new Error(`DeepL 错误：${(data as { message?: string }).message}`);
    const t = data?.translations?.[0]?.text;
    if (typeof t !== 'string' || !t.trim()) throw new Error('DeepL 翻译无返回');
    return t;
  }

  r.post('/messages/:id/translate', async (req: Request, res: Response) => {
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
    try {
      const paras = splitForTranslate(text);
      const outParas: string[] = [];
      // DeepL 不限流，无需段间延迟（1.1 秒延迟是为百度 QPS=1 加的，DeepL 为主后已去掉）。
      for (const chunks of paras) {
        const parts: string[] = [];
        for (const c of chunks) parts.push(await translateWithDeepL(c));
        outParas.push(parts.join(' '));
      }
      res.json({ ok: true, translated: outParas.join('\n\n'), alreadyChinese: false });
    } catch (e) {
      log('translate failed', id, (e as Error)?.message || e);
      res.status(502).json({ ok: false, error: '翻译服务暂时不可用，请稍后重试' });
    }
  });

  // 附件下载：附件是元数据-only（不落盘），一律从 IMAP 按 part 号实时流式取回。
  // B18: 磁盘缓存分支已删——生产库查证：attachments 表 0 行、cached=1 的行
  // 0 行（mailStream 从不写 cached 文件，旧分支永远走不到）；磁盘上残留
  // 的 20 个孤儿文件无任何行引用，删分支不影响任何可下载附件。
  r.get('/messages/:id/attachments/:attId', async (req: Request, res: Response) => {
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
      if (att.size) res.setHeader('Content-Length', String(att.size));
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
  });

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
    try {
      const db = getDb();
      const b = (req.body || {}) as Record<string, unknown>;
      const accountId = Number(b.accountId);
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
      // B16: 收件人上限——to+cc+bcc 合计 50 人，前置校验（防一次发信被
      // 服务器按群发/滥用拒收，也防误操作群发）。
      if (toList.length + ccList.length + bccList.length > 50) {
        res.status(400).json({ ok: false, error: '收件人合计超过 50 人上限，请分批发送' });
        return;
      }
      // B14: 附件总大小上限 50MB（单文件 25MB 由 multer 限，见 server.ts）。
      const totalBytes = files.reduce((s, f) => s + (f.size || 0), 0);
      if (totalBytes > MAX_TOTAL_ATTACHMENT_BYTES) {
        res.status(413).json({ ok: false, error: '附件总大小超过 50MB 上限' });
        return;
      }
      // B12: 发信幂等键——前端每封新邮件生成一个 UUID 随请求传，同一封
      // 重试复用同一 key。占位冲突时：已发过直接返回原结果；进行中返回 409。
      const rawKey = b.idempotencyKey;
      const idemKey = typeof rawKey === 'string' ? rawKey.trim() : '';
      if (typeof rawKey === 'string' && rawKey.trim() && idemKey.length > 128) {
        res.status(400).json({ ok: false, error: 'idempotencyKey 过长' });
        return;
      }
      let claimed = false;
      if (idemKey) {
        const claim = claimSendKey(accountId, idemKey);
        if (claim.status === 'duplicate') {
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
      };
      const failSend = (e: unknown): void => {
        if (claimed) releaseSendKey(accountId, idemKey);
        const code = smtpResponseCode(e);
        const detail = String((e as Error)?.message || e).slice(0, 400);
        // B15: 5xx 直接失败并给可读文案；无响应码的错误走通用 502。
        const error = isPermanentSmtpError(e)
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
        prebuilt = await buildRawMail(account, mailInput);
        sent = await sendMail(account, password, mailInput, prebuilt);
      } catch (e) {
        // B15: 4xx（灰名单/限流/对方繁忙）最多重试 1 次（约 5 秒后）；
        // 重试仍失败按 4xx 文案返回。5xx 与其他错误直接失败。
        if (isTransientSmtpError(e)) {
          log('send smtp 4xx, retry once after 5s', accountId, smtpResponseCode(e));
          await new Promise((r) => setTimeout(r, 5000));
          try {
            sent = await sendMail(account, password, mailInput, prebuilt);
          } catch (e2) {
            if (claimed) releaseSendKey(accountId, idemKey);
            res.status(502).json({ ok: false, error: `发信失败：对方服务器临时拒绝（${smtpResponseCode(e2) ?? '4xx'}），请稍后重试` });
            return;
          }
        } else {
          failSend(e);
          return;
        }
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
        ...(sent.rejected.length ? { rejected: sent.rejected } : {}),
        ...(warnings.length ? { warning: warnings.join('；') } : {}),
      });
    } finally {
      cleanupUploads();
    }
  });

  return r;
}
