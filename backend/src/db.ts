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

export interface SessionRow {
  id: number;
  token_hash: string;
  user_id: number;
  expires_at: string;
  created_at: string;
  username?: string;
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

export interface SyncStateRow {
  folder_id: number;
  uidvalidity: number | null;
  uidnext: number | null;
  modseq: number | null;
  last_sync_at: string | null;
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

// Re-index any message that has a body on disk but no FTS row (e.g. after
// the FTS table was recreated). Cheap at this scale (<=50 mailboxes).
function backfillFts(db: Db): void {
  const rows = db.prepare(
    'SELECT m.id, m.subject, m.from_addr FROM messages m WHERE m.body_path IS NOT NULL'
  ).all() as { id: number; subject: string; from_addr: string }[];
  let added = 0;
  for (const r of rows) {
    const exists = (db.prepare('SELECT COUNT(*) c FROM messages_fts WHERE rowid=?').get(r.id) as { c: number }).c;
    if (exists) continue;
    const txtPath = path.join(BODIES_DIR, `${r.id}.txt`);
    if (!fs.existsSync(txtPath)) continue;
    try {
      const bodyText = fs.readFileSync(txtPath, 'utf8');
      db.prepare('INSERT INTO messages_fts(rowid, subject, from_addr, body_text) VALUES (?,?,?,?)')
        .run(r.id, r.subject, r.from_addr, bodyText);
      added++;
    } catch { /* unreadable body file: skip */ }
  }
  if (added) log(`FTS backfill: re-indexed ${added} message(s) from disk bodies`);
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
// FTS5 trigram cannot match 1-2 char terms, so:
//   terms >= 3 chars -> FTS MATCH (quoted phrases, implicit AND)
//   terms < 3 chars  -> LIKE '%term%' on the FTS table's stored columns
//     (subject / from_addr / body_text — the searchable text lives there)
// The two id sets are UNIONed. `extraWhere`/`extraParams` scope the search
// (e.g. to one view); q is the raw user query string.
export function searchMessageIds(q: string, extraWhere = '', extraParams: unknown[] = []): number[] | null {
  const db = getDb();
  const terms = String(q || '').split(/\s+/).map((t) => t.trim()).filter(Boolean);
  if (!terms.length) return null; // no filtering
  const ids = new Set<number>();

  const longTerms = terms.filter((t) => [...t].length >= 3);
  const shortTerms = terms.filter((t) => [...t].length < 3);

  if (longTerms.length) {
    const match = longTerms.map((t) => `"${t.replace(/"/g, '')}"`).join(' ');
    const rows = db.prepare(
      'SELECT rowid AS id FROM messages_fts WHERE messages_fts MATCH ?'
    ).all(match) as { id: number }[];
    for (const r of rows) ids.add(r.id);
  }
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
      `SELECT rowid AS id FROM messages_fts WHERE ${likeClauses.join(' OR ')}`
    ).all(...params) as { id: number }[];
    for (const r of rows) ids.add(r.id);
  }
  // Apply the view scope (extraWhere) by intersecting with scoped ids.
  if (extraWhere) {
    const scoped = db.prepare(
      `SELECT id FROM messages WHERE ${extraWhere}`
    ).all(...(extraParams as never[])) as { id: number }[];
    const scopedSet = new Set(scoped.map((r) => r.id));
    for (const id of [...ids]) if (!scopedSet.has(id)) ids.delete(id);
  }
  return [...ids];
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
