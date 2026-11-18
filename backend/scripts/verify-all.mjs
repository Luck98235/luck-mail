// luck-mail backend verification script (local only, fake credentials only).
// Usage: npm run build && npm run verify
// Spawns the compiled server (dist/server.js) on a temp DATA_DIR and checks:
//  auth flow, presets, accounts, 163 reachability (IMAP+SMTP, fake creds),
//  streaming parse + DOMPurify, worker-thread parse, FTS5 trigram (+2-char
//  LIKE fallback), AES-256-GCM roundtrip, WAL mode, Socket.io push,
//  bodies on disk, attachments metadata-only. Exits non-zero on any failure.
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import tls from 'node:tls';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import Database from 'better-sqlite3';
import { io as ioClient } from 'socket.io-client';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BACKEND = path.resolve(__dirname, '..');
// Audit #5b：固定端口 18082 并行跑会抢占致误报失败——改动态取空闲端口。
const PORT = await new Promise((resolve, reject) => {
  const probe = net.createServer();
  probe.once('error', reject);
  probe.listen(0, '127.0.0.1', () => {
    const p = probe.address().port;
    probe.close(() => resolve(p));
  });
});
const BASE = `http://127.0.0.1:${PORT}`;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'luck-mail-verify-'));
const DATA_DIR = path.join(TMP, 'data');
const PUBLIC_DIR = path.join(TMP, 'public');

// 第 18 节用的本机 TLS 假 IMAP 证书（自签名，SAN 127.0.0.1）：导入走预设
// imapSecure='SSL'，明文假 IMAP 测不了连通；自签证书 + NODE_EXTRA_CA_CERTS
// 让被测子进程信任它（只影响本次测试进程，不改生产 TLS 校验）。
// openssl 不可用时 tlsFakeOk=false，第 18 节退化为真实 163 坏凭证行。
let tlsFakeOk = false;
let tlsCertPath = '';
let tlsKeyPath = '';
try {
  const tlsDir = path.join(TMP, 'tls');
  fs.mkdirSync(tlsDir, { recursive: true });
  tlsCertPath = path.join(tlsDir, 'srv-cert.pem');
  tlsKeyPath = path.join(tlsDir, 'srv-key.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-keyout', tlsKeyPath,
    '-out', tlsCertPath, '-days', '2', '-nodes', '-subj', '/CN=127.0.0.1',
    '-addext', 'subjectAltName=IP:127.0.0.1'], { stdio: 'ignore' });
  tlsFakeOk = fs.existsSync(tlsCertPath) && fs.existsSync(tlsKeyPath);
} catch { tlsFakeOk = false; }

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

