import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { BODIES_DIR, DB_FILE, log } from './config.js';

export interface UserRow {
  id: number;
  username: string;
  password_hash: string;
  salt: string;
  failed_attempts: number;
  locked_until: string | null;
  created_at: string;
}

export interface AccountRow {
  id: number;
  email: string;
  display_name: string;
  password_enc: string;
  imap_host: string;
  imap_port: number;
  imap_secure: string;
  smtp_host: string;
  smtp_port: number;
  smtp_secure: string;
  enabled: number;
  sort_order: number;
  status: string;
  last_sync_at: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

export interface FolderRow {
  id: number;
  account_id: number;
  path: string;
  name: string;
  type: string;
  uidvalidity: number | null;
  uidnext: number | null;
  modseq: number | null;
  unread_count: number;
  total_count: number;
}

export interface MessageRow {
  id: number;
  account_id: number;
  folder_id: number | null;
  uid: number;
  message_id: string | null;
  subject: string;
  from_addr: string;
  from_name: string;
  to_json: string;
  cc_json: string;
  date: string | null;
  snippet: string;
  body_path: string | null;
  is_read: number;
  has_attachments: number;
  size: number;
  flags_json: string;
  created_at: string;
  updated_at: string;
  account_email?: string;
  folder_path?: string;
}

export interface AttachmentRow {
  id: number;
  message_id: number;
  filename: string;
  content_type: string;
  size: number;
  path: string | null;
  cached: number;
  part: string | null;
}

type Db = Database.Database;

let db: Db | null = null;

export function openDb(): Db {
  if (db) return db;
  db = new Database(DB_FILE);
  // WAL first, before anything else touches the DB (contract).
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL'); // standard companion for WAL mode
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');
  initSchema(db);
  return db;
}

export function getDb(): Db {
  if (!db) throw new Error('DB not opened');
  return db;
}

export function closeDb(): void {
  if (db) { db.close(); db = null; }
}

function initSchema(db: Db): void {
  db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    salt TEXT NOT NULL,
    failed_attempts INTEGER NOT NULL DEFAULT 0,
    locked_until TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    token_hash TEXT UNIQUE NOT NULL,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL,
    display_name TEXT NOT NULL DEFAULT '',
    password_enc TEXT NOT NULL,
    imap_host TEXT NOT NULL,
    imap_port INTEGER NOT NULL DEFAULT 993,
    imap_secure TEXT NOT NULL DEFAULT 'SSL',
    smtp_host TEXT NOT NULL,
    smtp_port INTEGER NOT NULL DEFAULT 465,
    smtp_secure TEXT NOT NULL DEFAULT 'SSL',
    enabled INTEGER NOT NULL DEFAULT 1,
    sort_order INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'offline',
    last_sync_at TEXT,
    error TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS folders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    path TEXT NOT NULL,
    name TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'other',
    uidvalidity INTEGER,
    uidnext INTEGER,
    modseq INTEGER,
    unread_count INTEGER NOT NULL DEFAULT 0,
    total_count INTEGER NOT NULL DEFAULT 0,
    UNIQUE(account_id, path)
  );

