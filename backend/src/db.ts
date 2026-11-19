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
  // Audit #10 threading：原信 References 头（正文拉取时解析存入），
  // GET /api/messages/:id 返回给前端做回复/转发 threading 用。
  references?: string | null;
  // Audit #11 threading：原信 Reply-To 头（解析存入），详情接口返回，
  // 前端回复时优先发往 Reply-To。
  reply_to?: string | null;
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
  // S10: 数据库文件只允许属主读（旧版 0644，服务器上任何本地账号
  // 都能读全部邮件内容——FTS5 表里就是全部正文明文）。
  try { fs.chmodSync(DB_FILE, 0o600); } catch { /* ignore */ }
  // Audit #10 M-4：WAL 模式的 -wal/-shm 由 SQLite 以默认 umask 创建
  // （通常 0644），本地其他账号可读其中近期写入页（正文 FTS 明文、
  // password_enc 都在其中）。与 DB 文件同款强制 0600；WAL 文件在
  // checkpoint 后可能重建，这里每次 openDb 都复查一次。
  for (const suffix of ['-wal', '-shm']) {
    try { fs.chmodSync(DB_FILE + suffix, 0o600); } catch { /* ignore (file may not exist yet) */ }
  }
  return db;
}

export function getDb(): Db {
  if (!db) throw new Error('DB not opened');
  return db;
}

export function closeDb(): void {
  if (db) { db.close(); db = null; }
}

