// luck-mail backend verification script (local only, fake credentials only).
// Usage: npm run build && npm run verify
// Spawns the compiled server (dist/server.js) on a temp DATA_DIR and checks:
//  auth flow, presets, accounts, 163 reachability (IMAP+SMTP, fake creds),
//  streaming parse + DOMPurify, worker-thread parse, FTS5 trigram (+2-char
//  LIKE fallback), AES-256-GCM roundtrip, WAL mode, Socket.io push,
//  bodies on disk, attachments metadata-only. Exits non-zero on any failure.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import Database from 'better-sqlite3';
import { io as ioClient } from 'socket.io-client';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BACKEND = path.resolve(__dirname, '..');
const PORT = 18082;
const BASE = `http://127.0.0.1:${PORT}`;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'luck-mail-verify-'));
const DATA_DIR = path.join(TMP, 'data');
const PUBLIC_DIR = path.join(TMP, 'public');

// Env must be set BEFORE importing dist modules (config reads it at import).
process.env.DATA_DIR = DATA_DIR;
process.env.PUBLIC_DIR = PUBLIC_DIR;
process.env.PORT = String(PORT);

const { encryptSecret, decryptSecret } = await import('../dist/cryptoUtil.js');
const { streamToParsed } = await import('../dist/mailStream.js');
const { parseInWorker, spoolToTemp } = await import('../dist/streamParse.js');
const { sanitizeBodyHtml } = await import('../dist/sanitize.js');