  -- Message bodies live on disk (DATA_DIR/bodies/<id>.html + .txt); this
  -- table stores metadata + body_path only (contract: 正文存磁盘).
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    folder_id INTEGER REFERENCES folders(id) ON DELETE CASCADE,
    uid INTEGER NOT NULL,
    message_id TEXT,
    subject TEXT NOT NULL DEFAULT '',
    from_addr TEXT NOT NULL DEFAULT '',
    from_name TEXT NOT NULL DEFAULT '',
    to_json TEXT NOT NULL DEFAULT '[]',
    cc_json TEXT NOT NULL DEFAULT '[]',
    date TEXT,
    snippet TEXT NOT NULL DEFAULT '',
    body_path TEXT,
    is_read INTEGER NOT NULL DEFAULT 0,
    has_attachments INTEGER NOT NULL DEFAULT 0,
    size INTEGER NOT NULL DEFAULT 0,
    flags_json TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(account_id, folder_id, uid)
  );

  CREATE TABLE IF NOT EXISTS attachments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    filename TEXT NOT NULL,
    content_type TEXT NOT NULL DEFAULT 'application/octet-stream',
    size INTEGER NOT NULL DEFAULT 0,
    path TEXT,
    cached INTEGER NOT NULL DEFAULT 1,
    part TEXT
  );

  CREATE TABLE IF NOT EXISTS sync_state (
    folder_id INTEGER PRIMARY KEY REFERENCES folders(id) ON DELETE CASCADE,
    uidvalidity INTEGER,
    uidnext INTEGER,
    modseq INTEGER,
    last_sync_at TEXT
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL DEFAULT ''
  );

  -- 彻底删除的墓碑：记下已彻底删除邮件的 Message-ID，同步时跳过它，
  -- 即使服务器上还留着（删除没落到服务器、或别的端又把它同步回来），
  -- 删掉的信也不会再复活。按账号 + Message-ID 唯一。
  CREATE TABLE IF NOT EXISTS deleted_messages (
    account_id INTEGER NOT NULL,
    message_id TEXT NOT NULL,
    deleted_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (account_id, message_id)
  );

  -- B12 发信幂等键：前端每封新邮件生成一个 UUID 随请求传，同一封重试
  -- 复用同一 key。先 INSERT 占位（message_db_id/message_id 为 NULL，
  -- 表示“发送进行中”）；成功后回填；发送失败则删除占位行（可再重试）。
  -- 占位冲突时查已有行：已有 message_id 表示已发过，直接返回原结果；
  -- 仍为 NULL 表示首发进行中，返回 409。
  CREATE TABLE IF NOT EXISTS sent_idempotency (
    account_id INTEGER NOT NULL,
    idempotency_key TEXT NOT NULL,
    message_db_id INTEGER,
    message_id TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (account_id, idempotency_key)
  );
  `);

  // ---- Migrations (dev DBs created by earlier revisions) ----
  const msgCols = db.prepare('PRAGMA table_info(messages)').all() as { name: string }[];
  const msgColNames = msgCols.map((c) => c.name);
  if (msgColNames.includes('body_text')) db.exec('ALTER TABLE messages DROP COLUMN body_text');
  if (msgColNames.includes('body_html')) db.exec('ALTER TABLE messages DROP COLUMN body_html');
  if (!msgColNames.includes('body_path')) db.exec('ALTER TABLE messages ADD COLUMN body_path TEXT');

  const attCols = db.prepare('PRAGMA table_info(attachments)').all() as { name: string }[];
  const attColNames = attCols.map((c) => c.name);
  if (attColNames.length && !attColNames.includes('cached')) {
    db.exec('ALTER TABLE attachments ADD COLUMN cached INTEGER NOT NULL DEFAULT 1');
  }
  if (attColNames.length && !attColNames.includes('part')) {
    db.exec('ALTER TABLE attachments ADD COLUMN part TEXT');
  }

  // ---- FTS5 (standalone table, maintained by the app, NOT triggers) ----
  // The searchable text lives here (subject / from / plain-text body);
  // the full bodies live on disk. An old content-table FTS (content=
  // 'messages', which referenced the removed body_text column) is dropped.
  const ftsSql = (db.prepare(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name='messages_fts'"
  ).get() as { sql: string } | undefined)?.sql || '';
  if (ftsSql && ftsSql.includes('content=')) {
    db.exec('DROP TABLE messages_fts');
    log('dropped legacy content-table FTS5 (bodies moved to disk)');
  }
  const hasFts = db.prepare(
    "SELECT COUNT(*) c FROM sqlite_master WHERE type='table' AND name='messages_fts'"
  ).get() as { c: number };
  if (!hasFts.c) {
    db.exec(`
      CREATE VIRTUAL TABLE messages_fts USING fts5(
        subject, from_addr, body_text, tokenize='trigram'
      );
    `);
    log('FTS5 trigram index created (standalone, app-maintained)');
  }
  backfillFts(db);
}

// Re-index any message that has no FTS row (e.g. after the FTS table was
// recreated, or envelopes synced before their bodies were fetched).
// 以前只补有正文的信，结果 156/208 封信完全搜不到（连主题/发件人都搜不到）。
// 现在无正文的信也建 FTS 行（主题+发件人），有正文的再把正文读进来。
// Cheap at this scale (<=50 mailboxes).
function backfillFts(db: Db): void {
  const rows = db.prepare(
    'SELECT m.id, m.subject, m.from_addr, m.body_path FROM messages m WHERE NOT EXISTS (SELECT 1 FROM messages_fts f WHERE f.rowid = m.id)'
  ).all() as { id: number; subject: string; from_addr: string; body_path: string | null }[];
  let added = 0;
  for (const r of rows) {
    let bodyText = '';
    if (r.body_path) {
      const txtPath = path.join(BODIES_DIR, `${r.id}.txt`);
      if (fs.existsSync(txtPath)) {
        try { bodyText = fs.readFileSync(txtPath, 'utf8'); } catch { /* unreadable body file: skip */ }
      }
    }
    db.prepare('INSERT INTO messages_fts(rowid, subject, from_addr, body_text) VALUES (?,?,?,?)')
      .run(r.id, r.subject, r.from_addr, bodyText);
    added++;
  }
  if (added) log(`FTS backfill: indexed ${added} message(s) without FTS row`);
}

// ---- FTS maintenance (called by the engine / routes when bodies change) ----
export function indexMessageFts(id: number, subject: string, fromAddr: string, bodyText: string): void {
  const db = getDb();
  // FTS5 虚表不支持 UPSERT（ON CONFLICT），先删后插。
  // 之前用 UPSERT 会在发信/收信时抛 SqliteError，收信处被 catch 只记日志，
  // 发信处没 catch 直接拖垮进程、前端拿 502（邮件其实已发出）。
  db.prepare('DELETE FROM messages_fts WHERE rowid=?').run(id);
  db.prepare('INSERT INTO messages_fts(rowid, subject, from_addr, body_text) VALUES (?,?,?,?)').run(id, subject, fromAddr, bodyText);
}

// 新信封一到就建 FTS 行（只写主题+发件人），不等正文拉取。
// 以前只在正文解析时才建 FTS 行，没拉过正文的信永远搜不到。
// 已有正文的保留正文（先读出来再重插），不被空正文冲掉。
export function indexMessageEnvelope(id: number, subject: string, fromAddr: string): void {
  const db = getDb();
  const existing = db.prepare('SELECT body_text FROM messages_fts WHERE rowid=?').get(id) as { body_text: string } | undefined;
  const bodyText = existing?.body_text || '';
  db.prepare('DELETE FROM messages_fts WHERE rowid=?').run(id);
  db.prepare('INSERT INTO messages_fts(rowid, subject, from_addr, body_text) VALUES (?,?,?,?)').run(id, subject, fromAddr, bodyText);
}

export function removeMessageFts(id: number): void {
  getDb().prepare('DELETE FROM messages_fts WHERE rowid=?').run(id);
}

export function removeMessagesFtsByAccount(accountId: number): void {
  getDb().prepare('DELETE FROM messages_fts WHERE rowid IN (SELECT id FROM messages WHERE account_id=?)').run(accountId);
}

export function removeMessagesFtsByFolder(folderId: number): void {
  getDb().prepare('DELETE FROM messages_fts WHERE rowid IN (SELECT id FROM messages WHERE folder_id=?)').run(folderId);
}

// ---------- search ----------
// 搜索逻辑（2026-11-18 全面优化）：
//   1. 多词一律 AND：一封信必须含全部词才命中。以前长词走 FTS 是 AND、
//      短词走 LIKE 是 OR、两组再 UNION，同一个查询里混用两种逻辑，结果不可预测。
//   2. 相关度排序：FTS 命中按 bm25 排（越相关越前），纯 LIKE 命中（无 bm25 分）
//      排在 FTS 命中之后、按时间倒序。以前只按时间排，标题完全命中的旧信
//      会被正文弱命中的新信压在下面。
//   3. FTS5 trigram 匹配不了 1-2 字词：>=3 字走 FTS MATCH（引号短语，隐含 AND），
//      <3 字走 LIKE '%词%'（subject / from_addr / body_text）。
// 返回按相关度排好序的 id 列表（调用方直接按此顺序分页、展示，不再按时间重排）。
export function searchMessageIds(q: string): number[] | null {
  const db = getDb();
  const terms = String(q || '').split(/\s+/).map((t) => t.trim()).filter(Boolean);
  if (!terms.length) return null; // no filtering
  const longTerms = terms.filter((t) => [...t].length >= 3);
  const shortTerms = terms.filter((t) => [...t].length < 3);

  // FTS 命中集 + bm25 分（分越小越相关）。
  let ftsIds: Set<number> | null = null;
  const ftsRank = new Map<number, number>();
  if (longTerms.length) {
    const match = longTerms.map((t) => `"${t.replace(/"/g, '')}"`).join(' ');
    const rows = db.prepare(
      'SELECT rowid AS id, bm25(messages_fts) AS rank FROM messages_fts WHERE messages_fts MATCH ? ORDER BY rank'
    ).all(match) as { id: number; rank: number }[];
    ftsIds = new Set(rows.map((r) => r.id));
    for (const r of rows) ftsRank.set(r.id, r.rank);
  }
  // LIKE 命中集：每个短词都必须命中（词与词之间 AND；单个词在主题/发件人/正文任一处命中即可）。
  let likeIds: Set<number> | null = null;
  if (shortTerms.length) {
    const likeClauses = shortTerms.map(
      () => `(subject LIKE ? ESCAPE '\\' OR from_addr LIKE ? ESCAPE '\\' OR body_text LIKE ? ESCAPE '\\')`
    );
    const params: string[] = [];
    for (const t of shortTerms) {
      const esc = `%${t.replace(/[\\%_]/g, (c) => '\\' + c)}%`;
      params.push(esc, esc, esc);
    }
    const rows = db.prepare(
      `SELECT rowid AS id FROM messages_fts WHERE ${likeClauses.join(' AND ')}`
    ).all(...params) as { id: number }[];
    likeIds = new Set(rows.map((r) => r.id));
  }
  // 交集：必须同时满足长词组与短词组（以前是并集，任一组命中就算，太宽）。
  let ids: Set<number>;
  if (ftsIds && likeIds) {
    ids = new Set([...ftsIds].filter((id) => likeIds.has(id)));
  } else if (ftsIds) {
    ids = ftsIds;
  } else if (likeIds) {
    ids = likeIds;
  } else {
    return [];
  }
  // 按相关度排序：FTS 命中按 bm25 升序；纯 LIKE 命中无分，排在后面、按 id 倒序（越新越前）。
  return [...ids].sort((a, b) => {
    const ra = ftsRank.get(a);
    const rb = ftsRank.get(b);
    if (ra !== undefined && rb !== undefined) return ra - rb;
    if (ra !== undefined) return -1;
    if (rb !== undefined) return 1;
    return b - a;
  });
}

export function refreshFolderCounts(folderId: number): void {
  const db = getDb();
  const row = db.prepare(
    `SELECT COUNT(*) total, COALESCE(SUM(CASE WHEN is_read=0 THEN 1 ELSE 0 END),0) unread
     FROM messages WHERE folder_id=?`
  ).get(folderId) as { total: number; unread: number };
  db.prepare('UPDATE folders SET total_count=?, unread_count=? WHERE id=?')
    .run(row.total, row.unread, folderId);
}

// Body file paths for a message id.
export function bodyHtmlPath(messageId: number): string {
  return path.join(BODIES_DIR, `${messageId}.html`);
}

export function bodyTextPath(messageId: number): string {
  return path.join(BODIES_DIR, `${messageId}.txt`);
}

export function readBodyFiles(messageId: number): { bodyText: string; bodyHtml: string } {
  let bodyText = '';
  let bodyHtml = '';
  try { bodyText = fs.readFileSync(bodyTextPath(messageId), 'utf8'); } catch { /* not parsed yet */ }
  try { bodyHtml = fs.readFileSync(bodyHtmlPath(messageId), 'utf8'); } catch { /* not parsed yet */ }
  return { bodyText, bodyHtml };
}
