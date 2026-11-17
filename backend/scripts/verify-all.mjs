// luck-mail backend verification script (local only, fake credentials only).
// Usage: npm run build && npm run verify
// Spawns the compiled server (dist/server.js) on a temp DATA_DIR and checks:
//  auth flow, presets, accounts, 163 reachability (IMAP+SMTP, fake creds),
//  streaming parse + DOMPurify, worker-thread parse, FTS5 trigram (+2-char
//  LIKE fallback), AES-256-GCM roundtrip, WAL mode, Socket.io push,
//  bodies on disk, attachment 10 MB rule. Exits non-zero on any failure.
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
  r = await api('GET', '/api/status');
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
  check('unknown domain falls back to imap./smtp. + preset null', r.json?.preset?.preset === null && r.json?.preset?.imapHost === 'imap.unknown-domain-xyz.com');
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
  r = await api('GET', `/api/search?q=${encodeURIComponent('你好世界')}`);
  check('FTS trigram finds 3+ char Chinese term', r.json?.messages?.some((m) => m.id === m1), `total=${r.json?.total}`);
  r = await api('GET', `/api/search?q=${encodeURIComponent('项目')}`);
  check('2-char Chinese term hits via LIKE fallback', r.json?.messages?.some((m) => m.id === m2), `total=${r.json?.total}`);
  r = await api('GET', `/api/messages?view=all-inbox&limit=50`);
  check('all-inbox lists seeded messages', r.json?.total === 2);
  r = await api('GET', `/api/messages/${m1}`);
  check('detail returns body from disk files',
    r.json?.message?.bodyText?.includes('第一封中文测试邮件正文') && r.json?.message?.bodyHtml?.includes('第一封中文测试邮件正文'));
  const atts = r.json?.message?.attachments || [];
  const small = atts.find((a) => a.filename === 'hello.txt');
  const large = atts.find((a) => a.filename === 'big-video.mp4');
  check('attachment meta has size + large flag',
    small?.size === 11 && small?.large === false && large?.size === 15 * 1024 * 1024 && large?.large === true,
    JSON.stringify(atts));
  r = await api('GET', `/api/messages/${m1}/attachments/${Number(attSmall.lastInsertRowid)}`);
  check('cached attachment streams from disk (200)', r.status === 200 && r.text === 'hello world');
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
  const parsed = await streamToParsed(Readable.from([eml]), null, eml.length);
  check('stream parse: Chinese encoded-word subject decoded', parsed.envelope.subject === '你好测试', parsed.envelope.subject);
  check('stream parse: body text correct', parsed.bodyText.includes('你好'));
  check('DOMPurify removed <script>', !parsed.bodyHtml.includes('<script') && !parsed.bodyHtml.includes('alert(1)'));
  check('DOMPurify removed 1x1 tracking pixel but kept normal img',
    !parsed.bodyHtml.includes('p.png') && parsed.bodyHtml.includes('ok.png'));
  check('DOMPurify direct: onerror/js: stripped',
    !sanitizeBodyHtml('<img src=x onerror=alert(1)><a href="javascript:alert(1)">x</a>').includes('onerror')
    && !sanitizeBodyHtml('<a href="javascript:alert(1)">x</a>').includes('javascript:'));

  // ---------- 9. worker-thread parse + 10MB attachment cap ----------
  console.log('== worker parse & 10MB rule ==');
  const bigText = '这是一行很长的中文正文。'.repeat(300000); // ~10.5MB text
  const bigEml = Buffer.from(
    `From: big@163.com\r\nSubject: big test\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${bigText}`,
    'utf8',
  );
  const tmpFile = await spoolToTemp(Readable.from([bigEml]), 999001);
  const workerParsed = await parseInWorker(tmpFile, null, bigEml.length);
  fs.rm(tmpFile, { force: true }, () => {});
  check('worker thread parses >5MB message (subject + body intact)',
    workerParsed.envelope.subject === 'big test' && workerParsed.bodyText.includes('很长的中文正文'));
  // 12MB attachment: must be metadata-only, zero bytes on disk.
  const attData = Buffer.alloc(12 * 1024 * 1024, 0x41);
  const emlBigAtt = Buffer.concat([
    Buffer.from('From: a@163.com\r\nSubject: big attachment\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary="B"\r\n\r\n--B\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nhello\r\n--B\r\nContent-Type: application/octet-stream; name="big.bin"\r\nContent-Transfer-Encoding: base64\r\nContent-Disposition: attachment; filename="big.bin"\r\n\r\n', 'utf8'),
    Buffer.from(attData.toString('base64')),
    Buffer.from('\r\n--B--\r\n', 'utf8'),
  ]);
  const beforeDisk = fs.existsSync(path.join(DATA_DIR, 'attachments', '999002'));
  const parsedBig = await streamToParsed(Readable.from([emlBigAtt]), 999002, emlBigAtt.length);
  const bigAtt = parsedBig.attachments[0];
  const bigAttOnDisk = fs.existsSync(path.join(DATA_DIR, 'attachments', '999002', '1-big.bin'));
  check('>10MB attachment: metadata only, no file on disk',
    bigAtt?.size === 12 * 1024 * 1024 && bigAtt?.cached === false && bigAtt?.large === true && !bigAttOnDisk && !beforeDisk,
    `size=${bigAtt?.size} cached=${bigAtt?.cached}`);
  fs.rmSync(path.join(DATA_DIR, 'attachments', '999002'), { recursive: true, force: true });
  // Small attachment still cached.
  const emlSmallAtt = Buffer.concat([
    Buffer.from('From: a@163.com\r\nSubject: small attachment\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary="B"\r\n\r\n--B\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nhello\r\n--B\r\nContent-Type: text/plain; name="s.txt"\r\nContent-Transfer-Encoding: base64\r\nContent-Disposition: attachment; filename="s.txt"\r\n\r\n', 'utf8'),
    Buffer.from(Buffer.from('small file content').toString('base64')),
    Buffer.from('\r\n--B--\r\n', 'utf8'),
  ]);
  const parsedSmall = await streamToParsed(Readable.from([emlSmallAtt]), 999003, emlSmallAtt.length);
  const smallAtt = parsedSmall.attachments[0];
  check('<=10MB attachment cached to disk',
    smallAtt?.cached === true && fs.existsSync(path.join(DATA_DIR, 'attachments', '999003', '1-s.txt')));
  fs.rmSync(path.join(DATA_DIR, 'attachments', '999003'), { recursive: true, force: true });

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

  // ---------- 12. status / settings ----------
  console.log('== status & settings ==');
  r = await api('GET', '/api/status');
  check('status endpoint ok', r.status === 200 && r.json?.serverTime);
  r = await api('PUT', '/api/settings', { signature: '-- Tester' });
  check('settings save + read back', r.status === 200 && r.json?.settings?.signature === '-- Tester');
  r = await api('GET', '/api/folders');
  check('unknown API path -> 404 JSON', r.status === 404 && r.json?.ok === false);
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