async function waitReady(server, tries = 60) {
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
// Audit #7 LOW-1：启动失败一次后重试——冷启动抖动/端口竞态可能导致首跑
// 误报 "server did not start"（waitReady 窗口）；spawn 加 error 处理并
// 记录退出码/信号，失败时保留 serverLog 供诊断。
let server = null;
let serverLog = '';
let serverExit = null;
function startServer() {
  const srv = spawn('node', ['dist/server.js'], {
    cwd: BACKEND,
    env: { ...process.env, PORT: String(PORT), DATA_DIR, PUBLIC_DIR,
      ...(tlsFakeOk ? { NODE_EXTRA_CA_CERTS: tlsCertPath } : {}) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  srv.stdout.on('data', (d) => { serverLog += d.toString(); });
  srv.stderr.on('data', (d) => { serverLog += d.toString(); });
  srv.on('error', (err) => { serverLog += `[spawn error] ${err.message}\n`; });
  srv.on('exit', (code, signal) => { serverExit = { code, signal }; });
  return srv;
}
server = startServer();
let db = null;

try {
  let started = await waitReady(server);
  if (!started) {
    console.log('server did not start on first try, retrying once...');
    console.log(serverLog);
    if (serverExit) console.log(`first server exited: code=${serverExit.code} signal=${serverExit.signal}`);
    try { server.kill('SIGKILL'); } catch { /* ignore */ }
    serverExit = null;
    server = startServer();
    started = await waitReady(server);
  }
  if (!started) {
    console.log(serverLog);
    if (serverExit) console.log(`server exited: code=${serverExit.code} signal=${serverExit.signal}`);
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
  r = await api('GET', '/api/auth/status');
  check('D6: setup creates a session (logged in immediately, no second login needed)', r.json?.loggedIn === true && r.json?.username === 'tester', JSON.stringify(r.json));
  r = await api('POST', '/api/auth/setup', { username: 'tester', password: 'testpass123', confirm: 'testpass123' });
  check('second setup rejected (409)', r.status === 409);
  // D6: setup 成功后直接建会话（登录态）——下面测 401 要先清掉 setup 发的 Cookie。
  cookie = '';
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

  // Audit #8 LOW-7：标已读 IMAP 不通时本地兜底——假账号连不上 163，
  // 仍返回 200 且本地 is_read 置 1，不再 502。
  r = await api('POST', `/api/messages/${m2}/read`, { read: true });
  const m2Read = db.prepare('SELECT is_read FROM messages WHERE id=?').get(m2).is_read;
  check('audit8 LOW-7: mark-read falls back to local update when IMAP is unreachable (200 + is_read=1)',
    r.status === 200 && m2Read === 1, `status=${r.status} is_read=${m2Read}`);

  // ---------- 7. account test endpoint (fake creds, clear step error) ----------
  console.log('== account test endpoint ==');
  r = await api('POST', `/api/accounts/${accountId}/test`);
  check('test endpoint: imapOk=false + step error (not ok:true lie)',
    r.json?.imapOk === false && typeof r.json?.error === 'string' && r.json.error.includes('IMAP') && r.json.error.includes('认证被拒'),
    JSON.stringify(r.json)?.slice(0, 200));
  // Audit #8 LOW-6（友好性）：同一账号 10 秒内重复测试直接返回上次结果。
  {
    const t0 = Date.now();
    r = await api('POST', `/api/accounts/${accountId}/test`);
    const dt = Date.now() - t0;
    check('audit8 LOW-6: repeat account test within 10s returns cached result (no new login)',
      r.json?.cached === true && r.json?.imapOk === false && dt < 5000,
      `cached=${r.json?.cached} dt=${dt}ms`);
  }

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

  // B5: SMTP 连接池（nodemailer 10.6.0）+ dropTransporter 正常关闭。
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
  // Audit #8 LOW-3：主题/正文全空 -> 400，不走到 SMTP。
  r = await api('POST', '/api/messages/send', {
    accountId: idemAccountId, to: 'x@163.com',
  });
  check('audit8 LOW-3: send with empty subject/text/html -> 400 (no SMTP attempt)',
    r.status === 400 && typeof r.json?.error === 'string',
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
    const mkEnv = (uid, mid, subject = 'F1 test', from = 'a@163.com') => ({
      uid,
      envelope: {
        messageId: mid, subject,
        date: new Date('2026-11-18T10:00:00Z'),
        from: [{ address: from, name: 'A' }], to: [],
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
        fetch: async function* () { yield mkEnv(100, MID, 'sweep test', 'sweep@163.com'); yield mkEnv(101, MID, 'sweep test', 'sweep@163.com'); },
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
    // Audit #8 LOW-8：同 Message-ID 但主题/发件人不同的信不是副本，清扫时不动它。
    {
      const MID8 = '<sweep-verify-8@x>';
      const a = vdb.prepare(
        `INSERT INTO accounts (email, display_name, password_enc, imap_host, imap_port, imap_secure,
          smtp_host, smtp_port, smtp_secure, enabled, status) VALUES (?,?,?,?,?,?,?,?,?,?, 'offline')`,
      ).run('sweep8@163.com', 'S8', encryptSecret('FAKE', key),
        'imap.163.com', 993, 'SSL', 'smtp.163.com', 465, 'SSL', 0);
      const accountId = Number(a.lastInsertRowid);
      const sentF = vdb.prepare("INSERT INTO folders (account_id, path, name, type) VALUES (?, '已发送', '已发送', 'sent')").run(accountId);
      const sentId = Number(sentF.lastInsertRowid);
      const trashF = vdb.prepare("INSERT INTO folders (account_id, path, name, type) VALUES (?, '已删除', '已删除', 'trash')").run(accountId);
      const trashId = Number(trashF.lastInsertRowid);
      const msgInfo = vdb.prepare(`INSERT INTO messages (account_id, folder_id, uid, message_id, subject, from_addr,
        from_name, to_json, date, snippet, is_read, has_attachments, size, flags_json)
        VALUES (?,?,?,?,?,?,?, ?,datetime('now'),'',1,0,100,'[\"\\\\Seen\"]')`).run(
        accountId, sentId, 100, MID8, 'real subject', 'real@163.com', 'R8', '[]');
      const msgId = Number(msgInfo.lastInsertRowid);
      const calls = { move: [], deleted: [] };
      const fakeClient = {
        usable: true,
        mailbox: { path: '已发送' },
        mailboxOpen: async (p) => { fakeClient.mailbox = { path: p }; return { uidValidity: undefined, uidNext: undefined, highestModseq: null, exists: 2 }; },
        search: async () => [100, 101],
        fetch: async function* () {
          yield mkEnv(100, MID8, 'real subject', 'real@163.com');
          yield mkEnv(101, MID8, 'DIFFERENT subject', 'other@163.com');
        },
        messageMove: async (uid, target) => { calls.move.push([uid, target]); return { uidMap: new Map([[100, 200]]) }; },
        messageFlagsAdd: async (uid) => { /* not used here */ },
        messageDelete: async (uid) => { calls.deleted.push(uid); },
      };
      const engine = new SyncEngine(key);
      engine.states.set(accountId, { client: fakeClient, queue: Promise.resolve(), opFailures: 0 });
      const ok = await engine.deleteMessage(accountId, msgId);
      const rowAfter = vdb.prepare('SELECT folder_id, uid FROM messages WHERE id=?').get(msgId);
      check('audit8 LOW-8: sweep skips same-Message-ID mail with different subject/from (not a copy)',
        ok === true && calls.move.length === 1 && calls.deleted.length === 0
        && rowAfter.folder_id === trashId && rowAfter.uid === 200,
        `move=${JSON.stringify(calls.move)} deleted=${JSON.stringify(calls.deleted)} row=${JSON.stringify(rowAfter)}`);
      engine.states.delete(accountId);
    }
  }
  // ---------- 15. audit #5 backend fixes ----------
  console.log('== audit #5 fixes ==');
  const { openDb } = await import('../dist/db.js');
  const vdb = openDb();

  // 1: CSRF——备份/导出只接受 POST；Cookie SameSite=Strict。
  r = await api('GET', '/api/backup/download');
  check('S1: GET /api/backup/download -> 404 (POST only)', r.status === 404, `status=${r.status}`);
  r = await api('GET', '/api/accounts/export');
  check('S1: GET /api/accounts/export -> 404 (POST only)', r.status === 404, `status=${r.status}`);
  r = await api('POST', '/api/backup/download');
  check('S1: POST /api/backup/download -> 200', r.status === 200, `status=${r.status}`);
  {
    const loginRes = await fetch(BASE + '/api/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'tester', password: 'testpass123' }),
    });
    const sc = loginRes.headers.get('set-cookie') || '';
    check('S1: session cookie SameSite=Strict + HttpOnly', /SameSite=Strict/i.test(sc) && /HttpOnly/i.test(sc), sc.slice(0, 140));
  }

  // 24: /api 响应 no-store。
  r = await api('GET', '/api/accounts');
  check('D1: /api responses carry Cache-Control: no-store', r.headers.get('cache-control') === 'no-store', String(r.headers.get('cache-control')));

  // 21: 健康检查端点（无需登录）。
  {
    const savedCookie = cookie;
    cookie = '';
    const hr = await api('GET', '/api/health');
    check('health: GET /api/health -> 200 {ok, db} without login (no accountsOnline leak)',
      hr.status === 200 && hr.json?.ok === true && hr.json?.db === 'ok' && !('accountsOnline' in (hr.json || {})),
      `status=${hr.status} body=${JSON.stringify(hr.json)}`);
    cookie = savedCookie;
  }

  // 2: 会话过期按 SQLite datetime 比较（过期 1 小时的行不再有效；旧 ISO 格式同理）。
  {
    const userRow = vdb.prepare("SELECT id FROM users WHERE username='tester'").get();
    const mkToken = (expiresAt) => {
      const tok = crypto.randomBytes(32).toString('hex');
      const hash = crypto.createHash('sha256').update(tok).digest('hex');
      vdb.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?,?,?)').run(hash, userRow.id, expiresAt);
      return tok;
    };
    const fmt = (d) => d.toISOString().slice(0, 19).replace('T', ' ');
    const savedCookie = cookie;
    cookie = `lm_session=${mkToken(fmt(new Date(Date.now() - 3600e3)))}`;
    r = await api('GET', '/api/auth/status');
    check('S2: session expired 1h ago (SQLite datetime) is NOT valid', r.json?.loggedIn === false, JSON.stringify(r.json));
    cookie = `lm_session=${mkToken(new Date(Date.now() - 3600e3).toISOString())}`;
    r = await api('GET', '/api/auth/status');
    check('S2: legacy ISO-format expired session is NOT valid either', r.json?.loggedIn === false, JSON.stringify(r.json));
    cookie = `lm_session=${mkToken(fmt(new Date(Date.now() + 3600e3)))}`;
    r = await api('GET', '/api/auth/status');
    check('S2: session expiring in 1h IS valid', r.json?.loggedIn === true, JSON.stringify(r.json));
    cookie = savedCookie;
  }

  // 3: rememberMe 缺省 = 1 天；明确 true = 30 天（SQLite julianday 差值，时区无关）。
  {
    await api('POST', '/api/auth/login', { username: 'tester', password: 'testpass123' });
    const h1 = vdb.prepare("SELECT (julianday(expires_at) - julianday('now')) * 24 AS h FROM sessions ORDER BY id DESC LIMIT 1").get().h;
    check('S3: login without rememberMe -> ~1 day session', h1 > 23 && h1 < 25, `hours=${h1.toFixed(2)}`);
    await api('POST', '/api/auth/login', { username: 'tester', password: 'testpass123', rememberMe: true });
    const h2 = vdb.prepare("SELECT (julianday(expires_at) - julianday('now')) * 24 AS h FROM sessions ORDER BY id DESC LIMIT 1").get().h;
    check('S3: login with rememberMe=true -> ~30 day session', h2 > 719 && h2 < 721, `hours=${h2.toFixed(2)}`);
  }

  // D7: 锁过期后一次正确登录即解锁（不再“一错就再锁 15 分钟”）。
  {
    vdb.prepare("UPDATE users SET failed_attempts=5, locked_until=datetime('now','-1 minute') WHERE username='tester'").run();
    r = await api('POST', '/api/auth/login', { username: 'tester', password: 'testpass123' });
    const row = vdb.prepare("SELECT failed_attempts, locked_until FROM users WHERE username='tester'").get();
    check('D7: login succeeds after lock expired and resets failed_attempts/lock',
      r.status === 200 && row.failed_attempts === 0 && row.locked_until === null,
      `status=${r.status} row=${JSON.stringify(row)}`);
  }

  // 8: 163 轮询判定 + _pollAllFolders 存在；QQ 不走轮询。
  {
    const { isNetEaseHost, SyncEngine } = await import('../dist/engine.js');
    check('R1: isNetEaseHost matches 163/126/yeah/188, not QQ/Gmail',
      isNetEaseHost('imap.163.com') && isNetEaseHost('imap.126.com')
      && isNetEaseHost('imap.yeah.net') && isNetEaseHost('imap.188.com')
      && !isNetEaseHost('imap.qq.com') && !isNetEaseHost('imap.gmail.com'));
    check('R1: SyncEngine has _pollAllFolders (163 polling path)',
      typeof SyncEngine.prototype._pollAllFolders === 'function');
    // QQ 兜底全文件夹同步：_pollAllFolders 在 IDLE 连接（usable）上跑时，
    // 非收件箱文件夹也要同步进来，且结束后连接必须重选回收件箱
    // （否则 auto-IDLE 改盯最后同步的文件夹，收件箱不再实时）。
    {
      const a = vdb.prepare(
        `INSERT INTO accounts (email, display_name, password_enc, imap_host, imap_port, imap_secure,
          smtp_host, smtp_port, smtp_secure, enabled, status) VALUES (?,?,?,?,?,?,?,?,?,?, 'offline')`,
      ).run('qqpoll@qq.com', 'QP', encryptSecret('FAKE', key),
        'imap.qq.com', 993, 'SSL', 'smtp.qq.com', 465, 'SSL', 0);
      const accountId = Number(a.lastInsertRowid);
      vdb.prepare("INSERT INTO folders (account_id, path, name, type) VALUES (?, 'INBOX', '收件箱', 'inbox')").run(accountId);
      const fs2 = vdb.prepare("INSERT INTO folders (account_id, path, name, type) VALUES (?, '已发送', '已发送', 'sent')").run(accountId);
      const sentId = Number(fs2.lastInsertRowid);
      const fakeList = [
        { path: 'INBOX', name: 'INBOX', delimiter: '/', specialUse: '\\Inbox', flags: new Set(['\\HasNoChildren']), children: [] },
        { path: '已发送', name: '已发送', delimiter: '/', specialUse: '\\Sent', flags: new Set(['\\HasNoChildren']), children: [] },
      ];
      let selected = null;
      const fakeClient = {
        usable: true,
        mailbox: null,
        list: async () => fakeList,
        mailboxOpen: async (p) => {
          selected = p;
          fakeClient.mailbox = { path: p };
          return { uidValidity: undefined, uidNext: undefined, highestModseq: null, exists: p === '已发送' ? 1 : 0 };
        },
        search: async () => (selected === '已发送' ? [201] : []),
        fetch: async function* () {
          if (selected === '已发送') {
            yield {
              uid: 201,
              envelope: {
                messageId: '<qqpoll-sent@qq.com>', subject: 'QQ poll sent',
                date: new Date('2026-11-18T10:00:00Z'),
                from: [{ address: 'qqpoll@qq.com', name: 'QP' }], to: [],
              },
              flags: ['\\Seen'],
              bodyStructure: null,
              size: 100,
              internalDate: new Date('2026-11-18T10:00:00Z'),
              bodyParts: new Map([['TEXT', Buffer.from('plain snippet hello world')]]),
            };
          }
        },
      };
      const engine = new SyncEngine(key);
      engine.states.set(accountId, { client: fakeClient, queue: Promise.resolve(), opFailures: 0 });
      await engine._pollAllFolders(accountId);
      const sentRows = vdb.prepare('SELECT COUNT(*) c FROM messages WHERE folder_id=?').get(sentId).c;
      check('QQ fallback: _pollAllFolders syncs a non-inbox folder (Sent) on the IDLE connection',
        sentRows === 1, `sentRows=${sentRows}`);
      check('QQ fallback: connection is re-selected to INBOX after the poll (IDLE keeps watching INBOX)',
        fakeClient.mailbox && fakeClient.mailbox.path === 'INBOX', `mailbox=${JSON.stringify(fakeClient.mailbox)}`);
    }
  }

  // Audit #8 HIGH-1 / MED-1 / LOW-1（友好性）：认证失败停连 + 网易只靠轮询重试 + 限流识别。
  {
    const { SyncEngine } = await import('../dist/engine.js');
    const { isThrottleError } = await import('../dist/imapUtil.js');
    check('audit8 LOW-1: isThrottleError matches 421/451/too-many-connections, not auth errors',
      isThrottleError(new Error('451 too much fail authentication'))
      && isThrottleError(new Error('421 HL:ICC too many connections'))
      && isThrottleError(new Error('Too many connections from your IP'))
      && !isThrottleError(new Error('Invalid login'))
      && !isThrottleError(new Error('connection timed out')));
    const h1 = vdb.prepare(
      `INSERT INTO accounts (email, display_name, password_enc, imap_host, imap_port, imap_secure,
        smtp_host, smtp_port, smtp_secure, enabled, status) VALUES (?,?,?,?,?,?,?,?,?,?, 'offline')`,
    ).run('h1@163.com', 'H1', encryptSecret('FAKE', key),
      'imap.163.com', 993, 'SSL', 'smtp.163.com', 465, 'SSL', 0);
    const h1Id = Number(h1.lastInsertRowid);
    vdb.prepare("INSERT INTO folders (account_id, path, name, type) VALUES (?, 'INBOX', '收件箱', 'inbox')").run(h1Id);
    // HIGH-1(b)：authFailed 时 _pollAllFolders 直接返回，不调 withClient（不登录）。
    const engineH1 = new SyncEngine(key);
    let withClientCalls = 0;
    engineH1.withClient = async (...args) => { withClientCalls++; throw new Error('must not be called'); };
    engineH1.states.set(h1Id, { authFailed: true, pollOnly: true, connecting: false, queue: Promise.resolve() });
    await engineH1._pollAllFolders(h1Id);
    check('audit8 HIGH-1: _pollAllFolders returns early when authFailed (no IMAP login attempt)',
      withClientCalls === 0, `withClientCalls=${withClientCalls}`);
    // HIGH-1(c)：authFailed 时 _withSharedClient 直接抛认证失败，不建连。
    const engineH1c = new SyncEngine(key);
    engineH1c.states.set(h1Id, { authFailed: true, pollOnly: true, connecting: false, queue: Promise.resolve(), client: null, sharedClient: null });
    let threwAuth = false;
    try { await engineH1c.withClient(h1Id, async () => 'should-not-run'); } catch (e) { threwAuth = /认证失败/.test(String(e?.message || e)); }
    check('audit8 HIGH-1: _withSharedClient throws auth error without connecting when authFailed',
      threwAuth === true);
    // MED-1：网易轮询账号不走重连循环——_scheduleReconnect 不设 timer。
    const engineM1 = new SyncEngine(key);
    const stM1 = { authFailed: false, pollOnly: true, timer: null, backoffMs: 5000 };
    engineM1.states.set(h1Id, stM1);
    engineM1._scheduleReconnect(h1Id);
    check('audit8 MED-1: _scheduleReconnect does nothing for pollOnly accounts (poll timer is the only retry)',
      stM1.timer === null || stM1.timer === undefined);
    // 对照：非轮询账号仍会设重连 timer。
    const engineM1b = new SyncEngine(key);
    const stM1b = { authFailed: false, pollOnly: false, timer: null, backoffMs: 5000 };
    engineM1b.states.set(h1Id, stM1b);
    engineM1b._scheduleReconnect(h1Id);
    const scheduled = stM1b.timer !== null && stM1b.timer !== undefined;
    if (stM1b.timer) clearTimeout(stM1b.timer);
    check('audit8 MED-1 control: _scheduleReconnect still schedules for non-poll accounts', scheduled);
  }

  // 9: 同步删除对账时正文孤儿文件一并删。
  {
    const { SyncEngine } = await import('../dist/engine.js');
    const { indexMessageFts } = await import('../dist/db.js');
    const acc9 = vdb.prepare(
      `INSERT INTO accounts (email, display_name, password_enc, imap_host, imap_port, imap_secure,
        smtp_host, smtp_port, smtp_secure, enabled, status) VALUES (?,?,?,?,?,?,?,?,?,?, 'offline')`,
    ).run('orphan9@163.com', 'O9', encryptSecret('FAKE', key),
      'imap.163.com', 993, 'SSL', 'smtp.163.com', 465, 'SSL', 0);
    const acc9Id = Number(acc9.lastInsertRowid);
    const f9 = vdb.prepare("INSERT INTO folders (account_id, path, name, type) VALUES (?, 'INBOX', '收件箱', 'inbox')").run(acc9Id);
    const f9Id = Number(f9.lastInsertRowid);
    const f9Row = vdb.prepare('SELECT * FROM folders WHERE id=?').get(f9Id);
    const m9 = vdb.prepare(
      `INSERT INTO messages (account_id, folder_id, uid, message_id, subject, from_addr, to_json, date,
        snippet, body_path, is_read, has_attachments, size, flags_json)
       VALUES (?,?,?,?,?,?,?,?,?,NULL,0,0,123,'[]')`,
    ).run(acc9Id, f9Id, 777, '<orphan9@x>', 'orphan body', 'a@163.com', '[]', new Date().toISOString(), 'orphan');
    const m9Id = Number(m9.lastInsertRowid);
    fs.mkdirSync(path.join(DATA_DIR, 'bodies'), { recursive: true });
    fs.writeFileSync(path.join(DATA_DIR, 'bodies', `${m9Id}.html`), '<p>orphan</p>');
    fs.writeFileSync(path.join(DATA_DIR, 'bodies', `${m9Id}.txt`), 'orphan');
    vdb.prepare('UPDATE messages SET body_path=? WHERE id=?').run(`bodies/${m9Id}.html`, m9Id);
    indexMessageFts(m9Id, 'orphan body', 'a@163.com', 'orphan');
    const fakeClient9 = {
      mailboxOpen: async () => ({ uidValidity: undefined, uidNext: undefined, highestModseq: null, exists: 0 }),
      search: async () => [],
      fetch: async function* () { /* no server messages */ },
    };
    const engine9 = new SyncEngine(key);
    await engine9._syncFolder(fakeClient9, acc9Id, f9Row);
    const rowGone = vdb.prepare('SELECT COUNT(*) c FROM messages WHERE id=?').get(m9Id).c === 0;
    const ftsGone = vdb.prepare('SELECT COUNT(*) c FROM messages_fts WHERE rowid=?').get(m9Id).c === 0;
    const filesGone = !fs.existsSync(path.join(DATA_DIR, 'bodies', `${m9Id}.html`))
      && !fs.existsSync(path.join(DATA_DIR, 'bodies', `${m9Id}.txt`));
    check('R2: sync reconciliation deletes the row + FTS row + body files (html+txt)',
      rowGone && ftsGone && filesGone, `row=${rowGone} fts=${ftsGone} files=${filesGone}`);
  }

  // 17: 唯一约束 + 20: FTS 空词不 500。
  {
    const idx = vdb.prepare('PRAGMA index_list(messages)').all();
    const hasIdx = idx.some((x) => x.name === 'idx_messages_account_folder_mid' && x.unique === 1);
    let dupThrew = false;
    try {
      const ins = vdb.prepare(
        `INSERT INTO messages (account_id, folder_id, uid, message_id, subject, from_addr, to_json, date,
          snippet, body_path, is_read, has_attachments, size, flags_json)
         VALUES (?,?,?,?,?,?,?,?,?,NULL,0,0,1,'[]')`,
      );
      ins.run(accountId, folderId, 424242, '<dup-mid@x>', 'dup1', 'a@163.com', '[]', new Date().toISOString(), 'd');
      ins.run(accountId, folderId, 424243, '<dup-mid@x>', 'dup2', 'a@163.com', '[]', new Date().toISOString(), 'd');
    } catch (e) {
      dupThrew = String(e?.message || e).includes('UNIQUE constraint failed');
    }
    check('L4: UNIQUE(account_id, folder_id, message_id) index exists and rejects duplicates',
      hasIdx && dupThrew, `index=${hasIdx} threw=${dupThrew}`);
  }
  // Audit #8 MED-1 / LOW-2 / LOW-6（数据库）：新索引存在 + 三处热查询走 SEARCH。
  {
    const { openDb } = await import('../dist/db.js');
    const vdb2 = openDb();
    const idxList = (table) => vdb2.prepare(`PRAGMA index_list(${table})`).all().map((x) => x.name);
    const msgIdx = idxList('messages');
    const attIdx = idxList('attachments');
    const tombIdx = idxList('deleted_messages');
    const delKeyIdx = idxList('delete_idempotency');
    check('audit8 MED-1: idx_messages_folder_uid_read exists',
      msgIdx.includes('idx_messages_folder_uid_read'), msgIdx.join(','));
    check('audit8 LOW-2: idx_attachments_message_id exists',
      attIdx.includes('idx_attachments_message_id'), attIdx.join(','));
    check('audit8 LOW-6: prune indexes exist (deleted_messages.deleted_at, delete_idempotency.created_at)',
      tombIdx.includes('idx_deleted_messages_deleted_at') && delKeyIdx.includes('idx_delete_idempotency_created_at'),
      `tomb=${tombIdx.join(',')} delkey=${delKeyIdx.join(',')}`);
    const plan = (sql) => vdb2.prepare(`EXPLAIN QUERY PLAN ${sql}`).all().map((r) => r.detail).join(' | ');
    const p1 = plan('SELECT id, uid FROM messages WHERE folder_id=1');
    const p2 = plan('SELECT id, uid, is_read FROM messages WHERE folder_id=1');
    const p3 = plan("SELECT COUNT(*) total, COALESCE(SUM(CASE WHEN is_read=0 THEN 1 ELSE 0 END),0) unread FROM messages WHERE folder_id=1");
    check('audit8 MED-1: UID diff / flags / counts use SEARCH on idx_messages_folder_uid_read (no SCAN)',
      p1.includes('SEARCH messages USING COVERING INDEX idx_messages_folder_uid_read')
      && p2.includes('SEARCH messages USING COVERING INDEX idx_messages_folder_uid_read')
      && p3.includes('SEARCH messages USING COVERING INDEX idx_messages_folder_uid_read'),
      `p1=${p1} p2=${p2} p3=${p3}`);
  }
  r = await api('GET', '/api/messages?' + new URLSearchParams({ q: '""' }));
  check('D4: search with only quotes does not 500', r.status === 200 && Array.isArray(r.json?.messages), `status=${r.status}`);
  r = await api('GET', '/api/messages?' + new URLSearchParams({ q: '"' }));
  check('D4: search with a single quote does not 500', r.status === 200 && Array.isArray(r.json?.messages), `status=${r.status}`);

  // 依赖版本（5/6/7）：multer 2.0.1、nodemailer 10.6.0、imapflow 2.12.1。
  {
    const pkg = JSON.parse(fs.readFileSync(path.join(BACKEND, 'package.json'), 'utf8'));
    const depVer = (name) => String(pkg.dependencies?.[name] || '').replace(/^\^/, '');
    check('deps: multer 2.0.1 / nodemailer 10.6.0 / imapflow 2.12.1 in package.json',
      depVer('multer') === '2.0.1'
      && depVer('nodemailer') === '10.6.0'
      && depVer('imapflow') === '2.12.1',
      JSON.stringify({ m: depVer('multer'), n: depVer('nodemailer'), i: depVer('imapflow') }));
    const lock = JSON.parse(fs.readFileSync(path.join(BACKEND, 'package-lock.json'), 'utf8'));
    const lv = (name) => lock.packages?.[`node_modules/${name}`]?.version;
    check('deps: package-lock.json matches (multer/nodemailer/imapflow)',
      lv('multer') === '2.0.1' && lv('nodemailer') === '10.6.0' && lv('imapflow') === '2.12.1',
      JSON.stringify({ m: lv('multer'), n: lv('nodemailer'), i: lv('imapflow') }));
  }

  // 28: CSV 导入 + 模板 + xlsx 拒绝。
  async function apiMultipart(p, fileName, content, mime = 'text/csv') {
    const fd = new FormData();
    fd.append('file', new Blob([content], { type: mime }), fileName);
    const res = await fetch(BASE + p, { method: 'POST', headers: { Cookie: cookie }, body: fd });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* non-JSON */ }
    return { status: res.status, json, text, headers: res.headers };
  }
  {
    // 注：fetch 的 text() 会按 Encoding 规范吞掉 UTF-8 BOM，所以 BOM
    // 须按原始字节验（EF BB BF），不能用 text().charCodeAt(0)。
    const tplRes = await fetch(BASE + '/api/accounts/import-template', { headers: { Cookie: cookie } });
    const tplBuf = new Uint8Array(await tplRes.arrayBuffer());
    const tplText = new TextDecoder('utf-8').decode(tplBuf);
    const hasBom = tplBuf[0] === 0xef && tplBuf[1] === 0xbb && tplBuf[2] === 0xbf;
    check('CSV: import-template returns text/csv + luck-mail-import-template.csv + BOM + 8 headers',
      tplRes.status === 200
      && String(tplRes.headers.get('content-type') || '').includes('text/csv')
      && String(tplRes.headers.get('content-disposition') || '').includes('luck-mail-import-template.csv')
      && hasBom
      && tplText.includes('序号,邮箱名,授权码,接收服务器（IMAP）,IMAP端口,发送服务器（SMTP）,SMTP端口,备注'),
      `status=${tplRes.status} ct=${tplRes.headers.get('content-type')} bom=${hasBom} body=${tplText.slice(0, 60)}`);
    const csv = '\uFEFF序号,邮箱名,授权码,接收服务器（IMAP）,IMAP端口,发送服务器（SMTP）,SMTP端口,备注\r\n'
      + '1,csv1@163.com,CODE1,imap.163.com,993,smtp.163.com,465,普通\r\n'
      + '2,"csv2@163.com","CO,DE2",imap.163.com,993,smtp.163.com,465,"带,逗号"\r\n'
      + '3,CSV1@163.com,CODE1X,imap.163.com,993,smtp.163.com,465,重复\r\n'
      + '4,bad-email,CODE,imap.163.com,993,smtp.163.com,465,x\r\n'
      + '5,csv5@unknown-domain-xyz.com,CODE5,,,,,x\r\n'
      + '6,csv6@163.com,CODE6,imap.163.com,993,smtp.163.com,465,"多行\n备注"\r\n';
    const imp = await apiMultipart('/api/accounts/import', 'import.csv', csv);
    // 导入先测连通再入库：这里 4 行格式有效但凭据是假的，真 163 全部认证拒绝，
    // 所以 added=0、failed=5（4 行认证失败 + 1 行格式错）；重复行仍在测连通
    // 之前判重跳过（skipped=1）。引号逗号/引号换行/未知域名行的解析仍被覆盖——
    // 它们都以正确邮箱名出现在 failed 里（不是解析失败）。
    check('CSV: import tests connectivity first — fake creds rejected (added 0), skips 1 dup, fails 5',
      imp.status === 200 && imp.json?.added === 0 && imp.json?.skipped === 1 && imp.json?.failed?.length === 5
      && (imp.json.failed.filter((f) => /用户名或密码\/授权码不正确/.test(f.reason || '')).length === 3)
      && (imp.json.failed.find((f) => f.email === 'csv5@unknown-domain-xyz.com')?.reason || '').includes('IMAP 连接失败'),
      `status=${imp.status} body=${JSON.stringify(imp.json)}`);
    // 清理：本轮应无 csv* 账号入库（都进 failed）；以防万一仍删一遍
    // （API 删除会停 engine，避免假账号连真实 163）。
    const listAfter = await api('GET', '/api/accounts');
    const csvIds = (listAfter.json?.accounts || []).filter((a) => a.email.startsWith('csv')).map((a) => a.id);
    for (const id of csvIds) await api('DELETE', `/api/accounts/${id}`);
    const listClean = await api('GET', '/api/accounts');
    check('CSV: imported accounts cleaned up via API delete',
      !(listClean.json?.accounts || []).some((a) => a.email.startsWith('csv')), `left=${csvIds.length}`);
    const xlsx = await apiMultipart('/api/accounts/import', 'old.xlsx',
      new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    check('CSV: xlsx file rejected with a clear CSV message (400)',
      xlsx.status === 400 && typeof xlsx.json?.error === 'string' && xlsx.json.error.includes('CSV'),
      `status=${xlsx.status} error=${xlsx.json?.error}`);
  }

  // ---------- 16. drafts API + fake-SMTP send ----------
  console.log('== drafts API ==');
  // 草稿 CRUD（用第 5 节种子账号 accountId，存在即可）。
  r = await api('POST', '/api/drafts', { accountId: 999999, to: 'x@163.com', subject: 'bad', text: '' });
  check('drafts: POST with unknown accountId -> 400', r.status === 400, `status=${r.status}`);
  r = await api('POST', '/api/drafts', { accountId, to: 'a@163.com', subject: 'first', text: 'hello' });
  const draft1 = r.json?.draft;
  check('drafts: POST creates draft, server generates idempotencyKey when missing',
    r.status === 201 && typeof draft1?.id === 'number' && typeof draft1?.idempotencyKey === 'string' && draft1.idempotencyKey.length > 0
    && draft1.to === 'a@163.com' && draft1.subject === 'first',
    `status=${r.status} draft=${JSON.stringify(draft1)}`);
  r = await api('POST', '/api/drafts', { accountId, to: 'b@163.com', subject: 'second', text: 'world', idempotencyKey: 'draft-key-1' });
  const draft2 = r.json?.draft;
  check('drafts: POST keeps a caller-provided idempotencyKey',
    r.status === 201 && draft2?.idempotencyKey === 'draft-key-1', `status=${r.status}`);
  r = await api('GET', '/api/drafts');
  check('drafts: GET lists both, newest first (updatedAt DESC, id DESC)',
    r.status === 200 && Array.isArray(r.json?.drafts) && r.json.drafts.length >= 2
    && r.json.drafts[0].id === draft2.id && r.json.drafts.some((d) => d.id === draft1.id),
    `count=${r.json?.drafts?.length} first=${r.json?.drafts?.[0]?.id}`);
  r = await api('PUT', `/api/drafts/${draft2.id}`, { to: 'new@163.com', idempotencyKey: 'HACKED' });
  check('drafts: PUT updates fields but idempotencyKey never changes',
    r.status === 200 && r.json?.draft?.to === 'new@163.com' && r.json?.draft?.idempotencyKey === 'draft-key-1',
    `status=${r.status} draft=${JSON.stringify(r.json?.draft)}`);
  r = await api('PUT', '/api/drafts/999999', { to: 'x@163.com' });
  check('drafts: PUT unknown id -> 404', r.status === 404, `status=${r.status}`);
  r = await api('DELETE', '/api/drafts/999999');
  check('drafts: DELETE unknown id -> 404', r.status === 404, `status=${r.status}`);
  r = await api('DELETE', `/api/drafts/${draft1.id}`);
  check('drafts: DELETE removes the draft', r.status === 200, `status=${r.status}`);
  r = await api('GET', '/api/drafts');
  check('drafts: deleted draft is gone from the list',
    !(r.json?.drafts || []).some((d) => d.id === draft1.id) && (r.json?.drafts || []).some((d) => d.id === draft2.id));

  // 发信删草稿：本地假 SMTP（nodemailer 10.x + MailComposer 真实走一遍）。
  // 假 SMTP 只认 PLAIN/LOGIN + MAIL/RCPT/DATA/QUIT；不通告 STARTTLS，
  // 账号用 smtp_secure='STARTTLS'（secure=false，走明文）。
  let fakeSmtp = null;
  let fakePort = 0;
  let gotMail = false;
  let lastRaw = '';
  try {
    fakeSmtp = await new Promise((resolve, reject) => {
      const sockets = new Set();
      const srv = net.createServer((socket) => {
        sockets.add(socket);
        socket.on('close', () => sockets.delete(socket));
        let buf = '';
        let dataMode = false;
        let authStep = 0; // 0 idle, 1 await user, 2 await pass
        socket.write('220 localhost fake SMTP\r\n');
        socket.on('data', (chunk) => {
          buf += chunk.toString('utf8');
          let idx;
          while ((idx = buf.indexOf('\r\n')) >= 0) {
            const line = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            if (dataMode) {
              if (line === '.') { dataMode = false; gotMail = true; socket.write('250 OK: queued\r\n'); }
              else lastRaw += line + '\r\n';
              continue;
            }
            const up = line.toUpperCase();
            if (up.startsWith('EHLO') || up.startsWith('HELO')) socket.write('250-localhost\r\n250 AUTH LOGIN PLAIN\r\n');
            else if (up.startsWith('AUTH PLAIN')) { authStep = 0; socket.write('235 OK\r\n'); }
            else if (up.startsWith('AUTH LOGIN')) { authStep = 1; socket.write('334 VXNlcm5hbWU6\r\n'); }
            else if (authStep === 1) { authStep = 2; socket.write('334 UGFzc3dvcmQ6\r\n'); }
            else if (authStep === 2) { authStep = 0; socket.write('235 OK\r\n'); }
            else if (up.startsWith('MAIL FROM:')) socket.write('250 OK\r\n');
            else if (up.startsWith('RCPT TO:')) socket.write('250 OK\r\n');
            else if (up === 'DATA') { dataMode = true; lastRaw = ''; socket.write('354 Go ahead\r\n'); }
            else if (up === 'RSET' || up === 'NOOP') socket.write('250 OK\r\n');
            else if (up === 'QUIT') { socket.write('221 Bye\r\n'); socket.end(); }
            else socket.write('250 OK\r\n');
          }
        });
      });
      srv.on('error', reject);
      srv.listen(0, '127.0.0.1', () => {
        srv._sockets = sockets;
        resolve(srv);
      });
    });
    fakePort = fakeSmtp.address().port;
    const smtpAcc = vdb.prepare(
      `INSERT INTO accounts (email, display_name, password_enc, imap_host, imap_port, imap_secure,
        smtp_host, smtp_port, smtp_secure, enabled, status) VALUES (?,?,?,?,?,?,?,?,?,?, 'offline')`,
    ).run('draftsend@163.com', 'DraftSend', encryptSecret('FAKEPASS', key),
      '127.0.0.1', 9999, 'SSL', '127.0.0.1', fakePort, 'STARTTLS', 1);
    const smtpAccId = Number(smtpAcc.lastInsertRowid);
    r = await api('POST', '/api/drafts', { accountId: smtpAccId, to: 'x@163.com', subject: 'draft send', text: 'hi' });
    const sendDraft = r.json?.draft;
    r = await api('POST', '/api/messages/send', {
      accountId: smtpAccId, to: 'x@163.com', subject: 'draft send', text: 'hi', draftId: sendDraft?.id,
      inReplyTo: '<orig@x>', references: '<a@x> <b@x>',
    });
    check('drafts: send succeeds via fake SMTP (201) and the fake server got the DATA',
      r.status === 201 && gotMail, `status=${r.status} gotMail=${gotMail} body=${JSON.stringify(r.json)?.slice(0, 160)}`);
    check('threading: sent mail carries In-Reply-To + References headers',
      lastRaw.includes('In-Reply-To: <orig@x>') && lastRaw.includes('References: <a@x> <b@x>'),
      `raw-head=${lastRaw.split('\r\n').slice(0, 12).join(' | ')}`);
    r = await api('GET', '/api/drafts');
    check('drafts: draft is deleted after successful send',
      !(r.json?.drafts || []).some((d) => d.id === sendDraft?.id), `left=${JSON.stringify((r.json?.drafts || []).map((d) => d.id))}`);
    // 发信失败保留草稿：idemtest 账号走真实 smtp.163.com，假凭据 -> 502。
    // （草稿归属 idemAccountId——发信账号与草稿账号必须一致，见 5b-4。）
    r = await api('POST', '/api/drafts', { accountId: idemAccountId, to: 'y@163.com', subject: 'keep me', text: 'hi' });
    const keepDraft = r.json?.draft;
    r = await api('POST', '/api/messages/send', {
      accountId: idemAccountId, to: 'x@163.com', subject: 'will fail', text: 'hi', draftId: keepDraft?.id,
    });
    check('drafts: send failure (502) keeps the draft',
      r.status === 502, `status=${r.status}`);
    r = await api('GET', '/api/drafts');
    check('drafts: failed-send draft still listed',
      (r.json?.drafts || []).some((d) => d.id === keepDraft?.id));
    // 级联：删账号时其草稿一并删（FK ON DELETE CASCADE）。
    r = await api('DELETE', `/api/accounts/${smtpAccId}`);
    const leftDrafts = vdb.prepare('SELECT COUNT(*) c FROM drafts WHERE account_id=?').get(smtpAccId).c;
    check('drafts: deleting the account cascade-deletes its drafts',
      r.status === 200 && leftDrafts === 0, `status=${r.status} left=${leftDrafts}`);
    const { dropTransporter } = await import('../dist/smtpUtil.js');
    dropTransporter(smtpAccId);
  } finally {
    if (fakeSmtp) {
      try { for (const s of fakeSmtp._sockets || []) s.destroy(); } catch { /* ignore */ }
      await new Promise((resolve) => fakeSmtp.close(resolve));
    }
  }

  // ---------- 17. audit #2 L1: delete idempotency (backend half) ----------
  console.log('== delete idempotency ==');
  // 批量删：同一 key 两次提交返回同一 taskId，不另起任务。
  // （种子信 m1 的账号没有 trash 文件夹，任务本身会逐封失败——
  // 这里只验幂等键复用同一任务，不验删除成功。）
  r = await api('POST', '/api/messages/batch-delete', { ids: [m1], idempotencyKey: 'del-batch-1' });
  const delTaskA = r.json?.taskId;
  check('L1: batch-delete with key returns a taskId',
    r.status === 200 && typeof delTaskA === 'string' && r.json?.duplicate !== true,
    `status=${r.status} taskId=${delTaskA}`);
  r = await api('POST', '/api/messages/batch-delete', { ids: [m1], idempotencyKey: 'del-batch-1' });
  check('L1: same key returns the SAME taskId with duplicate:true (no second task)',
    r.status === 200 && r.json?.taskId === delTaskA && r.json?.duplicate === true,
    `status=${r.status} taskId=${r.json?.taskId}`);
  r = await api('POST', '/api/messages/batch-delete', { ids: [m1], idempotencyKey: 'del-batch-2' });
  check('L1: a different key creates a different task',
    r.status === 200 && typeof r.json?.taskId === 'string' && r.json.taskId !== delTaskA,
    `taskId=${r.json?.taskId}`);
  // 等两个任务跑完，避免后台任务拖到进程退出。
  for (const tid of [delTaskA, r.json?.taskId]) {
    for (let i = 0; i < 40; i++) {
      const s = await api('GET', `/api/messages/delete-status?taskId=${encodeURIComponent(tid)}`);
      if (s.json && s.json.running === false) break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  // 单删：key 已记为某 id 时，重复提交直接返回 duplicate，不再调 IMAP。
  vdb.prepare('INSERT OR IGNORE INTO delete_idempotency (idempotency_key, message_db_id) VALUES (?,?)')
    .run('del-single-1', 424242);
  r = await api('DELETE', '/api/messages/424242?idempotencyKey=del-single-1');
  check('L1: single delete with a used key returns duplicate:true without touching IMAP',
    r.status === 200 && r.json?.duplicate === true, `status=${r.status} body=${JSON.stringify(r.json)}`);
  r = await api('DELETE', '/api/messages/424243?idempotencyKey=del-single-1');
  check('L1: same key for a different message -> 409', r.status === 409, `status=${r.status}`);
  r = await api('DELETE', '/api/messages/424242?idempotencyKey=' + 'x'.repeat(129));
  check('L1: over-long idempotencyKey -> 400', r.status === 400, `status=${r.status}`);
  // Audit #7 MED-1：并发同 key 单删——先占位后删除。两路并发 DELETE 带
  // 同一 key 时，只有一路真正执行删除（这里因种子账号无 trash 文件夹
  // 而 502），另一路必须返回 duplicate:true、不执行第二次删除；
  // 未修之前两路都会走到 IMAP 删除（都 502、无 duplicate）。
  const mConc = mkMsg(3, '并发删信测试', 'conc@163.com', '并发同 key 单删');
  {
    const [c1, c2] = await Promise.all([
      api('DELETE', `/api/messages/${mConc}?idempotencyKey=del-conc-1`),
      api('DELETE', `/api/messages/${mConc}?idempotencyKey=del-conc-1`),
    ]);
    const dups = [c1, c2].filter((x) => x.json?.duplicate === true).length;
    const fails = [c1, c2].filter((x) => x.status === 502).length;
    check('MED-1: concurrent same-key single deletes -> exactly one duplicate:true, one 502',
      dups === 1 && fails === 1, `c1=${c1.status}/${JSON.stringify(c1.json)} c2=${c2.status}/${JSON.stringify(c2.json)}`);
    const claimRows = vdb.prepare("SELECT COUNT(*) c FROM delete_idempotency WHERE idempotency_key='del-conc-1'").get().c;
    check('MED-1: claim row recorded exactly once', claimRows === 1, `rows=${claimRows}`);
  }
  // 批量删并发同 key：同一 taskId、其一 duplicate:true。
  {
    const [b1, b2] = await Promise.all([
      api('POST', '/api/messages/batch-delete', { ids: [m1], idempotencyKey: 'del-conc-batch-1' }),
      api('POST', '/api/messages/batch-delete', { ids: [m1], idempotencyKey: 'del-conc-batch-1' }),
    ]);
    check('MED-1: concurrent same-key batch deletes -> same taskId, one duplicate:true',
      b1.json?.taskId && b1.json.taskId === b2.json?.taskId
      && [b1, b2].filter((x) => x.json?.duplicate === true).length === 1,
      `b1=${JSON.stringify(b1.json)} b2=${JSON.stringify(b2.json)}`);
    for (let i = 0; i < 40; i++) {
      const s = await api('GET', `/api/messages/delete-status?taskId=${encodeURIComponent(b1.json.taskId)}`);
      if (s.json && s.json.running === false) break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  // Audit #7 LOW-1：key 命中但任务已不在内存（重启/剪枝）时，批量删重试
  // 应返回 status:'unknown'，而不是谎报 'finished'。
  vdb.prepare("INSERT OR IGNORE INTO delete_idempotency (idempotency_key, task_id) VALUES (?,?)")
    .run('del-unknown-1', '00000000-0000-0000-0000-000000000000');
  r = await api('POST', '/api/messages/batch-delete', { ids: [m1], idempotencyKey: 'del-unknown-1' });
  check("LOW-1: batch-delete retry with key whose task is gone -> status 'unknown' (not 'finished')",
    r.status === 200 && r.json?.taskId === '00000000-0000-0000-0000-000000000000'
    && r.json?.status === 'unknown' && r.json?.duplicate === true,
    `status=${r.status} body=${JSON.stringify(r.json)}`);

  // ---------- 18. audit #5b fixes ----------
  console.log('== audit #5b fixes ==');
  // 本地假 SMTP（与第 16 节同款：只认 PLAIN/LOGIN + MAIL/RCPT/DATA/QUIT；
  // 另记 DATA 次数与最后一份原文，供重发断言用）。
  let fakeSmtp18 = null;
  let fakePort18 = 0;
  let smtpDataCount = 0;
  let lastRaw18 = '';
  let acc18 = 0;
  let acc18b = 0;
  try {
    fakeSmtp18 = await new Promise((resolve, reject) => {
      const sockets = new Set();
      const srv = net.createServer((socket) => {
        sockets.add(socket);
        socket.on('close', () => sockets.delete(socket));
        let buf = '';
        let dataMode = false;
        let authStep = 0;
        socket.write('220 localhost fake SMTP\r\n');
        socket.on('data', (chunk) => {
          buf += chunk.toString('utf8');
          let idx;
          while ((idx = buf.indexOf('\r\n')) >= 0) {
            const line = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            if (dataMode) {
              if (line === '.') { dataMode = false; smtpDataCount += 1; socket.write('250 OK: queued\r\n'); }
              else lastRaw18 += line + '\r\n';
              continue;
            }
            const up = line.toUpperCase();
            if (up.startsWith('EHLO') || up.startsWith('HELO')) socket.write('250-localhost\r\n250 AUTH LOGIN PLAIN\r\n');
            else if (up.startsWith('AUTH PLAIN')) { authStep = 0; socket.write('235 OK\r\n'); }
            else if (up.startsWith('AUTH LOGIN')) { authStep = 1; socket.write('334 VXNlcm5hbWU6\r\n'); }
            else if (authStep === 1) { authStep = 2; socket.write('334 UGFzc3dvcmQ6\r\n'); }
            else if (authStep === 2) { authStep = 0; socket.write('235 OK\r\n'); }
            else if (up.startsWith('MAIL FROM:')) socket.write('250 OK\r\n');
            else if (up.startsWith('RCPT TO:')) socket.write('250 OK\r\n');
            else if (up === 'DATA') { dataMode = true; lastRaw18 = ''; socket.write('354 Go ahead\r\n'); }
            else if (up === 'RSET' || up === 'NOOP') socket.write('250 OK\r\n');
            else if (up === 'QUIT') { socket.write('221 Bye\r\n'); socket.end(); }
            else socket.write('250 OK\r\n');
          }
        });
      });
      srv.on('error', reject);
      srv.listen(0, '127.0.0.1', () => {
        srv._sockets = sockets;
        resolve(srv);
      });
    });
    fakePort18 = fakeSmtp18.address().port;
    const mkAcc18 = (email) => {
      const info = db.prepare(
        `INSERT INTO accounts (email, display_name, password_enc, imap_host, imap_port, imap_secure,
          smtp_host, smtp_port, smtp_secure, enabled, status) VALUES (?,?,?,?,?,?,?,?,?,?, 'offline')`,
      ).run(email, 'A5b', encryptSecret('FAKEPASS', key),
        '127.0.0.1', 9999, 'SSL', '127.0.0.1', fakePort18, 'STARTTLS', 1);
      return Number(info.lastInsertRowid);
    };
    acc18 = mkAcc18('a5b@163.com');
    acc18b = mkAcc18('a5b-b@163.com');

    // 5b-1a：发信前抛错（settings 表临时改名，签名查询在 try 内、局部
    // catch 之外）→ 500 JSON、不崩溃、占位已释放（SMTP 还没成功）。
    const settingsRowCount = db.prepare('SELECT COUNT(*) c FROM settings').get().c;
    db.exec('ALTER TABLE settings RENAME TO settings_bak');
    try {
      r = await api('POST', '/api/messages/send', { accountId: acc18, to: 'x@163.com', subject: 't1a', text: 'hi', idempotencyKey: 'a5b-1a' });
      check('5b-1a: send route unexpected error (pre-SMTP) -> 500 JSON, not a crash',
        r.status === 500 && r.json?.ok === false, `status=${r.status} body=${JSON.stringify(r.json)?.slice(0, 120)}`);
      const aliveA = await api('GET', '/api/health');
      check('5b-1a: server still alive after the error', aliveA.status === 200 && aliveA.json?.ok === true);
      const leftA = db.prepare('SELECT COUNT(*) c FROM sent_idempotency WHERE account_id=? AND idempotency_key=?').get(acc18, 'a5b-1a').c;
      check('5b-1a: placeholder released (SMTP had not succeeded)', leftA === 0, `left=${leftA}`);
    } finally {
      db.exec('ALTER TABLE settings_bak RENAME TO settings');
      // 改名会重写 sqlite_master 里的建表 SQL（IF NOT EXISTS 被去掉），
      // 不按 SQL 文本比对，改核列名与行数。
      const backCols = db.prepare('PRAGMA table_info(settings)').all().map((c) => c.name).join(',');
      const backRows = db.prepare('SELECT COUNT(*) c FROM settings').get().c;
      check('5b-1a: settings table restored', backCols === 'key,value' && backRows === settingsRowCount,
        `cols=${backCols} rows=${backRows} expected=${settingsRowCount}`);
    }

    // 5b-1b：SMTP 成功后抛错（drafts 表挂 BEFORE DELETE 触发器，
    // 发信成功后的草稿 DELETE 触发 RAISE(ABORT)）→ 500 JSON、不崩溃、
    // 占位已回填完成（不再重发），假 SMTP 只收到 1 份 DATA。
    r = await api('POST', '/api/drafts', { accountId: acc18, to: 'x@163.com', subject: 't1b', text: 'hi' });
    const d1b = r.json?.draft;
    check('5b-1b: draft created for the test', typeof d1b?.id === 'number', `draft=${JSON.stringify(d1b)}`);
    db.exec(`CREATE TRIGGER verify_break_draft_delete BEFORE DELETE ON drafts BEGIN SELECT RAISE(ABORT, 'test-trigger'); END;`);
    try {
      const beforeB = smtpDataCount;
      r = await api('POST', '/api/messages/send', { accountId: acc18, to: 'x@163.com', subject: 't1b', text: 'hi', draftId: d1b.id, idempotencyKey: 'a5b-1b' });
      check('5b-1b: SMTP succeeded then draft DELETE throws -> 500 JSON, not a crash',
        r.status === 500 && r.json?.ok === false, `status=${r.status} body=${JSON.stringify(r.json)?.slice(0, 120)}`);
      const aliveB = await api('GET', '/api/health');
      check('5b-1b: server still alive after the error', aliveB.status === 200 && aliveB.json?.ok === true);
      const rowB = db.prepare('SELECT message_id, planned_message_id FROM sent_idempotency WHERE account_id=? AND idempotency_key=?').get(acc18, 'a5b-1b');
      check('5b-1b: placeholder COMPLETED with the planned Message-ID (SMTP had succeeded)',
        !!rowB?.message_id && rowB.message_id === rowB.planned_message_id, `row=${JSON.stringify(rowB)}`);
      check('5b-1b: fake SMTP got exactly 1 DATA', smtpDataCount === beforeB + 1, `count=${smtpDataCount} before=${beforeB}`);
    } finally {
      db.exec('DROP TRIGGER IF EXISTS verify_break_draft_delete');
    }
    await api('DELETE', `/api/drafts/${d1b.id}`);

    // 5b-2：模拟崩溃后重认领——首发 201 后把占位行拨回“进行中”且过期
    // （created_at 拨到 11 分钟前），本地已发送文件夹里已有一行同
    // Message-ID 的信；重发同一 key 应直接返回 duplicate，不再发第二封。
    r = await api('POST', '/api/messages/send', { accountId: acc18, to: 'x@163.com', subject: 't2', text: 'hi', idempotencyKey: 'a5b-2' });
    const m2 = r.json?.messageId;
    check('5b-2: first send 201 with a Message-ID', r.status === 201 && typeof m2 === 'string' && m2.length > 0,
      `status=${r.status} messageId=${m2}`);
    db.prepare(`UPDATE sent_idempotency SET message_db_id=NULL, message_id=NULL, created_at=datetime('now','-11 minutes') WHERE account_id=? AND idempotency_key=?`).run(acc18, 'a5b-2');
    const sentFolder2 = db.prepare(`INSERT INTO folders (account_id, path, name, type) VALUES (?, 'Sent', '已发送', 'sent')`).run(acc18);
    const sentFolderId2 = Number(sentFolder2.lastInsertRowid);
    db.prepare(
      `INSERT INTO messages (account_id, folder_id, uid, message_id, subject, from_addr, to_json, date,
        snippet, body_path, is_read, has_attachments, size, flags_json)
       VALUES (?,?,?,?,?,?,?,?,?,NULL,1,0,1234,'[]')`,
    ).run(acc18, sentFolderId2, 1, m2, 't2', 'a5b@163.com', '[]', new Date().toISOString(), 't2');
    const before2 = smtpDataCount;
    r = await api('POST', '/api/messages/send', { accountId: acc18, to: 'x@163.com', subject: 't2', text: 'hi', idempotencyKey: 'a5b-2' });
    check('5b-2: re-claim after simulated crash returns duplicate without resending',
      r.status === 200 && r.json?.duplicate === true && r.json?.messageId === m2 && smtpDataCount === before2,
      `status=${r.status} body=${JSON.stringify(r.json)?.slice(0, 120)} dataCount=${smtpDataCount} before=${before2}`);

    // 5b-2b：重认领时本地和服务器都查不到已发出的信（IMAP 不通）——
    // 仍会重发，但必须复用同一个 planned Message-ID（不是全新生成），
    // 收件方才能凭 ID 去重。
    r = await api('POST', '/api/messages/send', { accountId: acc18, to: 'x@163.com', subject: 't2b', text: 'hi', idempotencyKey: 'a5b-2b' });
    const m2b = r.json?.messageId;
    check('5b-2b: first send 201 with a Message-ID', r.status === 201 && typeof m2b === 'string' && m2b.length > 0,
      `status=${r.status} messageId=${m2b}`);
    db.prepare(`UPDATE sent_idempotency SET message_db_id=NULL, message_id=NULL, created_at=datetime('now','-11 minutes') WHERE account_id=? AND idempotency_key=?`).run(acc18, 'a5b-2b');
    const before2b = smtpDataCount;
    lastRaw18 = '';
    r = await api('POST', '/api/messages/send', { accountId: acc18, to: 'x@163.com', subject: 't2b', text: 'hi', idempotencyKey: 'a5b-2b' });
    check('5b-2b: re-claim with nothing found resends with the SAME planned Message-ID',
      r.status === 201 && r.json?.messageId === m2b && smtpDataCount === before2b + 1 && lastRaw18.includes(`Message-ID: ${m2b}`),
      `status=${r.status} messageId=${r.json?.messageId} expected=${m2b} dataCount=${smtpDataCount}`);

    // 5b-3：批量删除时单行 SELECT 抛错——messages 表临时改名，每行
    // SELECT 都抛“no such table”；三行都应进 failed，任务正常结束，
    // 不静默丢行。
    db.exec('ALTER TABLE messages RENAME TO messages_bak');
    try {
      r = await api('POST', '/api/messages/batch-delete', { ids: [1, 2, 3] });
      const taskId3 = r.json?.taskId;
      let st3 = null;
      for (let i = 0; i < 40; i++) {
        const s = await api('GET', `/api/messages/delete-status?taskId=${encodeURIComponent(taskId3)}`);
        st3 = s.json;
        if (st3 && st3.running === false) break;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      check('5b-3: batch-delete with failing SELECTs finishes with every id in failed (none silently dropped)',
        st3 && st3.running === false && st3.total === 3 && st3.deleted === 0 && (st3.failed || []).length === 3,
        JSON.stringify(st3)?.slice(0, 300));
    } finally {
      db.exec('ALTER TABLE messages_bak RENAME TO messages');
    }
    const cnt3 = db.prepare('SELECT COUNT(*) c FROM messages').get().c;
    check('5b-3: messages table restored after the test', typeof cnt3 === 'number', `count=${cnt3}`);

    // 5b-4：发信带别人的草稿 → 400（发信前校验）。
    r = await api('POST', '/api/drafts', { accountId: acc18, to: 'x@163.com', subject: 't4', text: 'hi' });
    const d4 = r.json?.draft;
    r = await api('POST', '/api/messages/send', { accountId: acc18b, to: 'x@163.com', subject: 't4', text: 'hi', draftId: d4?.id, idempotencyKey: 'a5b-4' });
    check('5b-4: send with another account\'s draftId -> 400',
      r.status === 400 && typeof r.json?.error === 'string', `status=${r.status} body=${JSON.stringify(r.json)?.slice(0, 120)}`);
    await api('DELETE', `/api/drafts/${d4.id}`);

    // 5b-6：应用层不再设安全响应头（OpenResty 为唯一一层）；/api 的
    // Cache-Control: no-store 保留（D1，不在去重范围）。
    r = await api('GET', '/api/auth/status');
    check('5b-6: app sets no X-Content-Type-Options / X-Frame-Options / Referrer-Policy',
      !r.headers.get('x-content-type-options') && !r.headers.get('x-frame-options') && !r.headers.get('referrer-policy'),
      `xcto=${r.headers.get('x-content-type-options')} xfo=${r.headers.get('x-frame-options')} rp=${r.headers.get('referrer-policy')}`);
  } finally {
    if (fakeSmtp18) {
      try { for (const s of fakeSmtp18._sockets || []) s.destroy(); } catch { /* ignore */ }
      await new Promise((resolve) => fakeSmtp18.close(resolve));
    }
    try {
      const { dropTransporter } = await import('../dist/smtpUtil.js');
      if (acc18) dropTransporter(acc18);
      if (acc18b) dropTransporter(acc18b);
    } catch { /* ignore */ }
  }

  // ---------- 18. CSV import tests connectivity first ----------
  console.log('== csv import connectivity ==');
  // (a) isAuthError / readableImapError：Gmail/Outlook 风格认证失败。
  // 密码错与授权码错同等对待——只要是服务器拒绝登录（认证失败），都应识别。
  {
    const { isAuthError, readableImapError } = await import('../dist/imapUtil.js');
    // imapflow 对 `NO [AUTHENTICATIONFAILED] Invalid credentials` 抛的真实形态：
    // message 是通用 "Command failed"，responseText 只有 TEXT 段（方括号响应码
    // 被解析成 section，不在文本里），响应码在 response 解析对象里。
    const gmailErr = {
      message: 'Command failed',
      responseText: 'Invalid credentials (Failure)',
      response: { attributes: [{ section: [{ type: 'ATOM', value: 'AUTHENTICATIONFAILED' }] }] },
    };
    check('import18a: isAuthError recognizes Gmail-style [AUTHENTICATIONFAILED] Invalid credentials (response code)',
      isAuthError(gmailErr) === true);
    check('import18a: readableImapError gives a clear auth reason for Gmail-style failure',
      readableImapError(gmailErr).includes('用户名或密码/授权码不正确'),
      readableImapError(gmailErr).slice(0, 120));
    // 只有文本、没有 response 对象时也应识别（兜底）。
    check('import18a: isAuthError recognizes Gmail-style text-only error (no response object)',
      isAuthError({ message: 'Command failed', responseText: 'Invalid credentials (Failure)' }) === true);
    // 163/QQ 风格保持识别。
    check('import18a: isAuthError still recognizes 163-style "Login error"',
      isAuthError({ message: 'Command failed', responseText: 'LOGIN Login error: invalid user or password' }) === true);
    // 非认证错误不误判（否则普通断线也会停掉账号）。
    check('import18a: isAuthError does not misclassify a plain timeout',
      isAuthError(new Error('Timed out')) === false);
  }

  // (b) 导入端到端：好凭证建成、163 风格与 Gmail 风格坏凭证都进 failed、不建账号。
  // 假 IMAP（TLS，自签证书；子进程经 NODE_EXTRA_CA_CERTS 信任）+ 假 SMTP（明文，
  // gmail 预设 smtpSecure=STARTTLS）。LOGIN 按密码区分：GOODPASS 放行，
  // WRONG163 回 163 风格、WRONG_GMAIL 回 Gmail 风格。
  if (tlsFakeOk) {
    let fakeImap = null;
    let fakeSmtpImp = null;
    let goodAccId = 0;
    const imapLogins = [];
    try {
      fakeSmtpImp = await new Promise((resolve, reject) => {
        const sockets = new Set();
        const srv = net.createServer((socket) => {
          sockets.add(socket);
          socket.on('close', () => sockets.delete(socket));
          let buf = '';
          let dataMode = false;
          let authStep = 0;
          socket.write('220 localhost fake SMTP\r\n');
          socket.on('data', (chunk) => {
            buf += chunk.toString('utf8');
            let idx;
            while ((idx = buf.indexOf('\r\n')) >= 0) {
              const line = buf.slice(0, idx);
              buf = buf.slice(idx + 2);
              if (dataMode) {
                if (line === '.') { dataMode = false; socket.write('250 OK: queued\r\n'); }
                continue;
              }
              const up = line.toUpperCase();
              if (up.startsWith('EHLO') || up.startsWith('HELO')) socket.write('250-localhost\r\n250 AUTH LOGIN PLAIN\r\n');
              else if (up.startsWith('AUTH PLAIN')) { authStep = 0; socket.write('235 OK\r\n'); }
              else if (up.startsWith('AUTH LOGIN')) { authStep = 1; socket.write('334 VXNlcm5hbWU6\r\n'); }
              else if (authStep === 1) { authStep = 2; socket.write('334 UGFzc3dvcmQ6\r\n'); }
              else if (authStep === 2) { authStep = 0; socket.write('235 OK\r\n'); }
              else if (up === 'QUIT') { socket.write('221 Bye\r\n'); socket.end(); }
              else socket.write('250 OK\r\n');
            }
          });
        });
        srv.on('error', reject);
        srv.listen(0, '127.0.0.1', () => { srv._sockets = sockets; resolve(srv); });
      });
      const fakeSmtpPort = fakeSmtpImp.address().port;
      fakeImap = await new Promise((resolve, reject) => {
        const sockets = new Set();
        const srv = tls.createServer({ cert: fs.readFileSync(tlsCertPath), key: fs.readFileSync(tlsKeyPath) }, (socket) => {
          sockets.add(socket);
          socket.on('close', () => sockets.delete(socket));
          let buf = '';
          let idleTag = null;
          socket.write('* OK fake IMAP ready\r\n');
          socket.on('data', (chunk) => {
            buf += chunk.toString('utf8');
            let idx;
            while ((idx = buf.indexOf('\r\n')) >= 0) {
              const line = buf.slice(0, idx);
              buf = buf.slice(idx + 2);
              if (idleTag) {
                if (line.toUpperCase() === 'DONE') { socket.write(`${idleTag} OK IDLE completed\r\n`); idleTag = null; }
                continue;
              }
              const m = line.match(/^(\S+)\s+(\S+)(?:\s+(.*))?$/);
              if (!m) continue;
              const [, tag, cmdRaw, rest] = m;
              const cmd = cmdRaw.toUpperCase();
              if (cmd === 'CAPABILITY') socket.write(`* CAPABILITY IMAP4rev1 IDLE UIDPLUS\r\n${tag} OK CAPABILITY completed\r\n`);
              else if (cmd === 'LOGIN') {
                const parts = (rest || '').split(/\s+/);
                // imapflow 发 LOGIN 时用户名带引号（"user@x"），密码是 atom；
                // 两边引号都去掉再比对，否则断言按裸邮箱过滤不到。
                const user = (parts[0] || '').replace(/^"|"$/g, '');
                const pass = (parts[1] || '').replace(/^"|"$/g, '');
                imapLogins.push({ user, pass, ok: pass === 'GOODPASS' });
                if (pass === 'GOODPASS') socket.write(`${tag} OK LOGIN completed\r\n`);
                else if (pass === 'WRONG_GMAIL') socket.write(`${tag} NO [AUTHENTICATIONFAILED] Invalid credentials (Failure)\r\n`);
                else socket.write(`${tag} NO [AUTHENTICATIONFAILED] LOGIN Login error: invalid user or password\r\n`);
              } else if (cmd === 'LOGOUT') { socket.write(`* BYE Logging out\r\n${tag} OK LOGOUT completed\r\n`); socket.end(); }
              else if (cmd === 'LIST') socket.write(`* LIST (\\HasNoChildren) "/" INBOX\r\n${tag} OK LIST completed\r\n`);
              else if (cmd === 'SELECT') socket.write(`* FLAGS (\\Answered \\Flagged \\Deleted \\Seen \\Draft)\r\n* OK [PERMANENTFLAGS (\\Answered \\Flagged \\Deleted \\Seen \\Draft \\*)] Flags permitted\r\n* 0 EXISTS\r\n* 0 RECENT\r\n* OK [UIDVALIDITY 1] UIDs valid\r\n* OK [UIDNEXT 1] Predicted next UID\r\n${tag} OK [READ-WRITE] SELECT completed\r\n`);
              else if (cmd === 'SEARCH') socket.write(`* SEARCH\r\n${tag} OK SEARCH completed\r\n`);
              else if (cmd === 'IDLE') { idleTag = tag; socket.write('+ idling\r\n'); }
              else socket.write(`${tag} OK ${cmd} completed\r\n`);
            }
          });
        });
        srv.on('error', reject);
        srv.listen(0, '127.0.0.1', () => { srv._sockets = sockets; resolve(srv); });
      });
      const fakeImapPort = fakeImap.address().port;
      const csv = [
        '序号,邮箱名,授权码,接收服务器（IMAP）,IMAP端口,发送服务器（SMTP）,SMTP端口,备注',
        `1,goodimport@gmail.com,GOODPASS,127.0.0.1,${fakeImapPort},127.0.0.1,${fakeSmtpPort},good`,
        `2,bad163import@gmail.com,WRONG163,127.0.0.1,${fakeImapPort},127.0.0.1,${fakeSmtpPort},bad163`,
        `3,badgmailimport@gmail.com,WRONG_GMAIL,127.0.0.1,${fakeImapPort},127.0.0.1,${fakeSmtpPort},badgmail`,
      ].join('\r\n');
      const logBefore = serverLog.length;
      const t0 = Date.now();
      const form = new FormData();
      form.append('file', new Blob([csv], { type: 'text/csv' }), 'import.csv');
      const impRes = await fetch(BASE + '/api/accounts/import', { method: 'POST', headers: { Cookie: cookie }, body: form });
      const impDt = Date.now() - t0;
      const imp = await impRes.json();
      console.log(`  import took ${impDt}ms for 3 rows (sequential connectivity tests)`);
      check('import18b: 1 added + 2 failed (good row built, both bad-cred rows rejected)',
        impRes.status === 200 && imp?.ok === true && imp?.added === 1 && (imp?.failed || []).length === 2,
        `status=${impRes.status} added=${imp?.added} failed=${JSON.stringify(imp?.failed)?.slice(0, 240)}`);
      const bad163 = (imp?.failed || []).find((f) => f.email === 'bad163import@gmail.com');
      const badGmail = (imp?.failed || []).find((f) => f.email === 'badgmailimport@gmail.com');
      check('import18b: 163-style bad row failed with a clear auth reason',
        !!bad163 && /认证被拒|用户名或密码/.test(bad163.reason), bad163?.reason || 'missing');
      check('import18b: Gmail-style bad row failed with a clear auth reason (not "Command failed")',
        !!badGmail && /用户名或密码\/授权码不正确/.test(badGmail.reason) && !badGmail.reason.includes('Command failed'),
        badGmail?.reason || 'missing');
      check('import18b: good row listed in addedEmails',
        (imp?.addedEmails || []).includes('goodimport@gmail.com'));
      const goodRow = db.prepare('SELECT * FROM accounts WHERE email=?').get('goodimport@gmail.com');
      goodAccId = goodRow ? Number(goodRow.id) : 0;
      check('import18b: good account exists in DB', !!goodRow);
      check('import18b: bad accounts were NOT inserted into DB',
        !db.prepare('SELECT id FROM accounts WHERE email=?').get('bad163import@gmail.com')
        && !db.prepare('SELECT id FROM accounts WHERE email=?').get('badgmailimport@gmail.com'));
      // 引擎：好账号应连上变 online；坏账号的登录各只发生一次（逐行顺序测、
      // 失败不重测），且引擎从未为坏账号建 state（serverLog 里无其邮箱）。
      let goodOnline = false;
      for (let i = 0; i < 20; i++) {
        const l = await api('GET', '/api/accounts');
        const g = (l.json?.accounts || []).find((a) => a.email === 'goodimport@gmail.com');
        if (g?.status === 'online') { goodOnline = true; break; }
        await new Promise((r2) => setTimeout(r2, 500));
      }
      check('import18b: engine started the good account (status online)', goodOnline);
      const newLog = serverLog.slice(logBefore);
      check('import18b: engine connected the good account and never touched the bad ones',
        newLog.includes('goodimport@gmail.com')
        && !newLog.includes('bad163import@gmail.com') && !newLog.includes('badgmailimport@gmail.com'),
        `connected-good=${newLog.includes('goodimport@gmail.com')}`);
      check('import18b: each bad credential was tried exactly once (sequential, no retry storm)',
        imapLogins.filter((l) => l.user === 'bad163import@gmail.com').length === 1
        && imapLogins.filter((l) => l.user === 'badgmailimport@gmail.com').length === 1
        && imapLogins.filter((l) => l.user === 'goodimport@gmail.com').length >= 1,
        JSON.stringify(imapLogins));
    } finally {
      // 删掉好账号（引擎干净停住，不留 IDLE 连接去撞已关的假服务器），再关假服务。
      if (goodAccId) { try { await api('DELETE', `/api/accounts/${goodAccId}`); } catch { /* ignore */ } }
      if (fakeImap) {
        try { for (const s of fakeImap._sockets || []) s.destroy(); } catch { /* ignore */ }
        await new Promise((resolve) => fakeImap.close(resolve));
      }
      if (fakeSmtpImp) {
        try { for (const s of fakeSmtpImp._sockets || []) s.destroy(); } catch { /* ignore */ }
        await new Promise((resolve) => fakeSmtpImp.close(resolve));
      }
    }
  } else {
    // openssl 不可用、建不了 TLS 假 IMAP 时退化：只测真实 163 坏凭证行进 failed
    // （与第 7 节同款真实 163）；Gmail 风格只由上面的函数级断言覆盖。
    console.log('  SKIP import18b end-to-end (no openssl for TLS fake IMAP); falling back to real-163 bad row');
    const csv = '序号,邮箱名,授权码,接收服务器（IMAP）,IMAP端口,发送服务器（SMTP）,SMTP端口,备注\r\n'
      + '1,realbadimport@163.com,FAKE_AUTH_CODE_123,imap.163.com,993,smtp.163.com,465,\r\n';
    const form = new FormData();
    form.append('file', new Blob([csv], { type: 'text/csv' }), 'import.csv');
    const impRes = await fetch(BASE + '/api/accounts/import', { method: 'POST', headers: { Cookie: cookie }, body: form });
    const imp = await impRes.json();
    const bad = (imp?.failed || []).find((f) => f.email === 'realbadimport@163.com');
    check('import18b-fallback: real-163 bad row goes to failed with a clear auth reason, no account created',
      impRes.status === 200 && !!bad && /认证被拒|用户名或密码/.test(bad.reason)
      && !db.prepare('SELECT id FROM accounts WHERE email=?').get('realbadimport@163.com'),
      `status=${impRes.status} failed=${JSON.stringify(imp?.failed)?.slice(0, 160)}`);
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