let pass = 0;
let fail = 0;
const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  if (ok) { pass++; console.log(`  PASS ${name}${detail ? ' — ' + detail : ''}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
}

let cookie = '';
async function api(method, p, body, extraHeaders = {}) {
  const headers = { ...extraHeaders };
  if (cookie) headers.Cookie = cookie;
  let payload;
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(BASE + p, { method, headers, body: payload });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON */ }
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) {
    const m = setCookie.match(/lm_session=([^;]+)/);
    if (m) cookie = `lm_session=${m[1]}`;
  }
  return { status: res.status, json, text, headers: res.headers };
}

async function waitReady(server, tries = 40) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(BASE + '/api/auth/status');
      if (r.ok) return true;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

console.log(`verify tmp dir: ${TMP}`);
const server = spawn('node', ['dist/server.js'], {
  cwd: BACKEND,
  env: { ...process.env, PORT: String(PORT), DATA_DIR, PUBLIC_DIR },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
server.stdout.on('data', (d) => { serverLog += d.toString(); });
server.stderr.on('data', (d) => { serverLog += d.toString(); });
let db = null;

try {
  if (!(await waitReady(server))) {
    console.log(serverLog);
    throw new Error('server did not start');
  }
  console.log('== server up ==');
  check('server starts (dist build)', true);

  // ---------- 1. auth ----------
  console.log('== auth ==');
  let r = await api('GET', '/api/auth/status');
  check('status: setupRequired=true before setup', r.json?.setupRequired === true && r.json?.loggedIn === false);
  r = await api('POST', '/api/auth/setup', { username: 'tester', password: 'short', confirm: 'short' });
  check('setup rejects short password (400)', r.status === 400);
  r = await api('POST', '/api/auth/setup', { username: 'tester', password: 'testpass123', confirm: 'testpass123' });
  check('setup creates single user (201)', r.status === 201 && r.json?.ok === true);
  r = await api('POST', '/api/auth/setup', { username: 'tester', password: 'testpass123', confirm: 'testpass123' });
  check('second setup rejected (409)', r.status === 409);
  r = await api('GET', '/api/accounts');
  check('authed endpoints need login (401)', r.status === 401);
  r = await api('POST', '/api/auth/login', { username: 'tester', password: 'wrongpass' });
  check('wrong password -> 401', r.status === 401);
  // IP lockout for unknown usernames (does not lock the real user).
  for (let i = 0; i < 5; i++) await api('POST', '/api/auth/login', { username: 'nobody', password: 'x' });
  r = await api('POST', '/api/auth/login', { username: 'nobody', password: 'x' });
  check('unknown-user login locked after 5 fails (429 + retryAfter)', r.status === 429 && typeof r.json?.retryAfter === 'number');
  r = await api('POST', '/api/auth/login', { username: 'tester', password: 'testpass123' });
  check('login ok + sets lm_session cookie', r.status === 200 && cookie.startsWith('lm_session='));
  r = await api('GET', '/api/auth/status');
  check('status: loggedIn + username', r.json?.loggedIn === true && r.json?.username === 'tester');

  // ---------- 2. presets / accounts ----------
  console.log('== presets & accounts ==');
  r = await api('GET', '/api/presets');
  check('presets include 163 + exmail', !!r.json?.presets?.['163.com'] && !!r.json?.presets?.exmail);
  r = await api('GET', '/api/presets/163.com');
  check('preset 163.com = imap.163.com:993 SSL', r.json?.preset?.imapHost === 'imap.163.com' && r.json?.preset?.imapPort === 993);
  r = await api('GET', '/api/presets/unknown-domain-xyz.com');
  check('unknown domain falls back to imap./smtp.', r.json?.preset?.imapHost === 'imap.unknown-domain-xyz.com');
  r = await api('GET', '/api/accounts');
  check('accounts list empty', r.status === 200 && Array.isArray(r.json?.accounts) && r.json.accounts.length === 0);
  r = await api('POST', '/api/accounts', { email: 'fakeuser@163.com', password: 'FAKE_AUTH_CODE_123' });
  check('add fake account fails connectivity (400, clear step, no 500/stack)',
    r.status === 400 && typeof r.json?.error === 'string' && r.json.error.includes('IMAP') && !r.text.includes(' at ') && !r.text.includes('Error:'));
  r = await api('GET', '/api/accounts');
  check('fake account was NOT saved', r.json?.accounts?.length === 0);

  // ---------- 3. encryption + key file ----------
  console.log('== crypto & key file ==');
  const key = fs.readFileSync(path.join(DATA_DIR, '.key'));
  const keyMode = (fs.statSync(path.join(DATA_DIR, '.key')).mode & 0o777).toString(8);
  check('key file is 32 bytes, mode 0600', key.length === 32 && keyMode === '600', `mode=${keyMode}`);
  const enc = encryptSecret('my-auth-code-xyz', key);
  check('AES-256-GCM roundtrip', decryptSecret(enc, key) === 'my-auth-code-xyz' && enc !== 'my-auth-code-xyz');

  // ---------- 4. WAL ----------
  console.log('== sqlite / WAL ==');
  const dbPath = path.join(DATA_DIR, 'luck-mail.db');
  db = new Database(dbPath);
  db.pragma('busy_timeout = 5000');
  const journal = db.pragma('journal_mode', { simple: true });
  check('journal_mode is WAL', journal === 'wal', `journal_mode=${journal}`);
  const ftsSql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='messages_fts'").get();
  check('FTS5 trigram table exists (standalone)', !!ftsSql?.sql && ftsSql.sql.includes("tokenize='trigram'") && !ftsSql.sql.includes('content='));
  const msgCols = db.prepare('PRAGMA table_info(messages)').all().map((c) => c.name);
  check('messages table has body_path, no body_text/body_html columns',
    msgCols.includes('body_path') && !msgCols.includes('body_text') && !msgCols.includes('body_html'),
    msgCols.join(','));

  // ---------- 5. seed test data (direct DB, account disabled so no IMAP) ----------
  console.log('== seed test data ==');
  const accInfo = db.prepare(
    `INSERT INTO accounts (email, display_name, password_enc, imap_host, imap_port, imap_secure,
      smtp_host, smtp_port, smtp_secure, enabled, status) VALUES (?,?,?,?,?,?,?,?,?,?, 'offline')`,
  ).run('fakeuser@163.com', 'Fake', encryptSecret('FAKE_AUTH_CODE_123', key),
    'imap.163.com', 993, 'SSL', 'smtp.163.com', 465, 'SSL', 0);
  const accountId = Number(accInfo.lastInsertRowid);
  const folderInfo = db.prepare(
    "INSERT INTO folders (account_id, path, name, type) VALUES (?, 'INBOX', '收件箱', 'inbox')",
  ).run(accountId);
  const folderId = Number(folderInfo.lastInsertRowid);
  const mkMsg = (uid, subject, from, snippet) => {
    const info = db.prepare(
      `INSERT INTO messages (account_id, folder_id, uid, subject, from_addr, to_json, date,
        snippet, body_path, is_read, has_attachments, size, flags_json)
       VALUES (?,?,?,?,?,?,?,?,?,0,0,1234,'[]')`,
    ).run(accountId, folderId, uid, subject, from, '[]', new Date().toISOString(), snippet, null);
    return Number(info.lastInsertRowid);
  };
  const m1 = mkMsg(1, '你好世界测试邮件', 'sender@163.com', '这是第一封中文测试邮件');
  const m2 = mkMsg(2, '项目进度报告', 'boss@qq.com', '第二封邮件讨论项目进度');
  fs.writeFileSync(path.join(DATA_DIR, 'bodies', `${m1}.html`), '<p>这是第一封中文测试邮件正文</p>');
  fs.writeFileSync(path.join(DATA_DIR, 'bodies', `${m1}.txt`), '这是第一封中文测试邮件正文');
  fs.writeFileSync(path.join(DATA_DIR, 'bodies', `${m2}.html`), '<p>第二封邮件讨论项目进度</p>');
  fs.writeFileSync(path.join(DATA_DIR, 'bodies', `${m2}.txt`), '第二封邮件讨论项目进度');
  db.prepare("UPDATE messages SET body_path=? WHERE id=?").run(`bodies/${m1}.html`, m1);
  db.prepare("UPDATE messages SET body_path=? WHERE id=?").run(`bodies/${m2}.html`, m2);
  db.prepare('INSERT INTO messages_fts(rowid, subject, from_addr, body_text) VALUES (?,?,?,?)')
    .run(m1, '你好世界测试邮件', 'sender@163.com', '这是第一封中文测试邮件正文');
  db.prepare('INSERT INTO messages_fts(rowid, subject, from_addr, body_text) VALUES (?,?,?,?)')
    .run(m2, '项目进度报告', 'boss@qq.com', '第二封邮件讨论项目进度');
  // attachments: one small cached, one large metadata-only (no part -> live fetch unavailable)
  const attSmall = db.prepare(
    "INSERT INTO attachments (message_id, filename, content_type, size, path, cached, part) VALUES (?,?,?,?,?,?,NULL)",
  ).run(m1, 'hello.txt', 'text/plain', 11, `${m1}/1-hello.txt`, 1);
  fs.mkdirSync(path.join(DATA_DIR, 'attachments', String(m1)), { recursive: true });
  fs.writeFileSync(path.join(DATA_DIR, 'attachments', String(m1), '1-hello.txt'), 'hello world');
  const attLarge = db.prepare(
    "INSERT INTO attachments (message_id, filename, content_type, size, path, cached, part) VALUES (?,?,?,?,NULL,0,NULL)",
  ).run(m1, 'big-video.mp4', 'video/mp4', 15 * 1024 * 1024);
  check('seeded 1 disabled account + inbox + 2 messages + FTS rows', true);

  // ---------- 6. search / list / detail via API ----------
  console.log('== search & messages API ==');
  r = await api('GET', `/api/messages?q=${encodeURIComponent('你好世界')}`);
  check('FTS trigram finds 3+ char Chinese term', r.json?.messages?.some((m) => m.id === m1), `total=${r.json?.total}`);
  r = await api('GET', `/api/messages?q=${encodeURIComponent('项目')}`);
  check('2-char Chinese term hits via LIKE fallback', r.json?.messages?.some((m) => m.id === m2), `total=${r.json?.total}`);
  r = await api('GET', `/api/messages?view=all-inbox&limit=50`);
  check('all-inbox lists seeded messages', r.json?.total === 2);
  r = await api('GET', `/api/messages/${m1}`);
  check('detail returns body from disk files',
    r.json?.message?.bodyText?.includes('第一封中文测试邮件正文') && r.json?.message?.bodyHtml?.includes('第一封中文测试邮件正文'));
  const atts = r.json?.message?.attachments || [];
  const small = atts.find((a) => a.filename === 'hello.txt');
  const large = atts.find((a) => a.filename === 'big-video.mp4');
  check('attachment meta has size; no large distinction (API returns large=false)',
    small?.size === 11 && small?.large === false && large?.size === 15 * 1024 * 1024 && large?.large === false,
    JSON.stringify(atts));
  r = await api('GET', `/api/messages/${m1}/attachments/${Number(attSmall.lastInsertRowid)}`);
  check('B18: legacy cached attachment WITHOUT IMAP part -> 404 (disk branch removed; disk file is ignored)',
    r.status === 404 && r.json?.ok === false);
  r = await api('GET', `/api/messages/${m1}/attachments/${Number(attLarge.lastInsertRowid)}`);
  check('uncached attachment without IMAP part -> 404 JSON (no crash)', r.status === 404 && r.json?.ok === false);

  // ---------- 7. account test endpoint (fake creds, clear step error) ----------
  console.log('== account test endpoint ==');
  r = await api('POST', `/api/accounts/${accountId}/test`);
  check('test endpoint: imapOk=false + step error (not ok:true lie)',
    r.json?.imapOk === false && typeof r.json?.error === 'string' && r.json.error.includes('IMAP') && r.json.error.includes('认证被拒'),
    JSON.stringify(r.json)?.slice(0, 200));

  // ---------- 8. DOMPurify + streaming parse ----------
  console.log('== DOMPurify & streaming parse ==');
  const eml = Buffer.concat([
    Buffer.from('From: =?UTF-8?B?5byg5LiJ?= <a@163.com>\r\nTo: b@qq.com\r\nSubject: =?UTF-8?B?5L2g5aW95rWL6K+V?=\r\nDate: Mon, 16 Nov 2026 10:00:00 +0800\r\nMessage-ID: <abc@163.com>\r\nMIME-Version: 1.0\r\nContent-Type: text/html; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n', 'utf8'),
    Buffer.from(Buffer.from('<p>你好<br><script>alert(1)</script><img src="http://x.com/p.png" width="1" height="1"><img src="http://x.com/ok.png" width="100" height="50"></p>', 'utf8').toString('base64')),
    Buffer.from('\r\n', 'utf8'),
  ]);
  const parsed = await streamToParsed(Readable.from([eml]), eml.length);
  check('stream parse: Chinese encoded-word subject decoded', parsed.envelope.subject === '你好测试', parsed.envelope.subject);
  check('stream parse: body text correct', parsed.bodyText.includes('你好'));
  check('DOMPurify removed <script>', !parsed.bodyHtml.includes('<script') && !parsed.bodyHtml.includes('alert(1)'));
  check('DOMPurify removed 1x1 tracking pixel but kept normal img',
    !parsed.bodyHtml.includes('p.png') && parsed.bodyHtml.includes('ok.png'));
  check('DOMPurify direct: onerror/js: stripped',
    !sanitizeBodyHtml('<img src=x onerror=alert(1)><a href="javascript:alert(1)">x</a>').includes('onerror')
    && !sanitizeBodyHtml('<a href="javascript:alert(1)">x</a>').includes('javascript:'));

  // ---------- 9. worker-thread parse + metadata-only attachments ----------
  console.log('== worker parse & metadata-only attachments ==');
  const bigText = '这是一行很长的中文正文。'.repeat(300000); // ~10.5MB text
  const bigEml = Buffer.from(
    `From: big@163.com\r\nSubject: big test\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${bigText}`,
    'utf8',
  );
  const tmpFile = await spoolToTemp(Readable.from([bigEml]), 999001);
  const workerParsed = await parseInWorker(tmpFile, bigEml.length);
  fs.rm(tmpFile, { force: true }, () => {});
  check('worker thread parses >5MB message (subject + body intact)',
    workerParsed.envelope.subject === 'big test' && workerParsed.bodyText.includes('很长的中文正文'));
  // 12MB attachment: metadata-only, zero bytes on disk. The streaming parser
  // never writes attachments to disk and never sets large (no large/small
  // distinction in the current design); downloads stream live from IMAP.
  const attData = Buffer.alloc(12 * 1024 * 1024, 0x41);
  const emlBigAtt = Buffer.concat([
    Buffer.from('From: a@163.com\r\nSubject: big attachment\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary="B"\r\n\r\n--B\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nhello\r\n--B\r\nContent-Type: application/octet-stream; name="big.bin"\r\nContent-Transfer-Encoding: base64\r\nContent-Disposition: attachment; filename="big.bin"\r\n\r\n', 'utf8'),
    Buffer.from(attData.toString('base64')),
    Buffer.from('\r\n--B--\r\n', 'utf8'),
  ]);
  const beforeDisk = fs.existsSync(path.join(DATA_DIR, 'attachments', '999002'));
  const parsedBig = await streamToParsed(Readable.from([emlBigAtt]), emlBigAtt.length);
  const bigAtt = parsedBig.attachments[0];
  const bigAttOnDisk = fs.existsSync(path.join(DATA_DIR, 'attachments', '999002', '1-big.bin'));
  check('>10MB attachment: metadata only, no file on disk',
    bigAtt?.size === 12 * 1024 * 1024 && bigAtt?.cached === false && bigAtt?.large === false && !bigAttOnDisk && !beforeDisk,
    `size=${bigAtt?.size} cached=${bigAtt?.cached}`);
  fs.rmSync(path.join(DATA_DIR, 'attachments', '999002'), { recursive: true, force: true });
  // Small attachment is also metadata-only (the streaming parser never writes
  // attachments to disk, any size); download streams live from IMAP by part.
  const emlSmallAtt = Buffer.concat([
    Buffer.from('From: a@163.com\r\nSubject: small attachment\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary="B"\r\n\r\n--B\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nhello\r\n--B\r\nContent-Type: text/plain; name="s.txt"\r\nContent-Transfer-Encoding: base64\r\nContent-Disposition: attachment; filename="s.txt"\r\n\r\n', 'utf8'),
    Buffer.from(Buffer.from('small file content').toString('base64')),
    Buffer.from('\r\n--B--\r\n', 'utf8'),
  ]);
  const parsedSmall = await streamToParsed(Readable.from([emlSmallAtt]), emlSmallAtt.length);
  const smallAtt = parsedSmall.attachments[0];
  check('<=10MB attachment also metadata-only (no file on disk)',
    smallAtt?.cached === false && smallAtt?.large === false && !fs.existsSync(path.join(DATA_DIR, 'attachments', '999003', '1-s.txt')));

  // ---------- 10. Socket.io ----------
  console.log('== socket.io ==');
  const socketEvents = [];
  const socket = ioClient(BASE, {
    path: '/socket.io/',
    extraHeaders: { Cookie: cookie },
    reconnection: false,
    timeout: 5000,
  });
  const connected = await new Promise((resolve) => {
    socket.on('connect', () => resolve(true));
    socket.on('connect_error', (e) => { socketEvents.push('connect_error:' + e.message); resolve(false); });
    setTimeout(() => resolve(false), 6000);
  });
  check('socket.io connects with valid lm_session cookie', connected === true, socketEvents.join(','));
  if (connected) {
    const syncEvt = new Promise((resolve) => {
      socket.on('sync', (payload) => resolve(payload));
      setTimeout(() => resolve(null), 8000);
    });
    await api('POST', '/api/refresh-all');
    const evt = await syncEvt;
    check('refresh-all pushes a sync event to the client', !!evt && evt.state === 'done', JSON.stringify(evt));
    socket.on('ping', () => {});
    socket.emit('ping');
    socket.disconnect();
  }
  const badSocket = ioClient(BASE, {
    path: '/socket.io/',
    reconnection: false,
    timeout: 5000,
  });
  const badRejected = await new Promise((resolve) => {
    badSocket.on('connect', () => resolve(false));
    badSocket.on('connect_error', () => resolve(true));
    setTimeout(() => resolve(false), 6000);
  });
  check('socket.io rejects connection without session cookie', badRejected === true);
  badSocket.disconnect();

  // ---------- 11. 163 reachability (fake creds: TLS/IMAP handshake, then auth fail) ----------
  console.log('== 163 reachability (fake credentials) ==');
  const { ImapFlow } = await import('imapflow');
  const { default: nodemailer } = await import('nodemailer');
  const idLog = [];
  const logger = {
    debug: (o) => idLog.push(typeof o === 'string' ? o : JSON.stringify(o)),
    info: (o) => idLog.push(typeof o === 'string' ? o : JSON.stringify(o)),
    warn: () => {},
    error: () => {},
  };
  let imapErr = '';
  let imapAuthFailed = false;
  try {
    const c = new ImapFlow({
      host: 'imap.163.com', port: 993, secure: true,
      auth: { user: 'fakeuser@163.com', pass: 'FAKE_AUTH_CODE_123' },
      clientInfo: { name: 'luck-mail', version: '0.1.0', vendor: 'luck-mail', 'support-url': 'https://mm.ynzb.cn' },
      logger,
      disableAutoIdle: true,
    });
    await c.connect();
    await c.logout();
    imapErr = 'UNEXPECTEDLY CONNECTED';
  } catch (e) {
    imapErr = String(e?.message || e);
    // imapflow's .message is generic ("Command failed"); the real verdict is
    // in e.authenticationFailed + e.responseText ("LOGIN Login error...").
    imapAuthFailed = e?.authenticationFailed === true || /Login error/i.test(e?.responseText || '');
  }
  const idSeen = idLog.some((l) => /\bID\b/.test(l));
  check('163 IMAP: TLS+handshake OK, auth rejected (not network failure)',
    imapAuthFailed,
    `error=${imapErr.slice(0, 60)} authFailed=${imapAuthFailed}`);
  check('163 IMAP: ID command was sent (logger trace)', idSeen, idSeen ? '' : `log lines=${idLog.length}`);
  let smtpErr = '';
  let smtpAuthFailed = false;
  try {
    const t = nodemailer.createTransport({
      host: 'smtp.163.com', port: 465, secure: true,
      auth: { user: 'fakeuser@163.com', pass: 'FAKE_AUTH_CODE_123' },
      connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 20000,
    });
    await t.verify();
    t.close();
    smtpErr = 'UNEXPECTEDLY VERIFIED';
  } catch (e) {
    smtpErr = String(e?.message || e);
    smtpAuthFailed = e?.code === 'EAUTH' || /Invalid login/i.test(smtpErr);
  }
  check('163 SMTP: TLS handshake OK, auth rejected (not DNS/network failure)',
    smtpAuthFailed,
    `error=${smtpErr.slice(0, 120)}`);

  // ---------- 12. settings ----------
  console.log('== settings ==');
  r = await api('PUT', '/api/settings', { signature: '-- Tester' });
  check('settings save + read back', r.status === 200 && r.json?.settings?.signature === '-- Tester');
  r = await api('GET', '/api/folders');
  check('unknown API path -> 404 JSON', r.status === 404 && r.json?.ok === false);

  // ---------- 13. audit #3 backend fixes (B1/B5/B12/B13 + send guards) ----------
  console.log('== audit #3 fixes ==');
  // B1: UIDVALIDITY 为 NaN 时第二次同步不再删光重插（假 IMAP 客户端直测
  // _syncFolder；163/QQ 从不返回 UIDVALIDITY，mailbox.uidValidity 为 undefined）。
  {
    const { openDb } = await import('../dist/db.js');
    const { SyncEngine } = await import('../dist/engine.js');
    const vdb = openDb();
    const b1Acc = vdb.prepare(
      `INSERT INTO accounts (email, display_name, password_enc, imap_host, imap_port, imap_secure,
        smtp_host, smtp_port, smtp_secure, enabled, status) VALUES (?,?,?,?,?,?,?,?,?,?, 'offline')`,
    ).run('b1test@163.com', 'B1', encryptSecret('FAKE', key),
      'imap.163.com', 993, 'SSL', 'smtp.163.com', 465, 'SSL', 0);
    const b1AccountId = Number(b1Acc.lastInsertRowid);
    const b1Folder = vdb.prepare(
      "INSERT INTO folders (account_id, path, name, type) VALUES (?, 'INBOX', '收件箱', 'inbox')",
    ).run(b1AccountId);
    const b1FolderId = Number(b1Folder.lastInsertRowid);
    const b1FolderRow = vdb.prepare('SELECT * FROM folders WHERE id=?').get(b1FolderId);
    let currentUidValidity = undefined; // 163/QQ: 从不返回
    const mkEnvMsg = (uid) => ({
      uid,
      envelope: {
        messageId: `<b1-${uid}@x>`, subject: `B1 test ${uid}`,
        date: new Date('2026-11-18T10:00:00Z'),
        from: [{ address: 'a@163.com', name: 'A' }], to: [],
      },
      flags: ['\\Seen'],
      bodyStructure: null,
      size: 100,
      internalDate: new Date('2026-11-18T10:00:00Z'),
      bodyParts: new Map([['TEXT', Buffer.from('plain snippet hello world')]]),
    });
    const fakeClient = {
      mailboxOpen: async () => ({ uidValidity: currentUidValidity, uidNext: undefined, highestModseq: null, exists: 2 }),
      search: async () => [101, 102],
      fetch: async function* () { yield mkEnvMsg(101); yield mkEnvMsg(102); },
    };
    const b1Engine = new SyncEngine(key);
    await b1Engine._syncFolder(fakeClient, b1AccountId, b1FolderRow);
    const afterFirst = vdb.prepare('SELECT id, created_at FROM messages WHERE folder_id=? ORDER BY uid').all(b1FolderId);
    await b1Engine._syncFolder(fakeClient, b1AccountId, b1FolderRow);
    const afterSecond = vdb.prepare('SELECT id, created_at FROM messages WHERE folder_id=? ORDER BY uid').all(b1FolderId);
    const syncState = vdb.prepare('SELECT uidvalidity FROM sync_state WHERE folder_id=?').get(b1FolderId);
    check('B1: 2nd sync with UIDVALIDITY=NaN does NOT wipe/reinsert (ids + created_at stable)',
      afterFirst.length === 2 && afterSecond.length === 2
      && afterFirst[0].id === afterSecond[0].id && afterFirst[1].id === afterSecond[1].id
      && afterFirst[0].created_at === afterSecond[0].created_at
      && afterFirst[1].created_at === afterSecond[1].created_at
      && syncState?.uidvalidity === null,
      `first=${JSON.stringify(afterFirst)} second=${JSON.stringify(afterSecond)}`);
    // 真实 UIDVALIDITY 出现/变化时仍走全量重取（另一分支不能被修死）。
    currentUidValidity = 12345;
    await b1Engine._syncFolder(fakeClient, b1AccountId, b1FolderRow);
    const afterThird = vdb.prepare('SELECT id FROM messages WHERE folder_id=? ORDER BY uid').all(b1FolderId);
    check('B1: real UIDVALIDITY change still triggers full refetch (ids replaced, count stable)',
      afterThird.length === 2 && afterThird[0].id !== afterFirst[0].id,
      `third=${JSON.stringify(afterThird)}`);
  }

  // B12: 发信幂等键状态机（纯函数级）+ 路由级失败释放占位。
  {
    const { claimSendKey, completeSendKey, releaseSendKey, findSendKey } = await import('../dist/idempotency.js');
    const A = 424242;
    const c1 = claimSendKey(A, 'k1');
    const c2 = claimSendKey(A, 'k1');
    completeSendKey(A, 'k1', 123, '<mid@x>');
    const c3 = claimSendKey(A, 'k1');
    const relCompleted = findSendKey(A, 'k1');
    releaseSendKey(A, 'k1'); // 已完成的记录不删
    const stillThere = findSendKey(A, 'k1');
    check('B12: claim -> in-progress -> complete -> duplicate returns original result',
      c1.status === 'claimed' && c2.status === 'in-progress'
      && c3.status === 'duplicate' && c3.row.message_db_id === 123 && c3.row.message_id === '<mid@x>',
      JSON.stringify([c1.status, c2.status, c3.status]));
    check('B12: release only removes in-progress rows (completed row kept)',
      !!relCompleted && !!stillThere && stillThere.message_db_id === 123);
    const c4 = claimSendKey(A, 'k2');
    releaseSendKey(A, 'k2');
    const gone = findSendKey(A, 'k2');
    const c5 = claimSendKey(A, 'k2');
    check('B12: release removes in-progress row, key reusable afterwards',
      c4.status === 'claimed' && gone === undefined && c5.status === 'claimed');
  }

  // B5: SMTP 连接池（nodemailer 6.10.1）+ dropTransporter 正常关闭。
  {
    const { getTransporter, dropTransporter } = await import('../dist/smtpUtil.js');
    const fakeRow = {
      id: 999001, email: 'a@163.com', display_name: '', password_enc: '',
      imap_host: 'imap.163.com', imap_port: 993, imap_secure: 'SSL',
      smtp_host: 'smtp.163.com', smtp_port: 465, smtp_secure: 'SSL',
      enabled: 1, sort_order: 0, status: 'offline', last_sync_at: null, error: null,
      created_at: '', updated_at: '',
    };
    const t1 = getTransporter(fakeRow, 'fakepass');
    const t2 = getTransporter(fakeRow, 'fakepass');
    const pooled = t1.options?.pool === true && t1.options?.maxConnections === 1 && t1.options?.maxMessages === 100;
    dropTransporter(999001); // must not throw (pool close)
    const t3 = getTransporter(fakeRow, 'fakepass');
    dropTransporter(999001);
    check('B5: transporter cached per account + pool:true, maxConnections:1, maxMessages:100',
      t1 === t2 && pooled, `pool=${t1.options?.pool} maxConn=${t1.options?.maxConnections} maxMsg=${t1.options?.maxMessages}`);
    check('B5: dropTransporter closes pool; next get returns a fresh transporter', t3 !== t1);
  }

  // B12 路由级 + B16 收件人上限（用一个 enabled 的假账号；SMTP 会 502，
  // 不产生真实发信）。
  const idemAcc = db.prepare(
    `INSERT INTO accounts (email, display_name, password_enc, imap_host, imap_port, imap_secure,
      smtp_host, smtp_port, smtp_secure, enabled, status) VALUES (?,?,?,?,?,?,?,?,?,?, 'offline')`,
  ).run('idemtest@163.com', 'Idem', encryptSecret('FAKE_AUTH_CODE_123', key),
    'imap.163.com', 993, 'SSL', 'smtp.163.com', 465, 'SSL', 1);
  const idemAccountId = Number(idemAcc.lastInsertRowid);
  r = await api('POST', '/api/messages/send', {
    accountId: idemAccountId, to: 'x@163.com', subject: 'idem test', text: 'hi',
    idempotencyKey: 'http-key-1',
  });
  const idemLeft = db.prepare("SELECT COUNT(*) c FROM sent_idempotency WHERE idempotency_key='http-key-1'").get().c;
  check('B12: send fails at SMTP (502) and the in-progress placeholder is released',
    r.status === 502 && idemLeft === 0, `status=${r.status} leftover=${idemLeft}`);
  const manyTo = Array.from({ length: 51 }, (_, i) => `r${i}@163.com`);
  r = await api('POST', '/api/messages/send', {
    accountId: idemAccountId, to: manyTo, subject: 'too many', text: 'hi',
  });
  check('B16: to+cc+bcc over 50 recipients -> 400 with clear message',
    r.status === 400 && typeof r.json?.error === 'string' && r.json.error.includes('50'),
    `status=${r.status} error=${r.json?.error}`);

  // B13: 批量删除立即返回 taskId，后台跑完后 delete-status 可查（任务隔离）。
  {
    const mkDel = (uid) => {
      const info = db.prepare(
        `INSERT INTO messages (account_id, folder_id, uid, subject, from_addr, to_json, date,
          snippet, body_path, is_read, has_attachments, size, flags_json)
         VALUES (?,?,?,?,?,?,?,?,?,0,0,1234,'[]')`,
      ).run(accountId, folderId, uid, `del ${uid}`, 'd@163.com', '[]', new Date().toISOString(), 'del', null);
      return Number(info.lastInsertRowid);
    };
    const d1 = mkDel(9001);
    const d2 = mkDel(9002);
    r = await api('POST', '/api/messages/batch-delete', { ids: [d1, d2] });
    const taskId1 = r.json?.taskId;
    check('B13: batch-delete returns immediately with taskId + status running',
      r.status === 200 && typeof taskId1 === 'string' && r.json?.status === 'running',
      `status=${r.status} body=${JSON.stringify(r.json)?.slice(0, 120)}`);
    let st = null;
    for (let i = 0; i < 40; i++) {
      const s = await api('GET', `/api/messages/delete-status?taskId=${encodeURIComponent(taskId1)}`);
      st = s.json;
      if (st && st.running === false) break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    check('B13: delete-status polls to completion (total=2, deleted+failed=2)',
      st && st.running === false && st.total === 2 && (st.deleted + (st.failed || []).length) === 2,
      JSON.stringify(st)?.slice(0, 200));
    const d3 = mkDel(9003);
    r = await api('POST', '/api/messages/batch-delete', { ids: [d3] });
    check('B13: a second batch-delete gets a different taskId (per-task isolation)',
      typeof r.json?.taskId === 'string' && r.json.taskId !== taskId1);
    // 等第二个任务跑完，避免后台任务拖到进程退出。
    for (let i = 0; i < 40; i++) {
      const s = await api('GET', `/api/messages/delete-status?taskId=${encodeURIComponent(r.json.taskId)}`);
      if (s.json && s.json.running === false) break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }

  // ---------- 14. audit #4 backend fixes (F1/F2/F3/F4/F6 + delete sweep) ----------
  console.log('== audit #4 fixes ==');
  {
    const { openDb } = await import('../dist/db.js');
    const { SyncEngine } = await import('../dist/engine.js');
    const vdb = openDb();
    const mkEnv = (uid, mid, subject = 'F1 test') => ({
      uid,
      envelope: {
        messageId: mid, subject,
        date: new Date('2026-11-18T10:00:00Z'),
        from: [{ address: 'a@163.com', name: 'A' }], to: [],
      },
      flags: ['\\Seen'],
      bodyStructure: null,
      size: 100,
      internalDate: new Date('2026-11-18T10:00:00Z'),
      bodyParts: new Map([['TEXT', Buffer.from('plain snippet hello world')]]),
    });
    const mkSentAccount = (email) => {
      const a = vdb.prepare(
        `INSERT INTO accounts (email, display_name, password_enc, imap_host, imap_port, imap_secure,
          smtp_host, smtp_port, smtp_secure, enabled, status) VALUES (?,?,?,?,?,?,?,?,?,?, 'offline')`,
      ).run(email, 'F4', encryptSecret('FAKE', key),
        'imap.163.com', 993, 'SSL', 'smtp.163.com', 465, 'SSL', 0);
      const accountId = Number(a.lastInsertRowid);
      const f = vdb.prepare(
        "INSERT INTO folders (account_id, path, name, type) VALUES (?, '已发送', '已发送', 'sent')",
      ).run(accountId);
      const folderId = Number(f.lastInsertRowid);
      return { accountId, folderId, folderRow: vdb.prepare('SELECT * FROM folders WHERE id=?').get(folderId) };
    };
    const MID = '<audit4-dup-001@163.com>';
    // F1a: 增量同步——发信缓存行（uid 100）已在库，服务器有两份
    // （APPEND 的 100 + 自动保存的 101，同一 Message-ID）→ 仍 1 行。
    {
      const { accountId, folderId, folderRow } = mkSentAccount('f1a@163.com');
      vdb.prepare(`INSERT INTO messages (account_id, folder_id, uid, message_id, subject, from_addr,
        from_name, to_json, date, snippet, is_read, has_attachments, size, flags_json)
        VALUES (?,?,?,?,?,?,?, ?,datetime('now'),'',1,0,100,'[\"\\\\Seen\"]')`).run(
        accountId, folderId, 100, MID, 'F1 test', 'f1a@163.com', 'F4', '[]');
      vdb.prepare('INSERT INTO sync_state (folder_id, uidvalidity, uidnext, modseq, last_sync_at) VALUES (?, NULL, NULL, NULL, datetime(\'now\'))').run(folderId);
      const serverUids = [100, 101];
      const fakeClient = {
        mailbox: { path: '已发送' },
        mailboxOpen: async () => ({ uidValidity: undefined, uidNext: undefined, highestModseq: null, exists: 2 }),
        search: async () => [...serverUids],
        fetch: async function* () { yield mkEnv(100, MID); yield mkEnv(101, MID); },
      };
      const engine = new SyncEngine(key);
      await engine._syncFolder(fakeClient, accountId, folderRow);
      const rows = vdb.prepare('SELECT id, uid FROM messages WHERE account_id=? AND message_id=?').all(accountId, MID);
      check('F1a: incremental sync with 2 server copies (same Message-ID) keeps 1 row',
        rows.length === 1 && rows[0].uid === 100, JSON.stringify(rows));
    }
    // F1b: 全量重取分支——服务器两份同一 Message-ID → 只插 1 行。
    {
      const { accountId, folderId, folderRow } = mkSentAccount('f1b@163.com');
      const fakeClient = {
        mailbox: { path: '已发送' },
        mailboxOpen: async () => ({ uidValidity: undefined, uidNext: undefined, highestModseq: null, exists: 2 }),
        search: async () => [100, 101],
        fetch: async function* () { yield mkEnv(100, MID); yield mkEnv(101, MID); },
      };
      const engine = new SyncEngine(key);
      await engine._syncFolder(fakeClient, accountId, folderRow);
      const rows = vdb.prepare('SELECT id, uid FROM messages WHERE account_id=? AND message_id=?').all(accountId, MID);
      check('F1b: full refetch with 2 server copies (same Message-ID) inserts 1 row',
        rows.length === 1 && rows[0].uid === 100, JSON.stringify(rows));
    }
    // F1c: 对照——两个不同 Message-ID 仍是 2 行（去重不过度合并）。
    {
      const { accountId, folderId, folderRow } = mkSentAccount('f1c@163.com');
      const fakeClient = {
        mailbox: { path: '已发送' },
        mailboxOpen: async () => ({ uidValidity: undefined, uidNext: undefined, highestModseq: null, exists: 2 }),
        search: async () => [100, 101],
        fetch: async function* () { yield mkEnv(100, '<audit4-a@163.com>'); yield mkEnv(101, '<audit4-b@163.com>'); },
      };
      const engine = new SyncEngine(key);
      await engine._syncFolder(fakeClient, accountId, folderRow);
      const rows = vdb.prepare('SELECT id, uid FROM messages WHERE folder_id=?').all(folderId);
      check('F1c: control — 2 different Message-IDs still insert 2 rows',
        rows.length === 2, JSON.stringify(rows));
    }
    // F2a: _syncFolders 跳过 \Noselect 父文件夹（QQ“其他文件夹”），
    // 子文件夹照常同步；已有父文件夹行由清理删掉。
    {
      const a = vdb.prepare(
        `INSERT INTO accounts (email, display_name, password_enc, imap_host, imap_port, imap_secure,
          smtp_host, smtp_port, smtp_secure, enabled, status) VALUES (?,?,?,?,?,?,?,?,?,?, 'offline')`,
      ).run('f2a@qq.com', 'F2', encryptSecret('FAKE', key),
        'imap.qq.com', 993, 'SSL', 'smtp.qq.com', 465, 'SSL', 0);
      const accountId = Number(a.lastInsertRowid);
      for (const [p, n, t] of [['INBOX', '收件箱', 'inbox'], ['其他文件夹', '其他文件夹', 'other'], ['其他文件夹/QQ邮件订阅', 'QQ邮件订阅', 'other']]) {
        vdb.prepare('INSERT INTO folders (account_id, path, name, type) VALUES (?,?,?,?)').run(accountId, p, n, t);
      }
      const fakeList = [
        { path: 'INBOX', name: 'INBOX', delimiter: '/', specialUse: '\\Inbox', flags: new Set(['\\HasNoChildren']), children: [] },
        {
          path: '其他文件夹', name: '其他文件夹', delimiter: '/', flags: new Set(['\\Noselect', '\\HasChildren']),
          children: [{ path: '其他文件夹/QQ邮件订阅', name: 'QQ邮件订阅', delimiter: '/', flags: new Set(['\\HasNoChildren']), children: [] }],
        },
      ];
      const fakeClient = { list: async () => fakeList };
      const engine = new SyncEngine(key);
      await engine._syncFolders(fakeClient, accountId);
      const remaining = vdb.prepare('SELECT path FROM folders WHERE account_id=? ORDER BY path').all(accountId).map((r) => r.path);
      check('F2a: _syncFolders skips \\Noselect parent (row removed) but keeps its selectable child',
        !remaining.includes('其他文件夹') && remaining.includes('INBOX') && remaining.includes('其他文件夹/QQ邮件订阅'),
        JSON.stringify(remaining));
    }
    // F2c: QQ 实测返回 \NoSelect（大写 S），不是 RFC 标准的 \Noselect——
    // 旧版 isNonSelectable 只认 \Noselect，跳过失效，化石行重启后又被
    // 插回（2026-11-18 线上复核）。同 F2a 流程，只改 flags 拼写。
    {
      const a = vdb.prepare(
        `INSERT INTO accounts (email, display_name, password_enc, imap_host, imap_port, imap_secure,
          smtp_host, smtp_port, smtp_secure, enabled, status) VALUES (?,?,?,?,?,?,?,?,?,?, 'offline')`,
      ).run('f2c@qq.com', 'F2c', encryptSecret('FAKE', key),
        'imap.qq.com', 993, 'SSL', 'smtp.qq.com', 465, 'SSL', 0);
      const accountId = Number(a.lastInsertRowid);
      for (const [p, n, t] of [['INBOX', '收件箱', 'inbox'], ['其他文件夹', '其他文件夹', 'other'], ['其他文件夹/QQ邮件订阅', 'QQ邮件订阅', 'other']]) {
        vdb.prepare('INSERT INTO folders (account_id, path, name, type) VALUES (?,?,?,?)').run(accountId, p, n, t);
      }
      const fakeList = [
        { path: 'INBOX', name: 'INBOX', delimiter: '/', specialUse: '\\Inbox', flags: new Set(['\\HasNoChildren']), children: [] },
        {
          path: '其他文件夹', name: '其他文件夹', delimiter: '/', flags: new Set(['\\NoSelect', '\\HasChildren']),
          children: [{ path: '其他文件夹/QQ邮件订阅', name: 'QQ邮件订阅', delimiter: '/', flags: new Set(['\\HasNoChildren']), children: [] }],
        },
      ];
      const fakeClient = { list: async () => fakeList };
      const engine = new SyncEngine(key);
      await engine._syncFolders(fakeClient, accountId);
      const remaining = vdb.prepare('SELECT path FROM folders WHERE account_id=? ORDER BY path').all(accountId).map((r) => r.path);
      check('F2c: _syncFolders skips QQ spelling \\NoSelect parent (row removed) but keeps its selectable child',
        !remaining.includes('其他文件夹') && remaining.includes('INBOX') && remaining.includes('其他文件夹/QQ邮件订阅'),
        JSON.stringify(remaining));
    }
    // F2b: _syncFolder 在 mailboxOpen 后核对 client.mailbox.path——
    // 仍停留在上一个文件夹时抛错，不再写错文件夹。
    {
      const { accountId, folderRow } = mkSentAccount('f2b@qq.com');
      const stuckClient = {
        mailbox: { path: 'Sent Messages' }, // mailboxOpen 不切换，仍停留
        mailboxOpen: async () => ({ uidValidity: undefined, uidNext: undefined, highestModseq: null, exists: 2 }),
        search: async () => [],
        fetch: async function* () {},
      };
      const engine = new SyncEngine(key);
      let errMsg = '';
      try {
        await engine._syncFolder(stuckClient, accountId, folderRow);
      } catch (e) {
        errMsg = String(e?.message || e);
      }
      check('F2b: _syncFolder throws on mailbox.path mismatch (stuck on previous mailbox)',
        errMsg.includes('mailbox open mismatch'), errMsg);
    }
    // F3: _findUidByMessageId 不再用 SEARCH HEADER（QQ 返回 []），
    // 改走 FETCH envelope 后 JS 侧比对；多个命中取最大 UID；且全程
    // 没有发过带 header 的 search。
    {
      const searchCalls = [];
      const fakeClient = {
        mailbox: { path: 'INBOX' },
        mailboxOpen: async () => ({ uidValidity: undefined, uidNext: undefined, highestModseq: null, exists: 2 }),
        search: async (criteria) => { searchCalls.push(criteria); return [100, 101]; },
        fetch: async function* () { yield mkEnv(100, MID); yield mkEnv(101, MID); },
      };
      const engine = new SyncEngine(key);
      const uid = await engine._findUidByMessageId(fakeClient, 'INBOX', MID);
      const noHeaderSearch = searchCalls.every((c) => !c || !('header' in c));
      const uidMissing = await engine._findUidByMessageId(fakeClient, 'INBOX', '<not-there@x>');
      check('F3: Message-ID lookup via FETCH+JS compare returns max UID, never uses SEARCH HEADER',
        uid === 101 && noHeaderSearch, `uid=${uid} searchCalls=${JSON.stringify(searchCalls)}`);
      check('F3: lookup of an absent Message-ID returns null',
        uidMissing === null, `uidMissing=${uidMissing}`);
    }
    // F4: buildRawMail 编译出的 raw 里 Message-ID 头与返回的
    // messageId 一致——重试复用同一份 raw / 同一 Message-ID 的前提。
    {
      const { buildRawMail } = await import('../dist/smtpUtil.js');
      const fakeAccount = {
        id: 999002, email: 'a@163.com', display_name: '', password_enc: '',
        imap_host: 'imap.163.com', imap_port: 993, imap_secure: 'SSL',
        smtp_host: 'smtp.163.com', smtp_port: 465, smtp_secure: 'SSL',
        enabled: 1, sort_order: 0, status: 'offline', last_sync_at: null, error: null,
        created_at: '', updated_at: '',
      };
      const built = await buildRawMail(fakeAccount, { to: 'x@163.com', subject: 'f4', text: 'hi' });
      const rawText = built.raw.toString('utf8');
      const m = /Message-ID:\s*(<[^>]+>)/i.exec(rawText);
      check('F4: buildRawMail raw Message-ID header equals returned messageId',
        !!built.messageId && !!m && m[1] === built.messageId, `messageId=${built.messageId} header=${m?.[1]}`);
    }
    // F6: 幂等占位过期——超过 10 分钟的“进行中”占位可重新认领；
    // 新鲜占位仍返回 in-progress；已完成的记录永不过期。
    {
      const { claimSendKey, completeSendKey, findSendKey } = await import('../dist/idempotency.js');
      const A = 424243;
      vdb.prepare("INSERT INTO sent_idempotency (account_id, idempotency_key, message_db_id, message_id, created_at) VALUES (?,?,NULL,NULL,datetime('now','-11 minutes'))").run(A, 'stale-k');
      const stale = claimSendKey(A, 'stale-k');
      const staleRow = findSendKey(A, 'stale-k');
      const staleAgeOk = staleRow ? (Date.now() - Date.parse(staleRow.created_at.replace(' ', 'T') + 'Z')) < 60 * 1000 : false;
      check('F6: stale in-progress placeholder (>10min) can be re-claimed',
        stale.status === 'claimed' && staleAgeOk, JSON.stringify(stale.status));
      const f1 = claimSendKey(A, 'fresh-k');
      const f2 = claimSendKey(A, 'fresh-k');
      check('F6: fresh in-progress placeholder still returns in-progress',
        f1.status === 'claimed' && f2.status === 'in-progress', JSON.stringify([f1.status, f2.status]));
      claimSendKey(A, 'done-k');
      completeSendKey(A, 'done-k', 777, '<done@x>');
      vdb.prepare("UPDATE sent_idempotency SET created_at=datetime('now','-60 minutes') WHERE account_id=? AND idempotency_key=?").run(A, 'done-k');
      const done = claimSendKey(A, 'done-k');
      check('F6: completed record never expires (old completed key still duplicate)',
        done.status === 'duplicate' && done.row.message_id === '<done@x>', JSON.stringify(done.status));
    }
    // F1 附带：从已发送删信时，同一 Message-ID 的其他服务器副本
    // 一并删掉（只删 keepUid 之外的 UID），本地行正常移进已删除。
    {
      const a = vdb.prepare(
        `INSERT INTO accounts (email, display_name, password_enc, imap_host, imap_port, imap_secure,
          smtp_host, smtp_port, smtp_secure, enabled, status) VALUES (?,?,?,?,?,?,?,?,?,?, 'offline')`,
      ).run('sweep@163.com', 'SW', encryptSecret('FAKE', key),
        'imap.163.com', 993, 'SSL', 'smtp.163.com', 465, 'SSL', 0);
      const accountId = Number(a.lastInsertRowid);
      const sentF = vdb.prepare("INSERT INTO folders (account_id, path, name, type) VALUES (?, '已发送', '已发送', 'sent')").run(accountId);
      const sentId = Number(sentF.lastInsertRowid);
      const trashF = vdb.prepare("INSERT INTO folders (account_id, path, name, type) VALUES (?, '已删除', '已删除', 'trash')").run(accountId);
      const trashId = Number(trashF.lastInsertRowid);
      const msgInfo = vdb.prepare(`INSERT INTO messages (account_id, folder_id, uid, message_id, subject, from_addr,
        from_name, to_json, date, snippet, is_read, has_attachments, size, flags_json)
        VALUES (?,?,?,?,?,?,?, ?,datetime('now'),'',1,0,100,'[\"\\\\Seen\"]')`).run(
        accountId, sentId, 100, MID, 'sweep test', 'sweep@163.com', 'SW', '[]');
      const msgId = Number(msgInfo.lastInsertRowid);
      const calls = { move: [], flagsAdd: [], deleted: [] };
      const fakeClient = {
        usable: true,
        mailbox: { path: '已发送' },
        mailboxOpen: async (p) => { fakeClient.mailbox = { path: p }; return { uidValidity: undefined, uidNext: undefined, highestModseq: null, exists: 2 }; },
        search: async () => [100, 101],
        fetch: async function* () { yield mkEnv(100, MID); yield mkEnv(101, MID); },
        messageMove: async (uid, target) => { calls.move.push([uid, target]); return { uidMap: new Map([[100, 200]]) }; },
        messageFlagsAdd: async (uid) => { calls.flagsAdd.push(uid); },
        messageDelete: async (uid) => { calls.deleted.push(uid); },
      };
      const engine = new SyncEngine(key);
      engine.states.set(accountId, { client: fakeClient, queue: Promise.resolve(), opFailures: 0 });
      const ok = await engine.deleteMessage(accountId, msgId);
      const rowAfter = vdb.prepare('SELECT folder_id, uid FROM messages WHERE id=?').get(msgId);
      check('F1 sweep: deleting a sent message moves it to trash AND deletes the other server copy (uid 101), not the moved one',
        ok === true
        && calls.move.length === 1 && calls.move[0][0] === '100' && calls.move[0][1] === '已删除'
        && calls.deleted.length === 1 && calls.deleted[0] === '101' && !calls.deleted.includes('100')
        && rowAfter.folder_id === trashId && rowAfter.uid === 200,
        `move=${JSON.stringify(calls.move)} deleted=${JSON.stringify(calls.deleted)} row=${JSON.stringify(rowAfter)}`);
      engine.states.delete(accountId);
    }
  }
} catch (e) {
  console.error('VERIFY ABORTED:', e);
  fail++;
  results.push({ name: 'verify script completed', ok: false, detail: String(e?.message || e) });
} finally {
  try { db?.close(); } catch { /* ignore */ }
  server.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 800));
  if (!server.killed) server.kill('SIGKILL');
}

console.log(`\n==== RESULT: ${pass} passed, ${fail} failed ====`);
if (fail) {
  console.log('server log tail:\n' + serverLog.slice(-2000));
  process.exitCode = 1;
}
// Keep the tmp dir for inspection on failure; remove on success.
if (!fail) fs.rmSync(TMP, { recursive: true, force: true });
else console.log(`tmp dir kept for inspection: ${TMP}`);