// 启动时一次性清理（S2/D5/L6）：已过期会话 + 180 天以上的删除墓碑。
// datetime() 包一层：新格式直接比对；旧版 ISO 格式（T/Z）的遗留会话行
// 也能正确过期。墓碑只清 180 天前的——须长于服务器端保留期，
// 避免刚删的信在同步里复活。
export function pruneExpiredRows(): { sessions: number; tombstones: number; deleteKeys: number; sentKeys: number } {
  const db = getDb();
  const s = db.prepare(
    "DELETE FROM sessions WHERE datetime(expires_at) <= datetime('now')",
  ).run();
  const t = db.prepare(
    "DELETE FROM deleted_messages WHERE deleted_at <= datetime('now', '-180 days')",
  ).run();
  // 删除幂等键只留 7 天：重试都在几分钟内发生，7 天足够；过期后同一 key
  // 当作新动作（已删的信不会因此复活，只是不再挡重复执行）。
  const d = db.prepare(
    "DELETE FROM delete_idempotency WHERE created_at <= datetime('now', '-7 days')",
  ).run();
  // Audit #8 LOW-4（邮件逻辑）：发信幂等键原来只增不减——已完成
  // （message_id 非空）的记录 180 天后清掉，保留去重窗口即可；
  // 进行中的占位行（message_id 为空）不受影响。
  const si = db.prepare(
    "DELETE FROM sent_idempotency WHERE message_id IS NOT NULL AND created_at <= datetime('now', '-180 days')",
  ).run();
  if (s.changes || t.changes || d.changes || si.changes) {
    log(`pruned ${s.changes} expired session(s), ${t.changes} tombstone(s) older than 180 days, ${d.changes} delete key(s) older than 7 days, ${si.changes} completed send key(s) older than 180 days`);
  }
  return { sessions: s.changes, tombstones: t.changes, deleteKeys: d.changes, sentKeys: si.changes };
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
    "references" TEXT,
    reply_to TEXT,
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
    cached INTEGER NOT NULL DEFAULT 0, -- Audit #9 L7：由 1 改为 0（见下迁移注释）
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

  -- 草稿（审计 #5 后用户定夺，后端接口）：只存本地草稿，不进 FTS、
  -- 不进 messages 表、不参与同步；删账号时级联删除（FK + foreign_keys=ON）。
  -- 列名用 to_addrs 而不用 to：to 是 SQLite 关键字，CREATE TABLE
  -- 直接报 near "to" 语法错误（2026-11-18 实测）；API 字段仍叫 to。
  -- Audit #11 threading：草稿重开后 threading 不丢——回复/转发时
  -- 原信的 Message-ID（in_reply_to）、References 链（references，
  -- 空格拼成的字符串）与抄送（cc，JSON 数组字符串）随草稿存下来，
  -- 发信时（请求体没带时）用草稿存的字段兜底。
  CREATE TABLE IF NOT EXISTS drafts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    to_addrs TEXT NOT NULL DEFAULT '',
    subject TEXT NOT NULL DEFAULT '',
    text TEXT NOT NULL DEFAULT '',
    in_reply_to TEXT,
    "references" TEXT,
    cc TEXT,
    idempotency_key TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- 删除幂等键（审计 #2 L1 后端半边）：删信响应丢失后用户重试，
  -- 同一 key 直接返回第一次的结果，不再执行第二次删除——否则一次
  -- “移到已删除”重试后会变成永久删除。单删按 message_db_id 记，
  -- 批量删按 task_id 记（轮询同一任务）。前端须每次删除动作生成
  -- 一个新 key 传下来（未传 key 时保持现有行为）。
  CREATE TABLE IF NOT EXISTS delete_idempotency (
    idempotency_key TEXT PRIMARY KEY,
    task_id TEXT,
    message_db_id INTEGER,
    -- Audit #10 M-6：状态机 in_progress/done/failed（进行中 10 分钟后过期可重认领）。
    status TEXT NOT NULL DEFAULT 'done',
    -- Audit #9 L14：失败标记（与 status='failed' 同步写，旧行回填依据）。
    failed_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
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
    // Audit #9 L7：新列默认值由 1 改为 0。只改默认值、不删残留代码：
    // 线上是否确无 cached=1 行无法核实（不能碰线上数据库），残留代码暂留。
    db.exec('ALTER TABLE attachments ADD COLUMN cached INTEGER NOT NULL DEFAULT 0');
  }
  if (attColNames.length && !attColNames.includes('part')) {
    db.exec('ALTER TABLE attachments ADD COLUMN part TEXT');
  }

  // ---- Audit #5b: sent_idempotency 预生成 Message-ID ----
  // 认领时把本次发送的 Message-ID 预先存进 planned_message_id（见
  // idempotency.ts）：崩溃后重认领时复用同一个 ID，不再每次请求现
  // 生成一个（否则 SMTP 成功后崩溃 → 重认领 → 以新 ID 再发一封）。
  // 旧库（占位行已存在但无此列）靠下面迁移补列。
  const idemCols = db.prepare('PRAGMA table_info(sent_idempotency)').all() as { name: string }[];
  if (idemCols.length && !idemCols.map((c) => c.name).includes('planned_message_id')) {
    db.exec('ALTER TABLE sent_idempotency ADD COLUMN planned_message_id TEXT');
  }

  // ---- Audit #10 M-6：delete_idempotency 加 status 列 ----
  // 状态机：in_progress（进行中）/ done（已完成）/ failed（失败）。
  // 旧行（无此列时建的）按 failed_at 回填：有 failed_at → failed，
  // 其余 → done（当时只有成功占位才会留到现在）。进行中的占位在
  // 10 分钟后过期（路由层按 created_at 判断，见 messageRoutes），
  // 崩溃残留不再让重试 7 天都谎报成功。
  const delIdemCols2 = db.prepare('PRAGMA table_info(delete_idempotency)').all() as { name: string }[];
  // 兜底：极旧库可能缺 failed_at 列（审计 #9 L14 才加），先补再回填。
  if (delIdemCols2.length && !delIdemCols2.map((c) => c.name).includes('failed_at')) {
    db.exec('ALTER TABLE delete_idempotency ADD COLUMN failed_at TEXT');
  }
  if (delIdemCols2.length && !delIdemCols2.map((c) => c.name).includes('status')) {
    db.exec("ALTER TABLE delete_idempotency ADD COLUMN status TEXT NOT NULL DEFAULT 'done'");
    db.exec("UPDATE delete_idempotency SET status='failed' WHERE failed_at IS NOT NULL");
  }

  // ---- Audit #10（threading）：messages 加 references 列 ----
  // 回复/转发要把原信的 References 链传给收件方（与 In-Reply-To 一起
  // 归入原会话）。正文拉取时从 References 头解析后存这里；GET
  // /api/messages/:id 原样返回（未拉过正文的信为 NULL，前端只发
  // In-Reply-To，仍可 threading）。
  // 注意：references 是 SQLite 保留字（FOREIGN KEY ... REFERENCES），
  // SQL 里必须写成带双引号的 "references"，裸写会报 syntax error。
  const msgCols2 = db.prepare('PRAGMA table_info(messages)').all() as { name: string }[];
  if (msgCols2.length && !msgCols2.map((c) => c.name).includes('references')) {
    db.exec('ALTER TABLE messages ADD COLUMN "references" TEXT');
  }
  // Audit #11 threading：messages.reply_to（原信 Reply-To 头）——
  // 旧库加列（新库建表时已有）。无则加，有则跳过，重启自动生效。
  const msgCols3 = db.prepare('PRAGMA table_info(messages)').all() as { name: string }[];
  if (msgCols3.length && !msgCols3.map((c) => c.name).includes('reply_to')) {
    db.exec('ALTER TABLE messages ADD COLUMN reply_to TEXT');
  }
  // Audit #11 threading：drafts 三列（in_reply_to / "references" / cc）——
  // 旧库加列（新库建表时已有）。无则加，有则跳过，重启自动生效。
  const draftCols = db.prepare('PRAGMA table_info(drafts)').all() as { name: string }[];
  if (draftCols.length) {
    const names = draftCols.map((c) => c.name);
    if (!names.includes('in_reply_to')) db.exec('ALTER TABLE drafts ADD COLUMN in_reply_to TEXT');
    if (!names.includes('references')) db.exec('ALTER TABLE drafts ADD COLUMN "references" TEXT');
    if (!names.includes('cc')) db.exec('ALTER TABLE drafts ADD COLUMN cc TEXT');
  }

  // ---- OquMail 已发送未读 bug：存量回填（一次性，幂等） ----
  // OquMail 不给已发送里的邮件打 \Seen，旧同步把已发送/草稿的信都记成
  // 未读。部署重启后自动生效一次：把 sent/drafts 文件夹里现有的未读行
  // 全翻成已读，并重算受影响文件夹的计数。幂等：跑过一次后 is_read=0
  // 的行已不存在，再跑就是空操作（WHERE is_read=0）。
  // trash/spam/inbox 不动；账号角标 SUM 口径不动（本来就是对的）。
  {
    const affected = db.prepare(
      `SELECT DISTINCT folder_id FROM messages
       WHERE is_read=0 AND folder_id IN (SELECT id FROM folders WHERE type IN ('sent','drafts'))`,
    ).all() as { folder_id: number }[];
    if (affected.length) {
      const info = db.prepare(
        `UPDATE messages SET is_read=1
         WHERE folder_id IN (SELECT id FROM folders WHERE type IN ('sent','drafts')) AND is_read=0`,
      ).run();
      for (const f of affected) refreshFolderCounts(f.folder_id);
      log(`backfill: marked ${info.changes} sent/draft messages as read (${affected.length} folders)`);
    }
  }

  // ---- Audit #5 (17): messages 按 Message-ID 唯一 ----
  // 应用层去重（F1）是唯一防线；补唯一索引做纵深防御。SQLite 的 UNIQUE
  // 允许多个 NULL，message_id 为空的信不受影响。线上已核实无重复
  // （dup_mid 查询为空）。若某旧库里真有重复，索引建失败时只记警告、
  // 不让服务器起不来（应用层去重仍在）。
  try {
    const dupMid = (db.prepare(
      `SELECT COUNT(*) c FROM (
         SELECT account_id, folder_id, message_id FROM messages
         WHERE message_id IS NOT NULL
         GROUP BY account_id, folder_id, message_id HAVING COUNT(*) > 1
       )`,
    ).get() as { c: number }).c;
    if (dupMid === 0) {
      db.exec(
        'CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_account_folder_mid ' +
        'ON messages(account_id, folder_id, message_id)',
      );
    } else {
      log(`WARNING: ${dupMid} duplicate (account, folder, message_id) group(s); unique index skipped`);
    }
  } catch (e) {
    log('WARNING: could not create messages Message-ID unique index:', (e as Error)?.message || e);
  }

  // ---- Audit #8 MED-1（数据库）：messages 缺 folder_id 索引——每次同步
  // 每个文件夹的 UID 差集 / flags 全取 / 计数刷新都是全表扫（EXPLAIN 全是
  // SCAN）。复合覆盖索引一次解决三处查询（10,235 封实测一轮同步 346ms → 13ms）。
  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_messages_folder_uid_read ' +
    'ON messages(folder_id, uid, is_read)',
  );
  // ---- Audit #8 LOW-2（数据库）：attachments 缺 message_id 索引——打开
  // 每封信都查、删信时 FK 级联删附件同样全表扫。
  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_attachments_message_id ' +
    'ON attachments(message_id)',
  );
  // ---- Audit #8 LOW-6（数据库）：prune 的 DELETE 全表扫——墓碑与删信
  // 幂等键的过期清理按时间列删，给两列加索引。
  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_deleted_messages_deleted_at ' +
    'ON deleted_messages(deleted_at)',
  );
  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_delete_idempotency_created_at ' +
    'ON delete_idempotency(created_at)',
  );
  // ---- Audit #9 M5（数据库）：邮件列表热查询 ORDER BY m.date DESC 无对应
  // 索引——大文件夹下每翻一页都要全文件夹扫描 + 排序。复合索引覆盖列表
  // 查询（聚合视图走 account_id 索引，见下）。
  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_messages_folder_date ' +
    'ON messages(folder_id, date DESC, id DESC)',
  );
  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_messages_account_date ' +
    'ON messages(account_id, date DESC, id DESC)',
  );
  // ---- Audit #10 L-11：聚合视图与 all-unread 的索引 ----
  // M5 的两个索引只覆盖“文件夹视图 / 账号级视图”；默认聚合视图是
  // folder_id IN (子查询)，跨多个 folder_id 时无法全局定序，
  // all-unread（is_read=0）更是无任何可用索引。规模 ≤10k 封时代价
  // 很小，但索引本身便宜，先补上。
  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_messages_date_id ' +
    'ON messages(date DESC, id DESC)',
  );
  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_messages_unread_date ' +
    'ON messages(is_read, date DESC, id DESC)',
  );

  // ---- Audit #9 L8：drafts.idempotency_key 唯一索引 ----
  // SQLite UNIQUE 允许多个 NULL，key 为空的旧行不受影响；若旧库已有
  // 重复 key，建索引失败只记警告、不让服务器起不来（路由先查后插仍在）。
  try {
    db.exec(
      'CREATE UNIQUE INDEX IF NOT EXISTS idx_drafts_idempotency_key ' +
      'ON drafts(idempotency_key)',
    );
  } catch (e) {
    log('WARNING: could not create drafts idempotency unique index:', (e as Error)?.message || e);
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
export function searchMessageIds(q: string): { ids: number[]; truncated: boolean } | null {
  const db = getDb();
  const terms = String(q || '').split(/\s+/).map((t) => t.trim()).filter(Boolean);
  if (!terms.length) return null; // no filtering
  const longTerms = terms.filter((t) => [...t].length >= 3);
  const shortTerms = terms.filter((t) => [...t].length < 3);

  // Audit #10 M-8：先取交集、再截断——旧版 FTS 与 LIKE 各自 LIMIT 2000
  // 截断后再取交集，一封同时命中长词（FTS 排名 2001 开外）和短词的信
  // 会被丢掉，而 truncated:true + total（交集后长度）还会让前端以为
  // “仅显示前 2000 条”实际只剩几十条。现在两分支各取带排序的超集
  // （LIMIT 2001 探测，见 L-25），交集后再按相关度排序、截断到 2000。
  // Audit #10 L-25：恰好 2000 命中时旧版 `rows.length >= 2000` 即误报
  // truncated——改 LIMIT 2001 探测，只有真正超过 2000 才置 truncated。
  const FETCH_LIMIT = 2001;
  const RESULT_LIMIT = 2000;
  // FTS 命中集 + bm25 分（分越小越相关）。
  let ftsIds: Set<number> | null = null;
  const ftsRank = new Map<number, number>();
  // D4: 去引号后为空的词直接跳过——`"""` 会拼成 MATCH '""'，
  // FTS 语法错误 500。matchTerms 为空时不做 FTS 约束（走 LIKE 或返回空）。
  // Audit #10 L-4：`*` 在引号短语里仍可能触发 FTS5 语法错（如 `***`），
  // 先去掉 `*`；MATCH 本身再包 try/catch，语法错时当作该分支无命中
  // （返回空结果，不再 500）。
  let truncated = false;
  const matchTerms = longTerms.map((t) => t.replace(/["*]/g, '')).filter((t) => t.length > 0);
  if (matchTerms.length) {
    const match = matchTerms.map((t) => `"${t}"`).join(' ');
    // Audit #8 LOW-1（数据库）：MATCH 原来返回全部命中行、无 LIMIT——
    // 常见词一次返回上万行再在 JS 里交集；加 LIMIT 封顶。
    try {
      const rows = db.prepare(
        'SELECT rowid AS id, bm25(messages_fts) AS rank FROM messages_fts WHERE messages_fts MATCH ? ORDER BY rank LIMIT ?'
      ).all(match, FETCH_LIMIT) as { id: number; rank: number }[];
      if (rows.length > RESULT_LIMIT) truncated = true;
      ftsIds = new Set(rows.map((r) => r.id));
      for (const r of rows) ftsRank.set(r.id, r.rank);
    } catch {
      // FTS 语法错（如残留的特殊操作符）：该分支无命中，不抛 500。
      ftsIds = new Set();
    }
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
      // Audit #8 MED-2（数据库）：短词 LIKE 在 FTS 表上全表扫（含全部正文），
      // 搜索范围不变（body_text 继续搜），只加 LIMIT 封顶——
      // 单次短词搜索的扫描量有界，正常搜索（命中 <2000）不受影响。
      // Audit #10 M-8：LIKE 分支补确定性 ORDER BY（旧版无序取样，同查询
      // 多次结果可不同）——按 rowid 倒序（越新越前），与纯 LIKE 命中的
      // 展示顺序一致。
      `SELECT rowid AS id FROM messages_fts WHERE ${likeClauses.join(' AND ')} ORDER BY rowid DESC LIMIT ?`
    ).all(...params, FETCH_LIMIT) as { id: number }[];
    if (rows.length > RESULT_LIMIT) truncated = true;
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
    return { ids: [], truncated };
  }
  // 按相关度排序：FTS 命中按 bm25 升序；纯 LIKE 命中无分，排在后面、按 id 倒序（越新越前）。
  // 交集后再截断到 2000：超过时 truncated=true（两分支超集探测已置过，
  // 这里按交集后实际长度再算一次为准）。
  const sorted = [...ids].sort((a, b) => {
    const ra = ftsRank.get(a);
    const rb = ftsRank.get(b);
    if (ra !== undefined && rb !== undefined) return ra - rb;
    if (ra !== undefined) return -1;
    if (rb !== undefined) return 1;
    return b - a;
  });
  if (sorted.length > RESULT_LIMIT) truncated = true;
  return { ids: sorted.slice(0, RESULT_LIMIT), truncated };
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

// 删掉一封信的正文磁盘文件（html + txt）。同步删行路径（R2）与
// deleteMessage 同款调用——只删 DB 行不删文件时，已删邮件的全文仍以
// 明文躺在磁盘上，还会被“备份到本地”一并打包。
export function removeBodyFiles(messageId: number): void {
  try { fs.rmSync(bodyHtmlPath(messageId), { force: true }); } catch { /* ignore */ }
  try { fs.rmSync(bodyTextPath(messageId), { force: true }); } catch { /* ignore */ }
}
