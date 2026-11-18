// 草稿接口（审计 #5 后用户定夺，后端草稿）：草稿只存 drafts 表，
// 不进 FTS、不进 messages 表、不参与同步；删账号时级联删除。
// 契约（与前端约定）：
//   GET    /api/drafts           -> {ok, drafts:[{id, accountId, to, subject, text, idempotencyKey, updatedAt}]}（updatedAt 倒序）
//   POST   /api/drafts           body {accountId, to, subject, text, idempotencyKey?}
//                                idempotencyKey 缺失时服务端生成；accountId 不存在 -> 400
//   PUT    /api/drafts/:id       body {to?, subject?, text?, accountId?}；idempotencyKey 永不变更；不存在 -> 404
//   DELETE /api/drafts/:id       不存在 -> 404
// 发信成功后由 /api/messages/send 按 draftId 删草稿行（见 messageRoutes）。
import express from 'express';
import type { Request, Response } from 'express';
import crypto from 'node:crypto';
import { getDb } from '../db.js';

export interface DraftRow {
  id: number;
  account_id: number;
  to_addrs: string;
  subject: string;
  text: string;
  idempotency_key: string | null;
  created_at: string;
  updated_at: string;
}

function publicDraft(row: DraftRow): Record<string, unknown> {
  return {
    id: row.id,
    accountId: row.account_id,
    to: row.to_addrs,
    subject: row.subject,
    text: row.text,
    idempotencyKey: row.idempotency_key,
    updatedAt: row.updated_at,
  };
}

export function draftRoutes(): express.Router {
  const r = express.Router();

  r.get('/drafts', (_req: Request, res: Response) => {
    const db = getDb();
    const rows = db.prepare(
      'SELECT * FROM drafts ORDER BY updated_at DESC, id DESC',
    ).all() as DraftRow[];
    res.json({ ok: true, drafts: rows.map(publicDraft) });
  });

  r.post('/drafts', (req: Request, res: Response) => {
    const db = getDb();
    const b = (req.body || {}) as Record<string, unknown>;
    const accountId = Number(b.accountId);
    if (!Number.isFinite(accountId) || accountId <= 0
      || !db.prepare('SELECT id FROM accounts WHERE id=?').get(accountId)) {
      return res.status(400).json({ ok: false, error: '发件账号不存在' });
    }
    const key = typeof b.idempotencyKey === 'string' && b.idempotencyKey.trim()
      ? b.idempotencyKey.trim()
      : crypto.randomUUID();
    const info = db.prepare(
      `INSERT INTO drafts (account_id, to_addrs, subject, text, idempotency_key)
       VALUES (?,?,?,?,?)`,
    ).run(
      accountId,
      typeof b.to === 'string' ? b.to : '',
      typeof b.subject === 'string' ? b.subject : '',
      typeof b.text === 'string' ? b.text : '',
      key,
    );
    const row = db.prepare('SELECT * FROM drafts WHERE id=?').get(Number(info.lastInsertRowid)) as DraftRow;
    return res.status(201).json({ ok: true, draft: publicDraft(row) });
  });

  r.put('/drafts/:id', (req: Request, res: Response) => {
    const db = getDb();
    const id = Number(req.params.id);
    const row = db.prepare('SELECT * FROM drafts WHERE id=?').get(id) as DraftRow | undefined;
    if (!row) return res.status(404).json({ ok: false, error: '草稿不存在' });
    const b = (req.body || {}) as Record<string, unknown>;
    let accountId = row.account_id;
    if (b.accountId !== undefined) {
      const next = Number(b.accountId);
      if (!Number.isFinite(next) || next <= 0
        || !db.prepare('SELECT id FROM accounts WHERE id=?').get(next)) {
        return res.status(400).json({ ok: false, error: '发件账号不存在' });
      }
      accountId = next;
    }
    // idempotencyKey 永不变更（即使 body 里传了也忽略）——草稿重开
    // 发信时复用同一 key，防重复发信。
    db.prepare(
      `UPDATE drafts SET account_id=?, to_addrs=?, subject=?, text=?,
       updated_at=datetime('now') WHERE id=?`,
    ).run(
      accountId,
      typeof b.to === 'string' ? b.to : row.to_addrs,
      typeof b.subject === 'string' ? b.subject : row.subject,
      typeof b.text === 'string' ? b.text : row.text,
      id,
    );
    const updated = db.prepare('SELECT * FROM drafts WHERE id=?').get(id) as DraftRow;
    return res.json({ ok: true, draft: publicDraft(updated) });
  });

  r.delete('/drafts/:id', (req: Request, res: Response) => {
    const db = getDb();
    const id = Number(req.params.id);
    const row = db.prepare('SELECT id FROM drafts WHERE id=?').get(id) as { id: number } | undefined;
    if (!row) return res.status(404).json({ ok: false, error: '草稿不存在' });
    db.prepare('DELETE FROM drafts WHERE id=?').run(id);
    return res.json({ ok: true });
  });

  return r;
}
