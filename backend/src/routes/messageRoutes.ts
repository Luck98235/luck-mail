import express from 'express';
import type { Request, Response } from 'express';
import multer from 'multer';
import fs from 'node:fs';
import path from 'node:path';
import {
  getDb, searchMessageIds, refreshFolderCounts, indexMessageFts,
  readBodyFiles, bodyHtmlPath, bodyTextPath,
} from '../db.js';
import type { MessageRow, AttachmentRow } from '../db.js';
import { envelopeOf } from '../engine.js';
import { sendMail } from '../smtpUtil.js';
import { decryptSecret } from '../cryptoUtil.js';
import { emit } from '../hub.js';
import { ATTACHMENTS_DIR, log } from '../config.js';
import type { Ctx } from './accountRoutes.js';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024, files: 10 },
});

// 批量删除任务状态（单进程内存）：前端刷新/切页回来后，靠它继续显示“删除中…”。
// 删完（或出错）后 running=false；重启后任务丢失，等同于未在删除。
// view 记下发起删除的视图（{kind, accountId, folderId}）：刷新后前端靠 delete-status
// 拿回它，删除中提示只显示在发起删除的那个视图（所有已删除/所有未读/所有草稿等聚合视图通用）。
const deleteTask: {
  running: boolean; total: number; deleted: number; startedAt: number;
  view: { kind: string; accountId: number | null; folderId: number | null } | null;
} = { running: false, total: 0, deleted: 0, startedAt: 0, view: null };

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
    const ids = searchMessageIds(String(q), where || '', params);
    if (!ids || ids.length === 0) {
      res.json({ ok: true, messages: [], total: 0 });
      return;
    }
    const placeholders = ids.map(() => '?').join(',');
    where = `m.id IN (${placeholders})`;
    params = ids;
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
  r.get('/messages/delete-status', (_req: Request, res: Response) => {
    res.json({ ok: true, ...deleteTask });
  });

  r.get('/search', (req: Request, res: Response) => {
    if (!req.query.q || !String(req.query.q).trim()) {
      res.json({ ok: true, messages: [], total: 0 });
      return;
    }
    listMessages(req, res);
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
    const permanent = req.query.permanent === 'true';
    try {
      await engine.deleteMessage(row.account_id, id, permanent);
    } catch (e) {
      res.status(502).json({ ok: false, error: `IMAP 删除失败：${String((e as Error)?.message || e).slice(0, 300)}` });
      return;
    }
    res.json({ ok: true });
  });

  // 批量删除：一次删多封（移到已删除；permanent=true 时彻底删除）。
  // 逐封走 engine.deleteMessage（与单封删除同一语义），返回成功/失败明细。
  r.post('/messages/batch-delete', async (req: Request, res: Response) => {
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
    const permanent = req.body?.permanent === true;
    const db = getDb();
    const deleted: number[] = [];
    const failed: Array<{ id: number; error: string }> = [];
    deleteTask.running = true;
    deleteTask.total = ids.length;
    deleteTask.deleted = 0;
    deleteTask.startedAt = Date.now();
    // 记下发起删除的视图，供刷新后 delete-status 返回（前端据此只在该视图显示删除中）。
    const v = req.body?.view as { kind?: unknown; accountId?: unknown; folderId?: unknown } | undefined;
    deleteTask.view = (v && typeof v.kind === 'string')
      ? {
        kind: v.kind,
        accountId: typeof v.accountId === 'number' ? v.accountId : null,
        folderId: typeof v.folderId === 'number' ? v.folderId : null,
      }
      : null;
    try {
      for (const id of ids) {
        const row = db.prepare('SELECT * FROM messages WHERE id=?').get(id) as MessageRow | undefined;
        if (!row) { failed.push({ id, error: '邮件不存在' }); continue; }
        try {
          await engine.deleteMessage(row.account_id, id, permanent);
          deleted.push(id);
          deleteTask.deleted = deleted.length;
        } catch (e) {
          failed.push({ id, error: String((e as Error)?.message || e).slice(0, 200) });
        }
      }
    } finally {
      deleteTask.running = false;
      deleteTask.view = null;
    }
    res.json({ ok: true, deleted, failed });
  });

  // ---- 正文翻译：英文 → 中文（免费 MyMemory 接口，无需密钥；服务器在国内，Google 翻译端点不通）----
  // 前端点阅读窗右上角“翻译”后调它；返回译文纯文本，前端在 iframe 里以译文/原文切换显示。
  // MyMemory 单次 q 最长约 500 字节：先按段落、再按句子切成 <=450 字节的小段，逐段翻译再拼接。
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

  async function translateOne(text: string): Promise<string> {
    const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=en|zh-CN`;
    const resp = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!resp.ok) throw new Error(`翻译服务返回 ${resp.status}`);
    const data = await resp.json() as { responseData?: { translatedText?: string } };
    const t = data?.responseData?.translatedText;
    if (typeof t !== 'string' || !t.trim()) throw new Error('翻译服务无返回');
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
      for (const chunks of paras) {
        const parts: string[] = [];
        for (const c of chunks) parts.push(await translateOne(c));
        outParas.push(parts.join(' '));
      }
      res.json({ ok: true, translated: outParas.join('\n\n'), alreadyChinese: false });
    } catch (e) {
      log('translate failed', id, (e as Error)?.message || e);
      res.status(502).json({ ok: false, error: '翻译服务暂时不可用，请稍后重试' });
    }
  });

  // Dual path (10 MB rule):
  //  - cached (<=10 MB): stream the file from disk;
  //  - uncached (>10 MB): stream live from IMAP, never touching disk.
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
    if (att.cached && att.path) {
      const filePath = path.join(ATTACHMENTS_DIR, att.path);
      if (fs.existsSync(filePath)) {
        sendHeaders();
        fs.createReadStream(filePath).pipe(res);
        return;
      }
      // Cached file lost on disk: fall through to live fetch if possible.
      if (!att.part) {
        res.status(404).json({ ok: false, error: '附件文件已丢失' });
        return;
      }
    }
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
  r.post('/messages/send', upload.any(), async (req: Request, res: Response) => {
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
    const signature = (db.prepare("SELECT value FROM settings WHERE key='signature'").get() as { value: string } | undefined)?.value || '';
    let text = (b.text as string) || '';
    let html = (b.html as string) || '';
    if (signature) {
      if (text) text += `\n\n${signature}`;
      if (html) html += `<br><br>${signature.replace(/</g, '&lt;')}`;
    }
    const files = (req.files as Express.Multer.File[] | undefined) || [];
    const attachments = files.map((f) => ({
      filename: fixMultipartFilename(f.originalname),
      content: f.buffer,
      contentType: f.mimetype,
    }));
    let password: string;
    try {
      password = decryptSecret(account.password_enc, masterKey);
    } catch {
      res.status(500).json({ ok: false, error: '账号凭据解密失败' });
      return;
    }
    let sent: { messageId: string | null; raw: Buffer };
    try {
      sent = await sendMail(account, password, {
        to: toList, cc: b.cc as string | string[] | undefined, bcc: b.bcc as string | string[] | undefined,
        subject: (b.subject as string) || '', text, html, attachments,
      });
    } catch (e) {
      res.status(502).json({ ok: false, error: `发信失败：${String((e as Error)?.message || e).slice(0, 400)}` });
      return;
    }
    // APPEND a copy to Sent and cache it locally (bodies on disk, FTS indexed).
    const sentFolder = await engine.appendToSent(accountId, sent.raw);
    let localId: number | null = null;
    if (sentFolder && sentFolder.uid) {
      const folder = db.prepare('SELECT * FROM folders WHERE id=?').get(sentFolder.id) as { id: number } | undefined;
      if (!folder) {
        res.status(201).json({ ok: true, id: null, messageId: sent.messageId });
        return;
      }
      const uid = sentFolder.uid;
      const existing = db.prepare('SELECT id FROM messages WHERE account_id=? AND folder_id=? AND uid=?').get(accountId, folder.id, uid) as { id: number } | undefined;
      if (existing) {
        localId = existing.id;
      } else {
        const ccList = Array.isArray(b.cc) ? (b.cc as string[]) : String(b.cc || '').split(',').map((s) => s.trim()).filter(Boolean);
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
        // 下载时凭 part 号从 IMAP 实时取：先取刚 APPEND 进已发送的那封信的
        // BODYSTRUCTURE，按文件名匹配 part 号；取不到就记 NULL（下载时再报错）。
        let sentParts: { filename: string | null; part: string | null }[] = [];
        if (sentFolder && sentFolder.uid) {
          try {
            sentParts = await engine.getAttachmentParts(accountId, sentFolder.path, sentFolder.uid);
          } catch { /* 取不到 part 就记 NULL */ }
        }
        for (const f of attachments) {
          const size = f.content.length;
          const m = sentParts.find((p) => p.filename && f.filename && p.filename === f.filename) || null;
          db.prepare('INSERT INTO attachments (message_id, filename, content_type, size, path, cached, part) VALUES (?,?,?,?,?,?,?)')
            .run(localId, f.filename, f.contentType || 'application/octet-stream', size, null, 0, m?.part || null);
        }
      }
      refreshFolderCounts(folder.id);
    }
    res.status(201).json({ ok: true, id: localId, messageId: sent.messageId });
  });

  return r;
}
