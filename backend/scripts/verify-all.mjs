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
const { collectAttachmentParts, matchAttachmentParts } = await import('../dist/mailUtil.js');

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
  // Audit #10 M-5：默认带同源 Origin——严格 CSRF 要求已认证写请求带
  // Origin；Node fetch 本身不带，须由调用方补上。显式传 Origin（含空
  // 串）时不覆盖——空串用于测“缺失 Origin → 403”。
  if (!('Origin' in headers) && !('origin' in headers)) headers.Origin = BASE;
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
      // Audit #10 M-2：测试进程才放行私有/回环地址——假 IMAP/SMTP 跑在
      // 127.0.0.1；生产绝不设此变量（默认拒绝）。
      ALLOW_PRIVATE_MAIL_HOSTS: '1',
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
  // Audit #10 H-1：首次启动生成的一次性引导 token——users 表为空时写
  // DATA_DIR/.setup-token（0600），setup 必须带它。
  const setupTokenPath = path.join(DATA_DIR, '.setup-token');
  const setupTokenExists = fs.existsSync(setupTokenPath);
  const setupTokenMode = setupTokenExists ? (fs.statSync(setupTokenPath).mode & 0o777).toString(8) : '';
  const setupToken = setupTokenExists ? fs.readFileSync(setupTokenPath, 'utf8').trim() : '';
  check('audit10 H-1: setup token file exists (0600) while no user',
    setupTokenExists && setupTokenMode === '600' && setupToken.length >= 32,
    `exists=${setupTokenExists} mode=${setupTokenMode} len=${setupToken.length}`);
  r = await api('POST', '/api/auth/setup', { username: 'tester', password: 'testpass123', confirm: 'testpass123' });
  check('audit10 H-1: setup without token -> 403', r.status === 403, `status=${r.status}`);
  r = await api('POST', '/api/auth/setup', { username: 'tester', password: 'testpass123', confirm: 'testpass123', setupToken: 'wrong-token' });
  check('audit10 H-1: setup with wrong token -> 403', r.status === 403, `status=${r.status}`);
  r = await api('POST', '/api/auth/setup', { username: 'tester', password: 'short', confirm: 'short', setupToken });
  check('setup rejects short password (400)', r.status === 400);
  // Audit #14 LOW-2：表单校验失败不计入 IP 锁定——上面已有 1 次 token
  // 猜错 + 1 次短密码；这里再补 6 次不同校验失败（空用户名、带 @、
  // 超长用户名、短密码、密码不一致、超长密码），旧版累计 8 次 ≥ 5 次
  // 阈值会锁 IP 15 分钟、合法 setup 变 429；新版只有 token 猜错计数。
  const badForms = [
    { username: '', password: 'testpass123', confirm: 'testpass123' },
    { username: 'a@b.com', password: 'testpass123', confirm: 'testpass123' },
    { username: 'x'.repeat(65), password: 'testpass123', confirm: 'testpass123' },
    { username: 'tester', password: 'short', confirm: 'short' },
    { username: 'tester', password: 'testpass123', confirm: 'different123' },
    { username: 'tester', password: 'x'.repeat(129), confirm: 'x'.repeat(129) },
  ];
  let badFormAll400 = true;
  for (const f of badForms) {
    const rr = await api('POST', '/api/auth/setup', { ...f, setupToken });
    if (rr.status !== 400) badFormAll400 = false;
  }
  check('audit14 LOW-2: setup validation failures return 400 (not counted toward IP lock)',
    badFormAll400);
  r = await api('POST', '/api/auth/setup', { username: 'tester', password: 'testpass123', confirm: 'testpass123', setupToken });
  check('setup creates single user (201)', r.status === 201 && r.json?.ok === true);
  check('audit14 LOW-2: 1 wrong token + 7 validation failures do not lock the IP (valid setup still 201)',
    r.status === 201, `status=${r.status}`);
  check('audit10 H-1: setup token file deleted after first user', !fs.existsSync(setupTokenPath));
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
  // 刷新掉登录回归（2026-11-19 真实故障）：生产 COOKIE_SECURE=1 时会话
  // Cookie 名是 __Host-lm_session；/api/auth/status 曾写死读 lm_session，
  // 线上每次刷新都判未登录、跳回登录页（本地 COOKIE_SECURE=0 时名字
  // 就是 lm_session，所以本地跑测从没发现）。起第二个子进程用生产配置
  // 跑一遍登录 + status，确认名字与状态一致。
  {
    const securePort = await new Promise((resolve, reject) => {
      const probe = net.createServer();
      probe.once('error', reject);
      probe.listen(0, '127.0.0.1', () => { const p = probe.address().port; probe.close(() => resolve(p)); });
    });
    const secureTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'luck-mail-verify-secure-'));
    const secureData = path.join(secureTmp, 'data');
    const secureBase = `http://127.0.0.1:${securePort}`;
    const secureSrv = spawn('node', ['dist/server.js'], {
      cwd: BACKEND,
      env: { ...process.env, PORT: String(securePort), DATA_DIR: secureData, PUBLIC_DIR,
        COOKIE_SECURE: '1', ALLOW_PRIVATE_MAIL_HOSTS: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let secureLog = '';
    secureSrv.stdout.on('data', (d) => { secureLog += d.toString(); });
    secureSrv.stderr.on('data', (d) => { secureLog += d.toString(); });
    try {
      let up = false;
      for (let i = 0; i < 60 && !up; i++) {
        try { const rr = await fetch(secureBase + '/api/auth/status'); if (rr.ok) up = true; }
        catch { /* not up yet */ }
        if (!up) await new Promise((r2) => setTimeout(r2, 250));
      }
      check('secure-cookie probe: server starts with COOKIE_SECURE=1', up, secureLog.slice(-200));
      if (up) {
        const tokenFile = path.join(secureData, '.setup-token');
        const sToken = fs.existsSync(tokenFile) ? fs.readFileSync(tokenFile, 'utf8').trim() : '';
        const sSetup = await fetch(secureBase + '/api/auth/setup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'secure', password: 'testpass123', confirm: 'testpass123', setupToken: sToken }) });
        check('secure-cookie probe: setup ok', sSetup.status === 201, `status=${sSetup.status}`);
        const sLogin = await fetch(secureBase + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: secureBase }, body: JSON.stringify({ username: 'secure', password: 'testpass123', rememberMe: true }) });
        const sSetCookie = sLogin.headers.get('set-cookie') || '';
        const sName = (sSetCookie.match(/^\s*([^=;\s]+)=/) || [])[1] || '';
        check('secure-cookie probe: login sets __Host-lm_session', sLogin.status === 200 && sName === '__Host-lm_session', `status=${sLogin.status} name=${sName}`);
        const sCookieVal = (sSetCookie.match(/^\s*[^=;\s]+=([^;]*)/) || [])[1] || '';
        const sStatus = await fetch(secureBase + '/api/auth/status', { headers: { Cookie: `${sName}=${sCookieVal}` } });
        const sJson = await sStatus.json().catch(() => null);
        check('secure-cookie probe: /status sees the secure session (refresh keeps login)', sJson?.loggedIn === true && sJson?.username === 'secure', JSON.stringify(sJson));
      }
    } finally {
      try { secureSrv.kill('SIGKILL'); } catch { /* ignore */ }
    }
  }

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
  // 添加邮箱必填校验（用户 2026-11-19 要求）：缺服务器时直接 400，不再
  // 走预设回落去测连通——下面这条须带齐服务器，否则到不了连通测试。
  r = await api('POST', '/api/accounts', { email: 'fakeuser@163.com', password: 'FAKE_AUTH_CODE_123', imapHost: 'imap.163.com', imapPort: 993, imapSecure: 'SSL', smtpHost: 'smtp.163.com', smtpPort: 465, smtpSecure: 'SSL' });
  check('add fake account fails connectivity (400, clear step, no 500/stack)',
    r.status === 400 && typeof r.json?.error === 'string' && r.json.error.includes('IMAP') && !r.text.includes(' at ') && !r.text.includes('Error:'));
  r = await api('GET', '/api/accounts');
  check('fake account was NOT saved', r.json?.accounts?.length === 0);

  // ---------- 2b. 添加邮箱必填与格式校验（用户 2026-11-19 要求） ----------
  // 邮件帐号、密码、接收服务器、发送服务器四项均为必填，帐号须符合邮箱
  // 格式；以下断言都在连通测试之前 400，不建账号、不发 IMAP 登录。
  console.log('== add-account required & format ==');
  const addBase = { email: 'addcheck@163.com', password: 'FAKE_AUTH_CODE_123', imapHost: 'imap.163.com', imapPort: 993, imapSecure: 'SSL', smtpHost: 'smtp.163.com', smtpPort: 465, smtpSecure: 'SSL' };
  r = await api('POST', '/api/accounts', { ...addBase, email: '' });
  check('添加邮箱：帐号为空 -> 400 邮箱地址格式不正确', r.status === 400 && /邮箱地址格式不正确/.test(r.json?.error || ''), `status=${r.status} error=${r.json?.error}`);
  r = await api('POST', '/api/accounts', { ...addBase, email: 'not-an-email' });
  check('添加邮箱：帐号格式非法 -> 400 邮箱地址格式不正确', r.status === 400 && /邮箱地址格式不正确/.test(r.json?.error || ''), `status=${r.status} error=${r.json?.error}`);
  r = await api('POST', '/api/accounts', { ...addBase, email: 'a@b' });
  check('添加邮箱：帐号无域名后缀 -> 400 邮箱地址格式不正确', r.status === 400 && /邮箱地址格式不正确/.test(r.json?.error || ''), `status=${r.status} error=${r.json?.error}`);
  const { password: _pw, ...noPw } = addBase;
  r = await api('POST', '/api/accounts', noPw);
  check('添加邮箱：密码缺失 -> 400 密码/授权码必填', r.status === 400 && /密码\/授权码必填/.test(r.json?.error || ''), `status=${r.status} error=${r.json?.error}`);
  const { imapHost: _ih, ...noImap } = addBase;
  r = await api('POST', '/api/accounts', noImap);
  check('添加邮箱：接收服务器缺失 -> 400 接收服务器（IMAP）必填', r.status === 400 && /接收服务器（IMAP）必填/.test(r.json?.error || ''), `status=${r.status} error=${r.json?.error}`);
  r = await api('POST', '/api/accounts', { ...addBase, imapHost: '' });
  check('添加邮箱：接收服务器为空字符串 -> 400 接收服务器（IMAP）必填', r.status === 400 && /接收服务器（IMAP）必填/.test(r.json?.error || ''), `status=${r.status} error=${r.json?.error}`);
  const { smtpHost: _sh, ...noSmtp } = addBase;
  r = await api('POST', '/api/accounts', noSmtp);
  check('添加邮箱：发送服务器缺失 -> 400 发送服务器（SMTP）必填', r.status === 400 && /发送服务器（SMTP）必填/.test(r.json?.error || ''), `status=${r.status} error=${r.json?.error}`);
  r = await api('POST', '/api/accounts', { ...addBase, smtpHost: '   ' });
  check('添加邮箱：发送服务器全是空格 -> 400 发送服务器（SMTP）必填', r.status === 400 && /发送服务器（SMTP）必填/.test(r.json?.error || ''), `status=${r.status} error=${r.json?.error}`);
  r = await api('GET', '/api/accounts');
  check('添加邮箱：上述非法请求均未建账号', r.json?.accounts?.length === 0, `count=${r.json?.accounts?.length}`);

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
  // Audit #17 MED-1：搜索按视图限定——草稿/已发送/已删除/文件夹视图
  // 按文件夹过滤搜索命中，收件箱/未读视图（及不带 view）保持全局。
  // 种子一封草稿（与收件箱 m2 共享“报告”一词）；查询词特意不用
  // “项目”（前面刚查过，500ms 搜索去重缓存会直接返回旧结果）。
  const draftsFolderInfo = db.prepare(
    "INSERT INTO folders (account_id, path, name, type) VALUES (?, '草稿箱', '草稿箱', 'drafts')",
  ).run(accountId);
  const draftsFolderId = Number(draftsFolderInfo.lastInsertRowid);
  const m3 = Number(db.prepare(
    `INSERT INTO messages (account_id, folder_id, uid, subject, from_addr, to_json, date,
      snippet, body_path, is_read, has_attachments, size, flags_json)
     VALUES (?,?,?,?,?,?,?,?,?,0,0,1234,'[]')`,
  ).run(accountId, draftsFolderId, 3, '项目草稿报告', 'me@163.com', '[]', new Date().toISOString(), '项目草稿报告正文', null).lastInsertRowid);
  db.prepare('INSERT INTO messages_fts(rowid, subject, from_addr, body_text) VALUES (?,?,?,?)')
    .run(m3, '项目草稿报告', 'me@163.com', '项目草稿报告正文');
  r = await api('GET', `/api/messages?q=${encodeURIComponent('报告')}&view=all-drafts`);
  check('audit17 MED-1: q in all-drafts returns only draft-folder hits',
    r.json?.total === 1 && r.json?.messages?.length === 1 && r.json.messages[0].id === m3, `total=${r.json?.total}`);
  r = await api('GET', `/api/messages?q=${encodeURIComponent('报告')}&view=all-inbox`);
  check('audit17 MED-1: q in all-inbox stays global (inbox + draft both hit)',
    r.json?.total === 2 && r.json?.messages?.some((m) => m.id === m2) && r.json?.messages?.some((m) => m.id === m3), `total=${r.json?.total}`);
  r = await api('GET', `/api/messages?q=${encodeURIComponent('报告')}`);
  check('audit17 MED-1: q without view stays global (inbox + draft)',
    r.json?.total === 2, `total=${r.json?.total}`);
  r = await api('GET', `/api/messages?q=${encodeURIComponent('报告')}&view=folder&accountId=${accountId}&folderId=${draftsFolderId}`);
  check('audit17 MED-1: q in folder view (drafts folder) returns only that folder',
    r.json?.total === 1 && r.json?.messages?.[0]?.id === m3, `total=${r.json?.total}`);
  r = await api('GET', `/api/messages?q=${encodeURIComponent('报告')}&view=folder&accountId=${accountId}&folderId=${folderId}`);
  check('audit17 MED-1: q in folder view (inbox folder) returns only that folder',
    r.json?.total === 1 && r.json?.messages?.[0]?.id === m2, `total=${r.json?.total}`);
  r = await api('GET', `/api/messages?view=all-inbox&limit=50`);
  check('all-inbox lists seeded messages', r.json?.total === 2);
  // Audit #10 前端约定：详情响应带原信 Message-ID 与 References（供回复/
  // 转发透传 threading）。种子行先写一对值再验。
  db.prepare('UPDATE messages SET message_id=?, "references"=? WHERE id=?')
    .run('<seed-m1@luck-mail.test>', '<seed-ref-0@luck-mail.test>', m1);
  r = await api('GET', `/api/messages/${m1}`);
  check('audit10 threading: detail returns messageId + references of the original mail',
    r.json?.message?.messageId === '<seed-m1@luck-mail.test>'
    && JSON.stringify(r.json?.message?.references) === JSON.stringify(['<seed-ref-0@luck-mail.test>']),
    `messageId=${r.json?.message?.messageId} references=${JSON.stringify(r.json?.message?.references)}`);
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

  // Audit #10 H-2：标已读去掉断网本地回退——IMAP 不通直接 502（与删信/
  // 移动一致），本地 is_read 不变。旧断言（审计 #8 LOW-7，期望 200 +
  // is_read=1）按新语义改写。
  r = await api('POST', `/api/messages/${m2}/read`, { read: true });
  const m2Read = db.prepare('SELECT is_read FROM messages WHERE id=?').get(m2).is_read;
  check('audit10 H-2: mark-read returns 502 and does NOT change local is_read when IMAP is unreachable',
    r.status === 502 && m2Read === 0, `status=${r.status} is_read=${m2Read}`);

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
  // Audit #12 L1：后端钩子与前端对齐——补 opacity:0；宽/高样式按声明锚定，
  // min-width:0 不再误伤正常图片。
  check('audit12 L1: sanitize removes opacity:0 tracking pixel (backend aligned with frontend)',
    !sanitizeBodyHtml('<img src="http://x.com/op.png" style="opacity:0">').includes('op.png'));
  check('audit12 L1: sanitize keeps img with min-width:0/min-height:0 but normal width/height (anchored declarations)',
    sanitizeBodyHtml('<img src="http://x.com/mw.png" style="min-width:0;min-height:0;width:100px;height:50px">').includes('mw.png'));
  check('audit12 L1: sanitize still removes 1px-by-1px style pixel and 0x0 style pixel',
    !sanitizeBodyHtml('<img src="http://x.com/px1.png" style="width:1px;height:1px">').includes('px1.png')
    && !sanitizeBodyHtml('<img src="http://x.com/px0.png" style="width:0;height:0">').includes('px0.png'));
  // Audit #16 LOW-3：小数零写法也要拦——opacity:.0、width:1.0px/height:1.0px；
  // 非零值（opacity:0.5、width:1.5px）仍保留。
  check('audit16 LOW-3: sanitize removes opacity:.0 and 1.0px style pixels',
    !sanitizeBodyHtml('<img src="http://x.com/opd.png" style="opacity:.0">').includes('opd.png')
    && !sanitizeBodyHtml('<img src="http://x.com/pxd.png" style="width:1.0px;height:1.0px">').includes('pxd.png'));
  check('audit16 LOW-3: sanitize keeps non-zero opacity and 1.5px images',
    sanitizeBodyHtml('<img src="http://x.com/op5.png" style="opacity:0.5">').includes('op5.png')
    && sanitizeBodyHtml('<img src="http://x.com/px15.png" style="width:1.5px;height:1.5px">').includes('px15.png'));
  // 审计 #16 跟进：0 尺寸的 0.0px 写法同样是合法 CSS 零值，须拦。
  check('audit16 LOW-3 follow-up: sanitize removes 0.0px style pixels',
    !sanitizeBodyHtml('<img src="http://x.com/px00.png" style="width:0.0px;height:0.0px">').includes('px00.png'));

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
  // Audit #16 LOW-2：collectAttachmentParts 须与 mailparser 的
  // isAttachment 同口径——非文本叶部件全收（无文件名记 null），文本叶
  // 部件只在 disposition 为 attachment 时收。旧口径漏掉无 disposition、
  // 无文件名的二进制部件，matchAttachmentParts 按索引配对时后续附件
  // 的 part 号整体错位一位。
  {
    const bsEdges = {
      type: 'multipart/mixed',
      childNodes: [
        { part: '1', type: 'text/plain', disposition: 'inline', size: 5 },
        { part: '2', type: 'text/plain', disposition: 'attachment', dispositionParameters: { filename: 'note.txt' }, size: 4 },
        { part: '3', type: 'application/octet-stream', size: 3 },
        { part: '4', type: 'image/png', disposition: 'inline', dispositionParameters: { filename: 'img.png' }, size: 10 },
      ],
    };
    const edgeParts = collectAttachmentParts(bsEdges);
    check('audit16 LOW-2: collectAttachmentParts mirrors mailparser (bare binary in, inline text out, text attachment in)',
      edgeParts.length === 3 && edgeParts[0].part === '2' && edgeParts[0].filename === 'note.txt'
      && edgeParts[1].part === '3' && edgeParts[1].filename === null
      && edgeParts[2].part === '4' && edgeParts[2].filename === 'img.png',
      JSON.stringify(edgeParts));
    // 端到端：同一封原始邮件，mailparser 附件与 BODYSTRUCTURE 收集
    // 按索引配对后 part 号不再错位。
    const emlBare = Buffer.concat([
      Buffer.from('From: a@163.com\r\nSubject: bare binary part\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary="B"\r\n\r\n--B\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nhello\r\n--B\r\nContent-Type: application/octet-stream\r\nContent-Transfer-Encoding: base64\r\n\r\nAAECAw==\r\n--B\r\nContent-Type: application/pdf\r\nContent-Transfer-Encoding: base64\r\nContent-Disposition: attachment; filename="doc.pdf"\r\n\r\nJVBERi0x\r\n--B--\r\n', 'utf8'),
    ]);
    const parsedBare = await streamToParsed(Readable.from([emlBare]), emlBare.length);
    const bsBare = {
      type: 'multipart/mixed',
      childNodes: [
        { part: '1', type: 'text/plain', size: 5 },
        { part: '2', type: 'application/octet-stream', size: 4 },
        { part: '3', type: 'application/pdf', disposition: 'attachment', dispositionParameters: { filename: 'doc.pdf' }, size: 6 },
      ],
    };
    const matchedBare = matchAttachmentParts(parsedBare.attachments, collectAttachmentParts(bsBare));
    check('audit16 LOW-2: bare binary part and named attachment get the right part numbers (no off-by-one)',
      matchedBare.length === 2 && matchedBare[0].part === '2' && matchedBare[0].filename === 'attachment-1'
      && matchedBare[1].part === '3' && matchedBare[1].filename === 'doc.pdf',
      JSON.stringify(matchedBare.map((a) => [a.filename, a.part])));
    // Audit #17 LOW-2：单部件邮件（整个正文就是一个非文本部件）时
    // BODYSTRUCTURE 根节点没有 part 号；RFC 3501 里单部件正文即
    // part 1，根节点记 '1' 而不是 null，否则附件列得出、下载直接 404。
    // 注：这里只覆盖 BODYSTRUCTURE 侧的 part 赋值；取回路径（IMAP
    // download BODY[1]）本地无 live IMAP，需线上端到端验证。
    const singleParts = collectAttachmentParts({ type: 'application/pdf', size: 9 });
    check('audit17 LOW-2: single-part root attachment gets part 1 (not null)',
      singleParts.length === 1 && singleParts[0].part === '1' && singleParts[0].filename === null
      && singleParts[0].contentType === 'application/pdf',
      JSON.stringify(singleParts));
  }

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
    // 多点登录（用户 2026-11-19 决定）：再登一次不再吊销本次会话——
    // 旧 socket 不被断开，旧 Cookie 继续有效，两端可同时在线。
    const disconnected = new Promise((resolve) => {
      socket.on('disconnect', () => resolve(true));
      setTimeout(() => resolve(false), 3000);
    });
    const cookieBefore = cookie;
    const loginAgain = await api('POST', '/api/auth/login', { username: 'tester', password: 'testpass123' });
    check('multi-login: re-login succeeds without revokedOtherSessions',
      loginAgain.status === 200 && loginAgain.json?.revokedOtherSessions === undefined,
      `status=${loginAgain.status} revoked=${loginAgain.json?.revokedOtherSessions}`);
    const gotDisconnect = await disconnected;
    check('multi-login: re-login does not disconnect the old session socket',
      gotDisconnect === false && socket.connected === true,
      `disconnected=${gotDisconnect} connected=${socket.connected}`);
    const savedCookie = cookie;
    cookie = cookieBefore;
    r = await api('GET', '/api/accounts');
    check('multi-login: old session cookie still works after re-login (200)', r.status === 200, `status=${r.status}`);
    cookie = savedCookie;
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
  // 发信收件人格式校验（用户 2026-11-19 要求：收件人必填、格式不正确不得
  // 发送；抄送同样校验）：缺收件人/非法收件人/非法抄送 -> 400，不走到 SMTP；
  // 全角逗号分隔的合法地址应通过格式关（假账号 SMTP 502 即证明已走到发信）。
  r = await api('POST', '/api/messages/send', {
    accountId: idemAccountId, subject: 'no to', text: 'hi',
  });
  check('send validation: missing to -> 400 收件人必填',
    r.status === 400 && r.json?.error === '收件人必填', `status=${r.status} error=${r.json?.error}`);
  r = await api('POST', '/api/messages/send', {
    accountId: idemAccountId, to: 'not-an-email', subject: 'x', text: 'hi',
  });
  check('send validation: invalid to -> 400 (not-an-email)',
    r.status === 400 && typeof r.json?.error === 'string' && r.json.error.includes('not-an-email'),
    `status=${r.status} error=${r.json?.error}`);
  r = await api('POST', '/api/messages/send', {
    accountId: idemAccountId, to: 'x@163.com', cc: 'bad-cc', subject: 'x', text: 'hi',
  });
  check('send validation: invalid cc -> 400 (bad-cc)',
    r.status === 400 && typeof r.json?.error === 'string' && r.json.error.includes('bad-cc'),
    `status=${r.status} error=${r.json?.error}`);
  r = await api('POST', '/api/messages/send', {
    accountId: idemAccountId, to: 'a@163.com，b@163.com', subject: 'x', text: 'hi',
  });
  check('send validation: full-width comma separated to passes format check (reaches SMTP 502)',
    r.status === 502, `status=${r.status} error=${r.json?.error}`);

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
    // Audit #10 M-19（审计 #9 H1）：批量删除同一请求内 id 重复只执行一次
    // ——旧版第二轮走彻底删除分支永久删信。任务 total 应为去重后的 1。
    const dDup = mkDel(9004);
    r = await api('POST', '/api/messages/batch-delete', { ids: [dDup, dDup] });
    const dupTask = r.json?.taskId;
    let stDup = null;
    for (let i = 0; i < 40; i++) {
      const s = await api('GET', `/api/messages/delete-status?taskId=${encodeURIComponent(dupTask)}`);
      stDup = s.json;
      if (stDup && stDup.running === false) break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    check('audit10 M-19 (audit9 H1): batch-delete with duplicate ids runs once (total=1, deleted+failed=1)',
      stDup && stDup.running === false && stDup.total === 1 && (stDup.deleted + (stDup.failed || []).length) === 1,
      JSON.stringify(stDup)?.slice(0, 200));
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
    // Audit #12 H1：清扫按指纹补扫——OquMail 服务器副本 Message-ID 不同，
    // 只按 Message-ID 扫找不到它；删已发送的信时指纹相同的副本 UID 也要删掉。
    {
      const MID_OWN = '<fp-own@luck-mail.local>';
      const MID_SRV = '<fp-server@heavycrusher.com>';
      const a = vdb.prepare(
        `INSERT INTO accounts (email, display_name, password_enc, imap_host, imap_port, imap_secure,
          smtp_host, smtp_port, smtp_secure, enabled, status) VALUES (?,?,?,?,?,?,?,?,?,?, 'offline')`,
      ).run('sweep-fp@163.com', 'SF', encryptSecret('FAKE', key),
        'imap.163.com', 993, 'SSL', 'smtp.163.com', 465, 'SSL', 0);
      const accountId = Number(a.lastInsertRowid);
      const sentF = vdb.prepare("INSERT INTO folders (account_id, path, name, type) VALUES (?, '已发送', '已发送', 'sent')").run(accountId);
      const sentId = Number(sentF.lastInsertRowid);
      const trashF = vdb.prepare("INSERT INTO folders (account_id, path, name, type) VALUES (?, '已删除', '已删除', 'trash')").run(accountId);
      const trashId = Number(trashF.lastInsertRowid);
      // 行的 date/size 与 mkEnv 的信封一致（2026-11-18T10:00:00Z / 100），
      // 否则指纹比对不上。
      const msgInfo = vdb.prepare(`INSERT INTO messages (account_id, folder_id, uid, message_id, subject, from_addr,
        from_name, to_json, date, snippet, is_read, has_attachments, size, flags_json)
        VALUES (?,?,?,?,?,?,?, ?,'2026-11-18T10:00:00Z','',1,0,100,'[]')`).run(
        accountId, sentId, 100, MID_OWN, 'fp sweep', 'sweep-fp@163.com', 'SF', '[]');
      const msgId = Number(msgInfo.lastInsertRowid);
      const calls = { move: [], deleted: [] };
      const fakeClient = {
        usable: true,
        mailbox: { path: '已发送' },
        mailboxOpen: async (p) => { fakeClient.mailbox = { path: p }; return { uidValidity: undefined, uidNext: undefined, highestModseq: null, exists: 2 }; },
        search: async () => [100, 101],
        fetch: async function* () { yield mkEnv(100, MID_OWN, 'fp sweep', 'sweep-fp@163.com'); yield mkEnv(101, MID_SRV, 'fp sweep', 'sweep-fp@163.com'); },
        messageMove: async (uid, target) => { calls.move.push([uid, target]); return { uidMap: new Map([[100, 200]]) }; },
        messageFlagsAdd: async (uid) => { /* sweep 用 */ },
        messageDelete: async (uid) => { calls.deleted.push(uid); },
      };
      const engine = new SyncEngine(key);
      engine.states.set(accountId, { client: fakeClient, queue: Promise.resolve(), opFailures: 0 });
      const ok = await engine.deleteMessage(accountId, msgId);
      const rowAfter = vdb.prepare('SELECT folder_id, uid FROM messages WHERE id=?').get(msgId);
      check('audit12 H1: deleting a sent message also deletes the OquMail server twin (different Message-ID, same fingerprint uid 101)',
        ok === true
        && calls.move.length === 1 && calls.move[0][0] === '100' && calls.move[0][1] === '已删除'
        && calls.deleted.length === 1 && calls.deleted[0] === '101'
        && rowAfter.folder_id === trashId && rowAfter.uid === 200,
        `move=${JSON.stringify(calls.move)} deleted=${JSON.stringify(calls.deleted)} row=${JSON.stringify(rowAfter)}`);
      engine.states.delete(accountId);
    }
    // Audit #12 M1：垃圾邮件移回收件箱成功路径——engine.moveMessage 对
    // 源/目标文件夹类型无限制（前端入口由前端线补）。
    {
      const a = vdb.prepare(
        `INSERT INTO accounts (email, display_name, password_enc, imap_host, imap_port, imap_secure,
          smtp_host, smtp_port, smtp_secure, enabled, status) VALUES (?,?,?,?,?,?,?,?,?,?, 'offline')`,
      ).run('move-spam@163.com', 'MS', encryptSecret('FAKE', key),
        'imap.163.com', 993, 'SSL', 'smtp.163.com', 465, 'SSL', 0);
      const accountId = Number(a.lastInsertRowid);
      const spamF = vdb.prepare("INSERT INTO folders (account_id, path, name, type) VALUES (?, '垃圾邮件', '垃圾邮件', 'spam')").run(accountId);
      const spamId = Number(spamF.lastInsertRowid);
      const inboxF = vdb.prepare("INSERT INTO folders (account_id, path, name, type) VALUES (?, 'INBOX', '收件箱', 'inbox')").run(accountId);
      const inboxId = Number(inboxF.lastInsertRowid);
      const msgInfo = vdb.prepare(`INSERT INTO messages (account_id, folder_id, uid, message_id, subject, from_addr,
        from_name, to_json, date, snippet, is_read, has_attachments, size, flags_json)
        VALUES (?,?,?,?,?,?,?, ?,datetime('now'),'',0,0,100,'[]')`).run(
        accountId, spamId, 50, '<spam-move@x>', 'spam to inbox', 'spam@163.com', 'SM', '[]');
      const msgId = Number(msgInfo.lastInsertRowid);
      const calls = { move: [] };
      const fakeClient = {
        usable: true,
        mailbox: { path: '垃圾邮件' },
        mailboxOpen: async (p) => { fakeClient.mailbox = { path: p }; return { uidValidity: undefined, uidNext: undefined, highestModseq: null, exists: 1 }; },
        messageMove: async (uid, target) => { calls.move.push([uid, target]); return { uidMap: new Map([[50, 60]]) }; },
      };
      const engine = new SyncEngine(key);
      engine.states.set(accountId, { client: fakeClient, queue: Promise.resolve(), opFailures: 0 });
      const moved = await engine.moveMessage(accountId, msgId, inboxId);
      const rowAfter = vdb.prepare('SELECT folder_id, uid FROM messages WHERE id=?').get(msgId);
      check('audit12 M1: move from spam to inbox succeeds (row folder+uid updated, IMAP move to INBOX)',
        moved.folder_id === inboxId && rowAfter.folder_id === inboxId && rowAfter.uid === 60
        && calls.move.length === 1 && calls.move[0][0] === '50' && calls.move[0][1] === 'INBOX',
        `move=${JSON.stringify(calls.move)} row=${JSON.stringify(rowAfter)}`);
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
    const { SyncEngine, flagsSyncIntervalMs } = await import('../dist/engine.js');
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
    // Audit #9 H2：伪造客户端抛认证错后，_pollAllFolders 置 authFailed、
    // 停轮询，下一轮不再建连（不再拿错凭证登录）。
    const engineH2 = new SyncEngine(key);
    let h2Calls = 0;
    engineH2.withClient = async (...args) => {
      h2Calls++;
      const authErr = new Error('Command failed');
      authErr.authenticationFailed = true;
      throw authErr;
    };
    engineH2.states.set(h1Id, { authFailed: false, pollOnly: true, connecting: false, queue: Promise.resolve(), syncTimer: null });
    await engineH2._pollAllFolders(h1Id);
    await engineH2._pollAllFolders(h1Id);
    const h2State = engineH2.states.get(h1Id);
    check('audit9 H2: _pollAllFolders marks authFailed on auth error and makes no further login attempts',
      h2Calls === 1 && h2State?.authFailed === true, `withClientCalls=${h2Calls} authFailed=${h2State?.authFailed}`);
    // Audit #9 L6：全量 flags 同步间隔按文件夹大小分档（纯函数断言）。
    const MIN = 60 * 1000;
    check('audit9 L6: flagsSyncIntervalMs tiers (<500→15m, 500–2000→30m, >2000→60m cap)',
      flagsSyncIntervalMs(0) === 15 * MIN && flagsSyncIntervalMs(499) === 15 * MIN
      && flagsSyncIntervalMs(500) === 30 * MIN && flagsSyncIntervalMs(2000) === 30 * MIN
      && flagsSyncIntervalMs(2001) === 60 * MIN && flagsSyncIntervalMs(100000) === 60 * MIN
      && flagsSyncIntervalMs(NaN) === 15 * MIN,
      `0=${flagsSyncIntervalMs(0)} 499=${flagsSyncIntervalMs(499)} 500=${flagsSyncIntervalMs(500)} 2000=${flagsSyncIntervalMs(2000)} 2001=${flagsSyncIntervalMs(2001)}`);
    // 同款档位走 _syncFlagsFull 的节流：上次跑完 20 分钟的文件夹，5000 封
    // 档（60 分钟）应跳过不 FETCH，100 封档（15 分钟）应跑。
    const engineL6 = new SyncEngine(key);
    const fakeFolderL6 = { id: 987001 };
    let l6Fetches = 0;
    const fakeClientL6 = { fetch: async function* () { l6Fetches++; } };
    engineL6.lastFullFlagSync.set(987001, Date.now() - 20 * MIN);
    await engineL6._syncFlagsFull(fakeClientL6, h1Id, fakeFolderL6, 5000);
    check('audit9 L6: _syncFlagsFull skips FETCH inside the 60m tier (20m since last run, 5000 msgs)',
      l6Fetches === 0, `fetches=${l6Fetches}`);
    await engineL6._syncFlagsFull(fakeClientL6, h1Id, fakeFolderL6, 100);
    check('audit9 L6: _syncFlagsFull runs FETCH past the 15m tier (20m since last run, 100 msgs)',
      l6Fetches === 1, `fetches=${l6Fetches}`);
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

  // 依赖版本（5/6/7）：multer 2.5.0（审计 #11 L9 由 2.0.1 升级，CVE-2026-113872
  // 修复版）、nodemailer 10.6.0、imapflow 2.12.1。
  {
    const pkg = JSON.parse(fs.readFileSync(path.join(BACKEND, 'package.json'), 'utf8'));
    const depVer = (name) => String(pkg.dependencies?.[name] || '').replace(/^\^/, '');
    check('deps: multer 2.5.0 / nodemailer 10.6.0 / imapflow 2.12.1 in package.json',
      depVer('multer') === '2.5.0'
      && depVer('nodemailer') === '10.6.0'
      && depVer('imapflow') === '2.12.1',
      JSON.stringify({ m: depVer('multer'), n: depVer('nodemailer'), i: depVer('imapflow') }));
    const lock = JSON.parse(fs.readFileSync(path.join(BACKEND, 'package-lock.json'), 'utf8'));
    const lv = (name) => lock.packages?.[`node_modules/${name}`]?.version;
    check('deps: package-lock.json matches (multer/nodemailer/imapflow)',
      lv('multer') === '2.5.0' && lv('nodemailer') === '10.6.0' && lv('imapflow') === '2.12.1',
      JSON.stringify({ m: lv('multer'), n: lv('nodemailer'), i: lv('imapflow') }));
  }

  // 28: CSV 导入 + 模板 + xlsx 拒绝。
  async function apiMultipart(p, fileName, content, mime = 'text/csv') {
    const fd = new FormData();
    fd.append('file', new Blob([content], { type: mime }), fileName);
    // Audit #10 M-5：直接 fetch 须自带同源 Origin（严格 CSRF）。
    const res = await fetch(BASE + p, { method: 'POST', headers: { Cookie: cookie, Origin: BASE }, body: fd });
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
  // Audit #11 threading：草稿存 threading 字段（回复/转发重开后不丢）——
  // POST 存 inReplyTo/references/cc，GET 原样返回（references 回数组）。
  r = await api('POST', '/api/drafts', { accountId, to: 'c@163.com', subject: 're', text: 'hi',
    inReplyTo: '<orig@163.com>', references: ['<a@x>', '<b@y>'], cc: ['cc@163.com'] });
  const draft3 = r.json?.draft;
  check('audit11 threading: POST /api/drafts stores inReplyTo/references/cc',
    r.status === 201 && draft3?.inReplyTo === '<orig@163.com>'
    && JSON.stringify(draft3?.references) === JSON.stringify(['<a@x>', '<b@y>'])
    && JSON.stringify(draft3?.cc) === JSON.stringify(['cc@163.com']),
    `status=${r.status} draft=${JSON.stringify(draft3)}`);
  r = await api('PUT', `/api/drafts/${draft3.id}`, { subject: 're2' });
  check('audit11 threading: PUT without threading fields keeps them',
    r.status === 200 && r.json?.draft?.inReplyTo === '<orig@163.com>'
    && JSON.stringify(r.json?.draft?.references) === JSON.stringify(['<a@x>', '<b@y>'])
    && JSON.stringify(r.json?.draft?.cc) === JSON.stringify(['cc@163.com']),
    `status=${r.status} draft=${JSON.stringify(r.json?.draft)}`);
  r = await api('PUT', `/api/drafts/${draft3.id}`, { references: '<c@z>' });
  check('audit11 threading: PUT accepts references as a plain string',
    r.status === 200 && JSON.stringify(r.json?.draft?.references) === JSON.stringify(['<c@z>']),
    `status=${r.status} draft=${JSON.stringify(r.json?.draft)}`);
  await api('DELETE', `/api/drafts/${draft3.id}`);
  // Audit #11 threading：详情接口返回 replyTo（字符串或 null）与数组
  // 形式的 references（库里是空格拼成的字符串，这里切开返回）。
  // 注意：第 6 节已给 m1 写过 message_id/references 种子值，这里只改
  // reply_to 与 references，messageId 仍是第 6 节的种子值。
  db.prepare('UPDATE messages SET reply_to=?, "references"=? WHERE id=?')
    .run('replyto@163.com', '<a@x> <b@y>', m1);
  r = await api('GET', `/api/messages/${m1}`);
  check('audit11 threading: GET /api/messages/:id returns replyTo + references array',
    r.status === 200 && r.json?.message?.replyTo === 'replyto@163.com'
    && JSON.stringify(r.json?.message?.references) === JSON.stringify(['<a@x>', '<b@y>'])
    && r.json?.message?.messageId === '<seed-m1@luck-mail.test>',
    `status=${r.status} message=${JSON.stringify(r.json?.message)?.slice(0, 300)}`);

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
  // Audit #10 M-6：delete_idempotency 加状态列——进行中重认领返回 409，
  // 不再谎报成功；进行中行超 10 分钟过期可重认领。
  vdb.prepare("INSERT INTO delete_idempotency (idempotency_key, message_db_id, status, created_at) VALUES (?,?, 'in_progress', datetime('now'))")
    .run('del-inprog-1', 424242);
  r = await api('DELETE', '/api/messages/424242?idempotencyKey=del-inprog-1');
  check('audit10 M-6: single delete with an in-progress claim -> 409 DELETE_IN_FLIGHT',
    r.status === 409 && /正在删除中/.test(r.json?.error || ''), `status=${r.status} body=${JSON.stringify(r.json)}`);
  vdb.prepare("INSERT INTO delete_idempotency (idempotency_key, message_db_id, status, created_at) VALUES (?,?, 'in_progress', datetime('now','-11 minutes'))")
    .run('del-stale-1', 424242);
  r = await api('DELETE', '/api/messages/424242?idempotencyKey=del-stale-1');
  check('audit10 M-6: stale in-progress claim (>10min) can be re-claimed (not 409)',
    r.status !== 409, `status=${r.status} body=${JSON.stringify(r.json)}`);
  vdb.prepare("INSERT INTO delete_idempotency (idempotency_key, task_id, status, created_at) VALUES (?,?, 'in_progress', datetime('now'))")
    .run('del-batch-inprog-1', '11111111-1111-1111-1111-111111111111');
  r = await api('POST', '/api/messages/batch-delete', { ids: [m1], idempotencyKey: 'del-batch-inprog-1' });
  // 批量任务进行中重提交应返回同一 taskId（可轮询，审计 #7 L1 契约），
  // 而不是 409——409 只适用于单删（无任务可轮询）。
  check('audit10 M-6: batch-delete with an in-progress claim returns the SAME taskId (duplicate, pollable)',
    r.status === 200 && r.json?.taskId === '11111111-1111-1111-1111-111111111111' && r.json?.duplicate === true,
    `status=${r.status} body=${JSON.stringify(r.json)}`);
  // key 正被单删占用（进行中行、无 task_id）时批量提交报 409。
  vdb.prepare("INSERT INTO delete_idempotency (idempotency_key, message_db_id, status, created_at) VALUES (?,?, 'in_progress', datetime('now'))")
    .run('del-batch-occupied-1', 424242);
  r = await api('POST', '/api/messages/batch-delete', { ids: [m1], idempotencyKey: 'del-batch-occupied-1' });
  check('audit10 M-6: batch-delete with a key held by a running single delete -> 409',
    r.status === 409, `status=${r.status} body=${JSON.stringify(r.json)}`);
  r = await api('DELETE', '/api/messages/424242?idempotencyKey=' + 'x'.repeat(129));
  check('L1: over-long idempotencyKey -> 400', r.status === 400, `status=${r.status}`);
  // Audit #11 L1：移动路由也把 409 映射出来（与单删同款）——同一封信
  // 移动与移动并发时，第二路应报 409“正在处理中”，而不是 502“移动失败”。
  // 注意：种子账号原本没有 trash 文件夹（后续 MED-1 并发删信测试依赖
  // “执行路因无 trash 文件夹而快速 502”），这里临时建一个、测完即删，
  // 不污染共享种子状态。
  const mMove = mkMsg(4, '移动冲突测试', 'move@163.com', '移动 409 测试');
  const trashInfo = db.prepare(
    "INSERT INTO folders (account_id, path, name, type) VALUES (?, 'Trash', '已删除', 'trash')",
  ).run(accountId);
  const trashFolderId = Number(trashInfo.lastInsertRowid);
  {
    const [v1, v2] = await Promise.all([
      api('POST', `/api/messages/${mMove}/move`, { folderId: trashFolderId }),
      api('POST', `/api/messages/${mMove}/move`, { folderId: trashFolderId }),
    ]);
    const conflict = [v1, v2].filter((x) => x.status === 409 && /正在处理中/.test(x.json?.error || '')).length;
    const other = [v1, v2].filter((x) => x.status !== 409).length;
    check('audit11 L1: concurrent moves of the same message -> one 409 in-flight, one non-409',
      conflict === 1 && other === 1, `v1=${v1.status}/${JSON.stringify(v1.json)} v2=${v2.status}/${JSON.stringify(v2.json)}`);
  }
  db.prepare('DELETE FROM folders WHERE id=?').run(trashFolderId);
  // Audit #7 MED-1：并发同 key 单删——先占位后删除。两路并发 DELETE 带
  // 同一 key 时，只有一路真正执行删除（这里因种子账号无 trash 文件夹
  // 而 502），另一路不执行第二次删除。
  // Audit #9 L14 之后：执行路失败会给占位行打 failed_at，第二路读到
  // 失败标记后返回 502“上次删除失败，请用新的删除操作重试”，不再谎报
  // duplicate:true——两路都是 502，但文案不同（执行路“IMAP 删除失败”，
  // 第二路“上次删除失败”），且占位行只有一行，证明只执行了一次。
  const mConc = mkMsg(3, '并发删信测试', 'conc@163.com', '并发同 key 单删');
  {
    const [c1, c2] = await Promise.all([
      api('DELETE', `/api/messages/${mConc}?idempotencyKey=del-conc-1`),
      api('DELETE', `/api/messages/${mConc}?idempotencyKey=del-conc-1`),
    ]);
    const executor = [c1, c2].filter((x) => /IMAP 删除失败：/.test(x.json?.error || '')).length;
    const loser = [c1, c2].filter((x) => /上次删除失败/.test(x.json?.error || '')).length;
    check('MED-1: concurrent same-key single deletes -> one executor 502, one failed-claim 502 (L14), no second execution',
      executor === 1 && loser === 1, `c1=${c1.status}/${JSON.stringify(c1.json)} c2=${c2.status}/${JSON.stringify(c2.json)}`);
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
      const impRes = await fetch(BASE + '/api/accounts/import', { method: 'POST', headers: { Cookie: cookie, Origin: BASE }, body: form });
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
    const impRes = await fetch(BASE + '/api/accounts/import', { method: 'POST', headers: { Cookie: cookie, Origin: BASE }, body: form });
    const imp = await impRes.json();
    const bad = (imp?.failed || []).find((f) => f.email === 'realbadimport@163.com');
    check('import18b-fallback: real-163 bad row goes to failed with a clear auth reason, no account created',
      impRes.status === 200 && !!bad && /认证被拒|用户名或密码/.test(bad.reason)
      && !db.prepare('SELECT id FROM accounts WHERE email=?').get('realbadimport@163.com'),
      `status=${impRes.status} failed=${JSON.stringify(imp?.failed)?.slice(0, 160)}`);
  }

  // ---------- 19. audit #10 fixes ----------
  console.log('== audit #10 fixes ==');
  // M-5 严格 CSRF：已认证写请求跨站 Origin → 403；缺失 Origin → 403；
  // 同源 Origin → 正常 200。
  r = await api('PUT', '/api/settings', { signature: '-- Tester' }, { Origin: 'https://evil.example' });
  check('audit10 M-5: authenticated write with cross-origin Origin -> 403',
    r.status === 403, `status=${r.status}`);
  r = await api('PUT', '/api/settings', { signature: '-- Tester' }, { Origin: '' });
  check('audit10 M-5: authenticated write without Origin -> 403',
    r.status === 403, `status=${r.status}`);
  r = await api('PUT', '/api/settings', { signature: '-- Tester' });
  check('audit10 M-5: authenticated write with same-origin Origin -> 200',
    r.status === 200 && r.json?.settings?.signature === '-- Tester', `status=${r.status}`);
  // M-2：回环/私有字面 IP 拒绝——函数级断言（本测试进程未设
  // ALLOW_PRIVATE_MAIL_HOSTS，拒绝路径如实触发）+ testConnectivity
  // 直接调用（不触网、文案统一）。
  {
    const { isPrivateOrLoopbackHost, hostsResolveToPrivate, testConnectivity } = await import('../dist/imapUtil.js');
    check('audit10 M-2: isPrivateOrLoopbackHost rejects loopback/private/link-local/metadata',
      isPrivateOrLoopbackHost('127.0.0.1') && isPrivateOrLoopbackHost('10.0.0.5')
      && isPrivateOrLoopbackHost('192.168.1.1') && isPrivateOrLoopbackHost('169.254.169.254')
      && isPrivateOrLoopbackHost('::1') && isPrivateOrLoopbackHost('172.16.0.1'));
    // Audit #11 L7：非常规写法也解析成 127.0.0.1（Node dns.lookup 实测），
    // 归一化后必须同样拦截；::ffff:7f00:0001 是 IPv4 映射 IPv6 的十六进制写法。
    check('audit11 L7: isPrivateOrLoopbackHost blocks non-standard loopback spellings',
      isPrivateOrLoopbackHost('2130706433') && isPrivateOrLoopbackHost('0x7f.0.0.1')
      && isPrivateOrLoopbackHost('0177.0.0.1') && isPrivateOrLoopbackHost('0x7f000001')
      && isPrivateOrLoopbackHost('::ffff:127.0.0.1') && isPrivateOrLoopbackHost('::ffff:7f00:0001')
      && isPrivateOrLoopbackHost('::ffff:7f00:1'));
    // Audit #16 LOW-1：IPv4 映射 IPv6 的十六进制写法不止 2 段——
    // ::ffff:0:7f00:0001、::ffff:0:0:7f00:0001 都是 127.0.0.1，
    // 旧版只认恰好 2 段；公网映射地址（::ffff:0:808:0808 = 8.8.8.8）
    // 仍放行；解析层（dns.lookup 原样返回该字面量）也须拦住。
    check('audit16 LOW-1: isPrivateOrLoopbackHost blocks multi-segment ::ffff: hex loopback spellings',
      isPrivateOrLoopbackHost('::ffff:0:7f00:0001') && isPrivateOrLoopbackHost('::ffff:0:0:7f00:0001')
      && isPrivateOrLoopbackHost('::ffff:0:0:0:0:0:7f00:1')
      && !isPrivateOrLoopbackHost('::ffff:0:808:0808') && !isPrivateOrLoopbackHost('::ffff:808:808'));
    check('audit16 LOW-1: hostsResolveToPrivate flags a multi-segment ::ffff: loopback literal',
      (await hostsResolveToPrivate(['::ffff:0:7f00:0001'])) === true);
    // Audit #17 LOW-1：IPv4 映射/兼容写法不止 ::ffff: 前缀——未压缩的
    // 0:0:0:0:0:ffff:7f00:1 与兼容形式 ::7f00:1、0:0:0:0:0:0:7f00:1
    // 都是 127.0.0.1；公网对照 0:0:0:0:0:ffff:0808:0808、::0808:0808
    //（= 8.8.8.8）与前段非零的 2001:db8::7f00:1 仍放行。
    check('audit17 LOW-1: isPrivateOrLoopbackHost blocks uncompressed mapped + IPv4-compatible loopback spellings',
      isPrivateOrLoopbackHost('0:0:0:0:0:ffff:7f00:1') && isPrivateOrLoopbackHost('::7f00:1')
      && isPrivateOrLoopbackHost('0:0:0:0:0:0:7f00:1')
      && !isPrivateOrLoopbackHost('0:0:0:0:0:ffff:0808:0808') && !isPrivateOrLoopbackHost('::0808:0808')
      && !isPrivateOrLoopbackHost('2001:db8::7f00:1'));
    check('audit17 LOW-1: hostsResolveToPrivate flags an IPv4-compatible loopback literal',
      (await hostsResolveToPrivate(['::7f00:1'])) === true);
    check('audit11 L7: isPrivateOrLoopbackHost still allows public hosts in odd forms',
      !isPrivateOrLoopbackHost('8.8.8.8') && !isPrivateOrLoopbackHost('134744072'));
    // Audit #12 L4：解析到私有地址的主机名也被拦——ip6-localhost 经本地
    // 解析得 ::1（无需联网），字面量检查放过它（不是字面 IP），DNS
    // 校验必须拦住；8.8.8.8 解析后仍是公网地址，放行。
    check('audit12 L4: hostsResolveToPrivate flags a hostname resolving to loopback',
      (await hostsResolveToPrivate(['ip6-localhost'])) === true);
    check('audit12 L4: hostsResolveToPrivate allows a public literal IP',
      (await hostsResolveToPrivate(['8.8.8.8'])) === false);
    const dnsPriv = await testConnectivity(
      { email: 'x@y.z', password: 'p', imapHost: 'ip6-localhost', imapPort: 993, imapSecure: 'SSL', smtpHost: 'ip6-localhost', smtpPort: 465, smtpSecure: 'SSL' },
      'p',
    );
    check('audit12 L4: testConnectivity rejects a hostname resolving to loopback with the unified message',
      dnsPriv.imapOk === false && dnsPriv.error === '连接失败（服务器地址不合法）', JSON.stringify(dnsPriv));
    check('audit10 M-2: isPrivateOrLoopbackHost allows public hosts',
      !isPrivateOrLoopbackHost('imap.163.com') && !isPrivateOrLoopbackHost('8.8.8.8')
      && !isPrivateOrLoopbackHost('1.1.1.1'));
    const priv = await testConnectivity(
      { email: 'x@y.z', password: 'p', imapHost: '127.0.0.1', imapPort: 993, imapSecure: 'SSL', smtpHost: '127.0.0.1', smtpPort: 465, smtpSecure: 'SSL' },
      'p',
    );
    check('audit10 M-2: testConnectivity rejects loopback literal IP with the unified message',
      priv.imapOk === false && priv.error === '连接失败（服务器地址不合法）', JSON.stringify(priv));
  }
  // M-5 约定：取邮箱明文密码由 GET 改为 POST（同路径、只改方法）。
  r = await api('GET', `/api/accounts/${accountId}/password`);
  check('audit10 M-5: GET /api/accounts/:id/password is gone (404)', r.status === 404, `status=${r.status}`);
  r = await api('POST', `/api/accounts/${accountId}/password`);
  check('audit10 M-5: POST /api/accounts/:id/password returns the plaintext password',
    r.status === 200 && r.json?.password === 'FAKE_AUTH_CODE_123', `status=${r.status} password=${r.json?.password}`);
  // Audit #10 L-11：M5 补的两个新索引存在，且账号级视图走索引。
  {
    const idxList10 = (table) => db.prepare(`PRAGMA index_list(${table})`).all().map((x) => x.name);
    const msgIdx10 = idxList10('messages');
    check('audit10 L-11: idx_messages_folder_date + idx_messages_account_date exist',
      msgIdx10.includes('idx_messages_folder_date') && msgIdx10.includes('idx_messages_account_date'), msgIdx10.join(','));
    const plan10 = (sql) => db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all().map((x) => x.detail).join(' | ');
    const pAcc = plan10('SELECT id FROM messages WHERE account_id=1 ORDER BY date DESC, id DESC LIMIT 50');
    check('audit10 L-11: account view uses idx_messages_account_date (no SCAN messages)',
      pAcc.includes('SEARCH messages USING COVERING INDEX idx_messages_account_date') && !pAcc.includes('SCAN messages'),
      pAcc);
  }
  // M-9/M-14/M-13/M-8：关键重构在位（源码级回归标记，与本文件既有
  // “SyncEngine has _pollAllFolders”同款做法）。
  {
    const msgRoutesSrc = fs.readFileSync(path.join(BACKEND, 'src/routes/messageRoutes.ts'), 'utf8');
    const engineSrc = fs.readFileSync(path.join(BACKEND, 'src/engine.ts'), 'utf8');
    const dbSrc = fs.readFileSync(path.join(BACKEND, 'src/db.ts'), 'utf8');
    check('audit10 M-9: translate deadline is wired into AbortSignal',
      msgRoutesSrc.includes('AbortSignal.any'));
    // Audit #11 L2：翻译 deadline 到时不再静默 return——循环内三处与
    // catch 里共四处 aborted 检查都应在客户端还连着时回 504（行为断言
    // 要等满 25 秒总预算，不稳定；此处用源码回归标记，见同款做法）。
    check('audit11 L2: no silent `if (controller.signal.aborted) return;` left in translate route',
      !msgRoutesSrc.includes('if (controller.signal.aborted) return;'));
    check('audit11 L2: translate aborted branches answer 504 when the client is still connected',
      msgRoutesSrc.includes("if (!req.destroyed) res.status(504).json({ ok: false, error: '翻译超时（超过 25 秒），请缩短正文后重试' })"));
    check('audit10 M-14: batch delete shares one withClient session (deleteMessagesBatch)',
      engineSrc.includes('deleteMessagesBatch'));
    check('audit10 M-13: full-envelope fetch is paged (ENVELOPE_PAGE_SIZE)',
      engineSrc.includes('ENVELOPE_PAGE_SIZE'));
    check('audit10 M-8: search fetches a 2001-row superset per branch before intersecting',
      dbSrc.includes('LIMIT 2001'));
  }
  // M-7：所有发信出口都带 idempotencyKey——404 与 400 也带。
  r = await api('POST', '/api/messages/send', { accountId: 999999, to: ['a@b.c'], subject: 'x', text: 'y', idempotencyKey: 'send-key-404' });
  check('audit10 M-7: send 404 still returns the idempotencyKey',
    r.status === 404 && r.json?.idempotencyKey === 'send-key-404', `status=${r.status} body=${JSON.stringify(r.json)?.slice(0, 160)}`);
  r = await api('POST', '/api/messages/send', { accountId, to: [], subject: 'x', text: 'y', idempotencyKey: 'send-key-400' });
  check('audit10 M-7: send 400 still returns the idempotencyKey',
    r.status === 400 && r.json?.idempotencyKey === 'send-key-400', `status=${r.status} body=${JSON.stringify(r.json)?.slice(0, 160)}`);
  // H-3：CSV 导入超 200 行立即停并标 truncated，failed 封顶 50 条。
  {
    const rows = ['序号,邮箱名,授权码,接收服务器（IMAP）,IMAP端口,发送服务器（SMTP）,SMTP端口,备注'];
    for (let i = 1; i <= 205; i++) rows.push(`${i},h3user${i}@example.com,FAKE,127.0.0.1,9,127.0.0.1,9,`);
    const t0 = Date.now();
    const imp3 = await apiMultipart('/api/accounts/import', 'import.csv', rows.join('\r\n'));
    const imp3Dt = Date.now() - t0;
    check('audit10 H-3: import of 205 rows stops after 200 (truncated:true, added=0, failed capped at 50 + failedTruncated)',
      imp3.status === 200 && imp3.json?.truncated === true && imp3.json?.added === 0
      && (imp3.json?.failed || []).length === 50 && imp3.json?.failedTruncated === true,
      `status=${imp3.status} dt=${imp3Dt}ms added=${imp3.json?.added} failed=${(imp3.json?.failed || []).length} truncated=${imp3.json?.truncated} failedTruncated=${imp3.json?.failedTruncated}`);
    check('audit10 H-3: no account was created by the oversized import',
      !db.prepare('SELECT id FROM accounts WHERE email LIKE ?').get('h3user%@example.com'));
  }
  // D5：账号总数上限 50——POST /api/accounts 与 CSV 导入都校验。
  {
    const beforeCount = (db.prepare('SELECT COUNT(*) c FROM accounts').get()).c;
    const need = 50 - beforeCount;
    for (let i = 0; i < need; i++) {
      db.prepare(
        `INSERT INTO accounts (email, display_name, password_enc, imap_host, imap_port, imap_secure,
          smtp_host, smtp_port, smtp_secure, enabled, status) VALUES (?,?,?,?,?,?,?,?,?,?, 'offline')`,
      ).run(`cap${i}@163.com`, `Cap${i}`, encryptSecret('FAKE', key),
        'imap.163.com', 993, 'SSL', 'smtp.163.com', 465, 'SSL', 0);
    }
    const atCap = (db.prepare('SELECT COUNT(*) c FROM accounts').get()).c;
    // 添加邮箱必填校验（用户 2026-11-19 要求）：须带齐服务器，否则在
    // 上限检查之前就因缺服务器 400，到不了“已达上限”的断言。
    r = await api('POST', '/api/accounts', { email: 'cap51@163.com', password: 'x', imapHost: 'imap.163.com', imapPort: 993, imapSecure: 'SSL', smtpHost: 'smtp.163.com', smtpPort: 465, smtpSecure: 'SSL' });
    check('audit10 D5: POST /api/accounts at 50 accounts -> 400 (limit)',
      atCap === 50 && r.status === 400 && /已达上限/.test(r.json?.error || ''),
      `count=${atCap} status=${r.status} error=${r.json?.error}`);
    const capCsv = await apiMultipart('/api/accounts/import', 'import.csv',
      '序号,邮箱名,授权码,接收服务器（IMAP）,IMAP端口,发送服务器（SMTP）,SMTP端口,备注\r\n1,capimport@163.com,FAKE,imap.163.com,993,smtp.163.com,465,');
    const capFailed = (capCsv.json?.failed || []).find((f) => f.email === 'capimport@163.com');
    check('audit10 D5: CSV import at 50 accounts fails the row with the limit reason (added=0)',
      capCsv.json?.added === 0 && !!capFailed && /已达上限/.test(capFailed.reason || ''),
      `added=${capCsv.json?.added} failed=${JSON.stringify(capCsv.json?.failed)?.slice(0, 160)}`);
    db.prepare("DELETE FROM accounts WHERE email LIKE 'cap%@163.com'").run();
    const afterCount = (db.prepare('SELECT COUNT(*) c FROM accounts').get()).c;
    check('audit10 D5: seeded cap accounts cleaned up', afterCount === beforeCount, `before=${beforeCount} after=${afterCount}`);
  }

  // ---------- 20. OquMail 已发送未读 bug ----------
  console.log('== oqumail sent unread ==');
  {
    const { SyncEngine } = await import('../dist/engine.js');
    const oquAcc = vdb.prepare(
      `INSERT INTO accounts (email, display_name, password_enc, imap_host, imap_port, imap_secure,
        smtp_host, smtp_port, smtp_secure, enabled, status) VALUES (?,?,?,?,?,?,?,?,?,?, 'offline')`,
    ).run('oqu@163.com', 'OQ', encryptSecret('FAKE', key),
      'imap.163.com', 993, 'SSL', 'smtp.163.com', 465, 'SSL', 0);
    const oquAccId = Number(oquAcc.lastInsertRowid);
    const mkFolder = (type, folderPath, name) => Number(vdb.prepare(
      'INSERT INTO folders (account_id, path, name, type) VALUES (?,?,?,?)',
    ).run(oquAccId, folderPath, name, type).lastInsertRowid);
    const sentFId = mkFolder('sent', 'Sent', '已发送');
    const draftsFId = mkFolder('drafts', 'Drafts', '草稿箱');
    const inboxFId = mkFolder('inbox', 'INBOX', '收件箱');
    const folderRow = (id) => vdb.prepare('SELECT * FROM folders WHERE id=?').get(id);
    const mkFakeMsg = (uid, messageId, subject) => ({
      uid,
      flags: [], // OquMail: 已发送里的邮件没有 \Seen
      envelope: {
        messageId, subject,
        from: [{ address: 'oqu@163.com', name: '' }],
        to: [{ address: 'a@163.com' }],
        date: new Date(),
      },
      bodyStructure: null,
      size: 100,
      internalDate: new Date(),
    });
    const mkSyncClient = (msgs) => ({
      mailboxOpen: async () => ({ uidValidity: undefined, uidNext: undefined, highestModseq: null, exists: msgs.length }),
      search: async () => msgs.map((m) => m.uid),
      fetch: async function* () { for (const m of msgs) yield m; },
    });
    const engineOq = new SyncEngine(key);
    // (1) sent/drafts 文件夹无 \Seen 入库 → is_read=1；inbox 对照组仍为 0。
    await engineOq._syncFolder(mkSyncClient([mkFakeMsg(11, '<oq-sent@x>', 'sent no seen')]), oquAccId, folderRow(sentFId));
    await engineOq._syncFolder(mkSyncClient([mkFakeMsg(12, '<oq-draft@x>', 'draft no seen')]), oquAccId, folderRow(draftsFId));
    await engineOq._syncFolder(mkSyncClient([mkFakeMsg(13, '<oq-inbox@x>', 'inbox no seen')]), oquAccId, folderRow(inboxFId));
    const sentRead = vdb.prepare('SELECT is_read FROM messages WHERE message_id=?').get('<oq-sent@x>')?.is_read;
    const draftRead = vdb.prepare('SELECT is_read FROM messages WHERE message_id=?').get('<oq-draft@x>')?.is_read;
    const inboxRead = vdb.prepare('SELECT is_read FROM messages WHERE message_id=?').get('<oq-inbox@x>')?.is_read;
    check('oqumail: sent folder sync without \\Seen stores is_read=1',
      sentRead === 1, `is_read=${sentRead}`);
    check('oqumail: drafts folder sync without \\Seen stores is_read=1',
      draftRead === 1, `is_read=${draftRead}`);
    check('oqumail: inbox folder sync without \\Seen still stores is_read=0 (control)',
      inboxRead === 0, `is_read=${inboxRead}`);
    // (2) flags 全量对账不把 sent 行翻回未读（连 fetch 都不跑）；inbox
    // 对照组仍会被翻回未读（机制本身没坏）。
    let sentFetches = 0;
    const flagsClientSent = {
      fetch: async function* () { sentFetches++; yield { uid: 11, flags: [] }; },
    };
    await engineOq._syncFlagsFull(flagsClientSent, oquAccId, folderRow(sentFId));
    const sentStillRead = vdb.prepare('SELECT is_read FROM messages WHERE message_id=?').get('<oq-sent@x>')?.is_read;
    check('oqumail: _syncFlagsFull skips sent folders (no fetch, stays read)',
      sentFetches === 0 && sentStillRead === 1, `fetches=${sentFetches} is_read=${sentStillRead}`);
    const inboxReadId = Number(vdb.prepare(
      `INSERT INTO messages (account_id, folder_id, uid, message_id, subject, from_addr, to_json, date,
        snippet, body_path, is_read, has_attachments, size, flags_json, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,NULL,1,0,123,'[]',datetime('now','-10 minutes'))`,
    ).run(oquAccId, inboxFId, 14, '<oq-inbox-read@x>', 'inbox read', 'b@163.com', '[]', new Date().toISOString(), 'x').lastInsertRowid);
    void inboxReadId;
    engineOq.lastFullFlagSync.set(inboxFId, Date.now() - 20 * 60 * 1000);
    let inboxFetches = 0;
    const flagsClientInbox = {
      fetch: async function* () { inboxFetches++; yield { uid: 14, flags: [] }; },
    };
    await engineOq._syncFlagsFull(flagsClientInbox, oquAccId, folderRow(inboxFId));
    const inboxFlipped = vdb.prepare('SELECT is_read FROM messages WHERE message_id=?').get('<oq-inbox-read@x>')?.is_read;
    check('oqumail: _syncFlagsFull still flips inbox rows back to unread (control)',
      inboxFetches === 1 && inboxFlipped === 0, `fetches=${inboxFetches} is_read=${inboxFlipped}`);
    // (3) 合并路径：已发送里先到的无 \Seen 副本（旧数据）被去重合并时，
    // surviving 的行翻成已读。
    const staleSentId = Number(vdb.prepare(
      `INSERT INTO messages (account_id, folder_id, uid, message_id, subject, from_addr, to_json, date,
        snippet, body_path, is_read, has_attachments, size, flags_json)
       VALUES (?,?,?,?,?,?,?,?,?,NULL,0,0,123,'[]')`,
    ).run(oquAccId, sentFId, 21, '<oq-merge@x>', 'merge stale', 'oqu@163.com', '[]', new Date().toISOString(), 'x').lastInsertRowid);
    void staleSentId;
    // 假客户端的 search 须返回全部本地 UID（11、21）+ 新 UID 22——
    // 否则增量分支的删除对账会把 uid 11/21 当“服务器已删”删掉，
    // 测的就不是合并而是删除了。
    await engineOq._syncFolder(
      {
        mailboxOpen: async () => ({ uidValidity: undefined, uidNext: undefined, highestModseq: null, exists: 3 }),
        search: async () => [11, 21, 22],
        fetch: async function* () { yield mkFakeMsg(22, '<oq-merge@x>', 'merge stale'); },
      },
      oquAccId, folderRow(sentFId));
    const mergedRead = vdb.prepare('SELECT is_read FROM messages WHERE message_id=?').get('<oq-merge@x>')?.is_read;
    const mergedCount = vdb.prepare('SELECT COUNT(*) c FROM messages WHERE message_id=?').get('<oq-merge@x>').c;
    check('oqumail: dedup merge keeps the surviving sent row read (still 1 row, is_read=1)',
      mergedCount === 1 && mergedRead === 1, `count=${mergedCount} is_read=${mergedRead}`);
    // Audit #12 H1：OquMail 服务器副本（Message-ID 被重写）按指纹兜底去重——
    // 同一封信的两个副本（不同 Message-ID、同主题/发件人、时间差 4 秒、
    // 大小差 50 字节）只留一行；时间差 60 秒或大小差 5000 字节的则不合并。
    // search 须返回文件夹全部本地 UID（11、21 + 种子 31），否则增量分支
    // 的删除对账会把它们当“服务器已删”删掉（见 (3) 注释）。
    {
      const fpBase = new Date();
      const fpDateIso = fpBase.toISOString();
      const seedFp = vdb.prepare(`INSERT INTO messages (account_id, folder_id, uid, message_id, subject, from_addr,
        to_json, date, snippet, is_read, has_attachments, size, flags_json)
        VALUES (?,?,?,?,?,?,?, ?,?,1,0,900,'[]')`).run(
        oquAccId, sentFId, 31, '<fp-own@luck-mail.local>', 'fp dedup', 'oqu@163.com', '[]', fpDateIso, '');
      const seedFpId = Number(seedFp.lastInsertRowid);
      const fpMsg = (uid, mid, size, dateMs) => ({
        uid, flags: [],
        envelope: { messageId: mid, subject: 'fp dedup', from: [{ address: 'oqu@163.com', name: '' }], to: [{ address: 'a@163.com' }], date: new Date(dateMs) },
        bodyStructure: null, size, internalDate: new Date(dateMs),
      });
      const fpClient = (uids, msgs) => ({
        mailboxOpen: async () => ({ uidValidity: undefined, uidNext: undefined, highestModseq: null, exists: uids.length }),
        search: async () => uids,
        fetch: async function* () { for (const m of msgs) yield m; },
      });
      const fpCount = () => vdb.prepare('SELECT COUNT(*) c FROM messages WHERE folder_id=? AND subject=?').get(sentFId, 'fp dedup').c;
      // 服务器副本：不同 Message-ID，时间 +4 秒、大小 850（差 50）→ 合并，不插新行。
      await engineOq._syncFolder(fpClient([11, 21, 31, 32], [fpMsg(32, '<fp-server@heavycrusher.com>', 850, fpBase.getTime() + 4000)]), oquAccId, folderRow(sentFId));
      check('audit12 H1: OquMail server copy (different Message-ID, same fingerprint) merges into the existing sent row',
        fpCount() === 1, `count=${fpCount()}`);
      // 对照组 1：时间差 60 秒 → 不合并，插新行。
      await engineOq._syncFolder(fpClient([11, 21, 31, 32, 33], [fpMsg(33, '<fp-other@x>', 900, fpBase.getTime() + 60000)]), oquAccId, folderRow(sentFId));
      check('audit12 H1: same subject/from but 60s apart does NOT merge (control)',
        fpCount() === 2, `count=${fpCount()}`);
      // 对照组 2：时间差 4 秒、大小差 5000 → 不合并，插新行。
      await engineOq._syncFolder(fpClient([11, 21, 31, 32, 33, 34], [fpMsg(34, '<fp-other2@x>', 5900, fpBase.getTime() + 4000)]), oquAccId, folderRow(sentFId));
      check('audit12 H1: same subject/from/date but size 5000 apart does NOT merge (control)',
        fpCount() === 3, `count=${fpCount()}`);
      // 合并后 surviving 的仍是种子行（luck-mail 自己 APPEND 的那份）。
      const survivor = vdb.prepare('SELECT id, message_id FROM messages WHERE folder_id=? AND subject=? ORDER BY id ASC LIMIT 1').get(sentFId, 'fp dedup');
      check('audit12 H1: fingerprint merge keeps the original (luck-mail) row as survivor',
        survivor.id === seedFpId && survivor.message_id === '<fp-own@luck-mail.local>', JSON.stringify(survivor));
    }
  }
  // (4) 存量回填：两个子进程共享一个临时 DATA_DIR——子进程 1 建库并预置
  // 未读 sent 行（对照组：未读 inbox 行）；子进程 2 全新 openDb（迁移
  // 跑一遍）后读回。迁移的 log() 会写 stdout，用 BACKFILL_RESULT: 行提取。
  {
    const backfillDir = fs.mkdtempSync(path.join(os.tmpdir(), 'luck-mail-backfill-'));
    const backfillData = path.join(backfillDir, 'data');
    const dbJs = JSON.stringify(path.join(BACKEND, 'dist/db.js'));
    const cfgJs = JSON.stringify(path.join(BACKEND, 'dist/config.js'));
    const seedScript = `
      const { initStorage } = await import(${cfgJs});
      initStorage();
      const { openDb, getDb, closeDb, refreshFolderCounts } = await import(${dbJs});
      openDb();
      const db = getDb();
      const acc = db.prepare("INSERT INTO accounts (email, display_name, password_enc, imap_host, imap_port, imap_secure, smtp_host, smtp_port, smtp_secure, enabled, status) VALUES ('bf@163.com','BF','x','imap.163.com',993,'SSL','smtp.163.com',465,'SSL',0,'offline')").run();
      const accId = Number(acc.lastInsertRowid);
      const sent = db.prepare("INSERT INTO folders (account_id, path, name, type) VALUES (?, 'Sent', '已发送', 'sent')").run(accId);
      const inbox = db.prepare("INSERT INTO folders (account_id, path, name, type) VALUES (?, 'INBOX', '收件箱', 'inbox')").run(accId);
      db.prepare("INSERT INTO messages (account_id, folder_id, uid, message_id, subject, from_addr, to_json, date, snippet, is_read, has_attachments, size, flags_json) VALUES (?,?,?,?,?,?,?,?,?,0,0,100,'[]')").run(accId, Number(sent.lastInsertRowid), 1, '<bf-sent@x>', 'sent unread', 'bf@163.com', '[]', new Date().toISOString(), 's');
      db.prepare("INSERT INTO messages (account_id, folder_id, uid, message_id, subject, from_addr, to_json, date, snippet, is_read, has_attachments, size, flags_json) VALUES (?,?,?,?,?,?,?,?,?,0,0,100,'[]')").run(accId, Number(inbox.lastInsertRowid), 2, '<bf-inbox@x>', 'inbox unread', 'bf@163.com', '[]', new Date().toISOString(), 's');
      // 种子先给 inbox 文件夹算一次计数（unread=1），sent 文件夹故意不算——
      // 迁移后 sent 的 total/unread 能证明迁移确实重算了它，inbox 的 1 能
      // 证明迁移没动它。
      refreshFolderCounts(Number(inbox.lastInsertRowid));
      closeDb();
    `;
    const checkScript = `
      const { initStorage } = await import(${cfgJs});
      initStorage();
      const { openDb, getDb, closeDb } = await import(${dbJs});
      openDb();
      const db = getDb();
      const sent = db.prepare("SELECT is_read FROM messages WHERE message_id='<bf-sent@x>'").get();
      const inbox = db.prepare("SELECT is_read FROM messages WHERE message_id='<bf-inbox@x>'").get();
      const sentFolder = db.prepare("SELECT unread_count, total_count FROM folders WHERE type='sent'").get();
      const inboxFolder = db.prepare("SELECT unread_count, total_count FROM folders WHERE type='inbox'").get();
      console.log('BACKFILL_RESULT:' + JSON.stringify({ sentRead: sent?.is_read, inboxRead: inbox?.is_read, sentUnread: sentFolder?.unread_count, sentTotal: sentFolder?.total_count, inboxUnread: inboxFolder?.unread_count }));
      closeDb();
    `;
    const childEnv = { ...process.env, DATA_DIR: backfillData };
    execFileSync(process.execPath, ['--input-type=module', '-e', seedScript], { env: childEnv, stdio: 'pipe' });
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', checkScript], { env: childEnv, encoding: 'utf8' });
    const line = out.split('\n').find((l) => l.startsWith('BACKFILL_RESULT:'));
    const bf = line ? JSON.parse(line.slice('BACKFILL_RESULT:'.length)) : null;
    check('oqumail backfill: pre-seeded unread sent row is read after a fresh openDb (inbox untouched, counts recomputed)',
      !!bf && bf.sentRead === 1 && bf.inboxRead === 0 && bf.sentUnread === 0 && bf.sentTotal === 1 && bf.inboxUnread === 1,
      JSON.stringify(bf));
    fs.rmSync(backfillDir, { recursive: true, force: true });
  }

  // ---------- 21. audit #13 fixes ----------
  console.log('== audit #13 fixes ==');
  // HIGH：崩溃窗口重认领加指纹分支——OquMail 服务器副本 Message-ID 被
  // 重写，Message-ID 两路查不到；指纹（主题/发件人/收件人/时间，日期
  // 锚点是旧占位行的首次认领时间）才能认出它。用本机假 SMTP（第 18 节
  // 同款最小实现）+ 本地已同步的服务器副本行模拟。
  let fakeSmtp21 = null;
  let fakePort21 = 0;
  let smtpDataCount21 = 0;
  let lastRaw21 = '';
  try {
    fakeSmtp21 = await new Promise((resolve, reject) => {
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
              if (line === '.') { dataMode = false; smtpDataCount21 += 1; socket.write('250 OK: queued\r\n'); }
              else lastRaw21 += line + '\r\n';
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
            else if (up === 'DATA') { dataMode = true; lastRaw21 = ''; socket.write('354 Go ahead\r\n'); }
            else if (up === 'RSET' || up === 'NOOP') socket.write('250 OK\r\n');
            else if (up === 'QUIT') { socket.write('221 Bye\r\n'); socket.end(); }
            else socket.write('250 OK\r\n');
          }
        });
      });
      srv.on('error', reject);
      srv.listen(0, '127.0.0.1', () => { srv._sockets = sockets; resolve(srv); });
    });
    fakePort21 = fakeSmtp21.address().port;
    const mkAcc21 = (email) => {
      const info = db.prepare(
        `INSERT INTO accounts (email, display_name, password_enc, imap_host, imap_port, imap_secure,
          smtp_host, smtp_port, smtp_secure, enabled, status) VALUES (?,?,?,?,?,?,?,?,?,?, 'offline')`,
      ).run(email, 'A13', encryptSecret('FAKEPASS', key),
        '127.0.0.1', 9999, 'SSL', '127.0.0.1', fakePort21, 'STARTTLS', 1);
      const accountId = Number(info.lastInsertRowid);
      const f = db.prepare("INSERT INTO folders (account_id, path, name, type) VALUES (?, '已发送', '已发送', 'sent')").run(accountId);
      return { accountId, sentId: Number(f.lastInsertRowid) };
    };
    // 场景 A：OquMail 服务器副本（Message-ID 不同、指纹相同）已同步到
    // 本地 → 同一幂等键重认领不再重发（DATA 次数不变、duplicate:true）。
    {
      const { accountId, sentId } = mkAcc21('a13a@163.com');
      const sendBody = { accountId, to: 'r@163.com', subject: 'audit13 reclaim', text: 'hello reclaim', idempotencyKey: 'a13-reclaim-a' };
      const before = smtpDataCount21;
      const r1 = await api('POST', '/api/messages/send', sendBody);
      check('audit13 HIGH: first send succeeds via fake SMTP (201)',
        r1.status === 201 && r1.json?.ok === true, `status=${r1.status} body=${JSON.stringify(r1.json)?.slice(0, 160)}`);
      check('audit13 HIGH: first send did one SMTP DATA', smtpDataCount21 === before + 1, `count=${smtpDataCount21}`);
      // 模拟崩溃：占位行 message_id 清空（SMTP 已接受、回填前崩溃）、
      // created_at 推到 11 分钟前（F6 过期 → 重认领路径）。
      db.prepare("UPDATE sent_idempotency SET message_id=NULL, created_at=datetime('now','-11 minutes') WHERE account_id=? AND idempotency_key=?").run(accountId, 'a13-reclaim-a');
      const createdAt = db.prepare('SELECT created_at FROM sent_idempotency WHERE account_id=? AND idempotency_key=?').get(accountId, 'a13-reclaim-a').created_at;
      const copyDateIso = String(createdAt).replace(' ', 'T') + 'Z';
      // 同步已把 OquMail 服务器副本取回本地：Message-ID 是重写后的，
      // 主题/发件人/收件人/时间与原发送一致。
      db.prepare(`INSERT INTO messages (account_id, folder_id, uid, message_id, subject, from_addr,
        from_name, to_json, date, snippet, is_read, has_attachments, size, flags_json)
        VALUES (?,?,?,?,?,?,?,?,?,'',1,0,?,'[]')`).run(
        accountId, sentId, 500, '<rewritten-a@oqumail.example>', 'audit13 reclaim', 'a13a@163.com',
        'A13', '["r@163.com"]', copyDateIso, lastRaw21.length);
      const r2 = await api('POST', '/api/messages/send', sendBody);
      check('audit13 HIGH: OquMail server copy (different Message-ID, same fingerprint) re-claim returns duplicate, no resend',
        r2.status === 200 && r2.json?.duplicate === true && smtpDataCount21 === before + 1,
        `status=${r2.status} body=${JSON.stringify(r2.json)?.slice(0, 160)} dataCount=${smtpDataCount21}`);
    }
    // 场景 B：对照——服务器副本收件人不同 → 指纹不命中，重发正常进行。
    {
      const { accountId, sentId } = mkAcc21('a13b@163.com');
      const sendBody = { accountId, to: 'r@163.com', subject: 'audit13 reclaim', text: 'hello reclaim b', idempotencyKey: 'a13-reclaim-b' };
      const before = smtpDataCount21;
      const r1 = await api('POST', '/api/messages/send', sendBody);
      check('audit13 HIGH control setup: first send succeeds (201)', r1.status === 201 && r1.json?.ok === true, `status=${r1.status}`);
      db.prepare("UPDATE sent_idempotency SET message_id=NULL, created_at=datetime('now','-11 minutes') WHERE account_id=? AND idempotency_key=?").run(accountId, 'a13-reclaim-b');
      const createdAt = db.prepare('SELECT created_at FROM sent_idempotency WHERE account_id=? AND idempotency_key=?').get(accountId, 'a13-reclaim-b').created_at;
      const copyDateIso = String(createdAt).replace(' ', 'T') + 'Z';
      db.prepare(`INSERT INTO messages (account_id, folder_id, uid, message_id, subject, from_addr,
        from_name, to_json, date, snippet, is_read, has_attachments, size, flags_json)
        VALUES (?,?,?,?,?,?,?,?,?,'',1,0,?,'[]')`).run(
        accountId, sentId, 501, '<rewritten-b@oqumail.example>', 'audit13 reclaim', 'a13b@163.com',
        'A13', '["other@163.com"]', copyDateIso, lastRaw21.length);
      const r2 = await api('POST', '/api/messages/send', sendBody);
      check('audit13 HIGH control: server copy with different recipient does NOT match fingerprint — re-claim resends',
        r2.status === 201 && r2.json?.duplicate !== true && smtpDataCount21 === before + 2,
        `status=${r2.status} body=${JSON.stringify(r2.json)?.slice(0, 160)} dataCount=${smtpDataCount21}`);
    }
  } finally {
    if (fakeSmtp21) { try { for (const s of fakeSmtp21._sockets || []) s.destroy(); fakeSmtp21.close(); } catch { /* ignore */ } }
  }

  // L2/L1/L3/L4 的引擎级断言（假 IMAP 客户端，不触网）。
  {
    const { SyncEngine, sentFingerprintMatches } = await import('../dist/engine.js');
    const { openDb } = await import('../dist/db.js');
    const vdb = openDb();
    const T13 = new Date('2026-11-19T10:00:00Z').getTime();
    const isoT13 = new Date(T13).toISOString();
    // L2：指纹加收件人——同主题/同发件人/5 秒内/大小相近、收件人不同
    // 的两封信不再合并；收件人相同（大小写/顺序不同）仍合并；任一边
    // 缺收件人信息时跳过该项（旧行 to_json 为空时不误判）。
    const fpBase = { subject: 'fp to', from: 'a@163.com', dateMs: T13, size: 1000, messageId: '<own@luck-mail.local>', to: ['r@163.com'] };
    check('audit13 L2: fingerprint matches same recipient (case/order-insensitive)',
      sentFingerprintMatches(fpBase, { ...fpBase, to: ['R@163.com'] }));
    check('audit13 L2: fingerprint rejects different recipient',
      !sentFingerprintMatches(fpBase, { ...fpBase, dateMs: T13 + 5000, to: ['other@163.com'] }));
    check('audit13 L2: fingerprint skips recipient check when one side has none',
      sentFingerprintMatches(fpBase, { ...fpBase, to: [] }));
    const mkSentAcc13 = (email) => {
      const a = vdb.prepare(
        `INSERT INTO accounts (email, display_name, password_enc, imap_host, imap_port, imap_secure,
          smtp_host, smtp_port, smtp_secure, enabled, status) VALUES (?,?,?,?,?,?,?,?,?,?, 'offline')`,
      ).run(email, 'A13', encryptSecret('FAKE', key),
        'imap.163.com', 993, 'SSL', 'smtp.163.com', 465, 'SSL', 0);
      const accountId = Number(a.lastInsertRowid);
      const f = vdb.prepare("INSERT INTO folders (account_id, path, name, type) VALUES (?, '已发送', '已发送', 'sent')").run(accountId);
      return { accountId, sentId: Number(f.lastInsertRowid) };
    };
    const { accountId: fpAcc, sentId: fpSent } = mkSentAcc13('fp-to@163.com');
    const fpSeed = vdb.prepare(`INSERT INTO messages (account_id, folder_id, uid, message_id, subject, from_addr,
      from_name, to_json, date, snippet, is_read, has_attachments, size, flags_json)
      VALUES (?,?,?,?,?,?,?,?,?,'',1,0,1000,'[]')`).run(
      fpAcc, fpSent, 31, '<fp-own@luck-mail.local>', 'fp to', 'a@163.com', 'A', '["r@163.com"]', isoT13);
    const fpSeedId = Number(fpSeed.lastInsertRowid);
    const engine13 = new SyncEngine(key);
    check('audit13 L2: findSentFingerprintDuplicate matches same recipient 5s apart',
      engine13.findSentFingerprintDuplicate(fpAcc, fpSent, { subject: 'fp to', from: 'a@163.com', to: ['r@163.com'], dateMs: T13 + 5000, size: 1000, messageId: '<other@x>' }) === fpSeedId);
    check('audit13 L2: findSentFingerprintDuplicate does NOT merge same subject/from 5s apart with different recipient',
      engine13.findSentFingerprintDuplicate(fpAcc, fpSent, { subject: 'fp to', from: 'a@163.com', to: ['other@163.com'], dateMs: T13 + 5000, size: 1000, messageId: '<other@x>' }) === null);
    // HIGH 服务器分支：findSentByFingerprint 在服务器已发送里按指纹
    // 找到 OquMail 副本；收件人不同时找不到。
    {
      const fakeClient = {
        usable: true,
        mailbox: { path: '已发送' },
        mailboxOpen: async (p) => { fakeClient.mailbox = { path: p }; return { uidValidity: undefined, uidNext: undefined, highestModseq: null, exists: 2 }; },
        search: async () => [100, 101],
        fetch: async function* () {
          yield { uid: 100, envelope: { messageId: '<fp-own@luck-mail.local>', subject: 'fp to', from: [{ address: 'a@163.com' }], to: [{ address: 'r@163.com' }], date: new Date(T13) }, size: 1000 };
          yield { uid: 101, envelope: { messageId: '<fp-srv@oqumail>', subject: 'fp to', from: [{ address: 'a@163.com' }], to: [{ address: 'r@163.com' }], date: new Date(T13 + 4000) }, size: 1000 };
        },
      };
      engine13.states.set(fpAcc, { client: fakeClient, queue: Promise.resolve(), opFailures: 0 });
      const hit = await engine13.findSentByFingerprint(fpAcc, { subject: 'fp to', from: 'a@163.com', to: ['r@163.com'], dateMs: T13, size: 1000, messageId: '<own@luck-mail.local>' });
      check('audit13 HIGH: findSentByFingerprint finds the OquMail server copy by fingerprint',
        hit?.uid === 101 && hit?.folderId === fpSent, JSON.stringify(hit));
      const miss = await engine13.findSentByFingerprint(fpAcc, { subject: 'fp to', from: 'a@163.com', to: ['nobody@163.com'], dateMs: T13, size: 1000, messageId: '<own@luck-mail.local>' });
      check('audit13 HIGH: findSentByFingerprint with different recipient finds nothing', miss === null, JSON.stringify(miss));
      engine13.states.delete(fpAcc);
    }
    // 按 range 回放信封的假 IMAP 客户端（供 L1/L3 清扫测试）：fetch 只
    // 回放落在请求 range 内的信封——窗口修没修、扫没扫到才测得出来。
    const mkRangeClient = (byPath) => {
      const c = {
        usable: true,
        mailbox: { path: '' },
        _moved: [], _deleted: [],
        mailboxOpen: async (p) => { c.mailbox = { path: p }; return { uidValidity: undefined, uidNext: undefined, highestModseq: null, exists: 1 }; },
        search: async () => [...(byPath[c.mailbox.path]?.uids || [])],
        fetch: async function* (range) {
          const spec = String(range);
          const envs = byPath[c.mailbox.path]?.envs || [];
          if (spec.includes(',')) {
            const want = new Set(spec.split(',').map(Number));
            for (const env of envs) if (want.has(env.uid)) yield env;
            return;
          }
          const m = spec.match(/^(\d+)(?::(\d+))?$/);
          const lo = Number(m[1]);
          const hi = m[2] ? Number(m[2]) : lo;
          for (const env of envs) if (env.uid >= lo && env.uid <= hi) yield env;
        },
        messageMove: async (uid, target) => { c._moved.push([String(uid), target]); return { uidMap: new Map([[Number(uid), 200]]) }; },
        messageFlagsAdd: async (uid) => { /* sweep 用 */ },
        messageDelete: async (uid) => { c._deleted.push(String(uid)); },
      };
      return c;
    };
    const mkTrashAcc13 = (email) => {
      const a = vdb.prepare(
        `INSERT INTO accounts (email, display_name, password_enc, imap_host, imap_port, imap_secure,
          smtp_host, smtp_port, smtp_secure, enabled, status) VALUES (?,?,?,?,?,?,?,?,?,?, 'offline')`,
      ).run(email, 'A13', encryptSecret('FAKE', key),
        'imap.163.com', 993, 'SSL', 'smtp.163.com', 465, 'SSL', 0);
      const accountId = Number(a.lastInsertRowid);
      const sentF = vdb.prepare("INSERT INTO folders (account_id, path, name, type) VALUES (?, '已发送', '已发送', 'sent')").run(accountId);
      const trashF = vdb.prepare("INSERT INTO folders (account_id, path, name, type) VALUES (?, '已删除', '已删除', 'trash')").run(accountId);
      return { accountId, sentId: Number(sentF.lastInsertRowid), trashId: Number(trashF.lastInsertRowid) };
    };
    // L1(a)+L3：彻底删除已删除文件夹里的信时，第二遍清扫（已发送）用
    // 全量窗口——双生副本 UID 5 落在最后 100 名之外（已发送共 150 封），
    // 旧版只取最后 100 个扫不到；清扫删掉的双生副本 Message-ID 写进墓碑。
    {
      const { accountId, sentId, trashId } = mkTrashAcc13('sweep-full@163.com');
      const msgInfo = vdb.prepare(`INSERT INTO messages (account_id, folder_id, uid, message_id, subject, from_addr,
        from_name, to_json, date, snippet, is_read, has_attachments, size, flags_json)
        VALUES (?,?,?,?,?,?,?,?,?,'',1,0,500,'[]')`).run(
        accountId, trashId, 900, '<old-own@luck-mail.local>', 'old twin', 'c@163.com', 'C', '[]', '2026-01-01T10:00:00Z');
      const msgId = Number(msgInfo.lastInsertRowid);
      const sentUids = Array.from({ length: 150 }, (_, i) => i + 1);
      const fakeClient = mkRangeClient({
        '已删除': {
          uids: [900, 901],
          envs: [
            { uid: 900, envelope: { messageId: '<old-own@luck-mail.local>', subject: 'old twin', from: [{ address: 'c@163.com' }], to: [], date: new Date('2026-01-01T10:00:00Z') }, size: 500 },
            { uid: 901, envelope: { messageId: '<other@x>', subject: 'unrelated', from: [{ address: 'd@163.com' }], to: [], date: new Date('2026-01-02T10:00:00Z') }, size: 700 },
          ],
        },
        '已发送': {
          uids: sentUids,
          envs: [
            { uid: 5, envelope: { messageId: '<old-srv@oqumail>', subject: 'old twin', from: [{ address: 'c@163.com' }], to: [], date: new Date('2026-01-01T10:00:00Z') }, size: 520 },
            { uid: 100, envelope: { messageId: '<sent-other@x>', subject: 'other sent', from: [{ address: 'e@163.com' }], to: [], date: new Date('2026-01-03T10:00:00Z') }, size: 800 },
          ],
        },
      });
      const engine = new SyncEngine(key);
      engine.states.set(accountId, { client: fakeClient, queue: Promise.resolve(), opFailures: 0 });
      const ok = await engine.deleteMessage(accountId, msgId);
      check('audit13 L1(a): permanent delete sweeps the old OquMail twin in Sent outside the last-100 window (uid 5 of 150)',
        ok === true && fakeClient._deleted.includes('900') && fakeClient._deleted.includes('5'),
        `deleted=${JSON.stringify(fakeClient._deleted)}`);
      const tombs = vdb.prepare('SELECT message_id FROM deleted_messages WHERE account_id=? ORDER BY message_id').all(accountId).map((r) => r.message_id);
      check('audit13 L3: tombstone records both the deleted message and its swept twin Message-ID',
        tombs.includes('<old-own@luck-mail.local>') && tombs.includes('<old-srv@oqumail>'),
        JSON.stringify(tombs));
      engine.states.delete(accountId);
    }
    // L1(b)：message_id 为 null 的信也走指纹清扫——从已发送删信（移入
    // 已删除）时，无 Message-ID 的双生副本同样被清掉。
    {
      const { accountId, sentId, trashId } = mkTrashAcc13('sweep-null@163.com');
      const msgInfo = vdb.prepare(`INSERT INTO messages (account_id, folder_id, uid, message_id, subject, from_addr,
        from_name, to_json, date, snippet, is_read, has_attachments, size, flags_json)
        VALUES (?,?,?,?,?,?,?,?,?,'',1,0,400,'[]')`).run(
        accountId, sentId, 100, null, 'null mid', 'n@163.com', 'N', '[]', '2026-11-19T10:00:00Z');
      const msgId = Number(msgInfo.lastInsertRowid);
      const fakeClient = mkRangeClient({
        '已发送': {
          uids: [77, 100],
          envs: [
            { uid: 77, envelope: { messageId: '<null-twin@x>', subject: 'null mid', from: [{ address: 'n@163.com' }], to: [], date: new Date('2026-11-19T10:00:00Z') }, size: 410 },
            { uid: 100, envelope: { messageId: null, subject: 'null mid', from: [{ address: 'n@163.com' }], to: [], date: new Date('2026-11-19T10:00:00Z') }, size: 400 },
          ],
        },
      });
      const engine = new SyncEngine(key);
      engine.states.set(accountId, { client: fakeClient, queue: Promise.resolve(), opFailures: 0 });
      const ok = await engine.deleteMessage(accountId, msgId);
      const rowAfter = vdb.prepare('SELECT folder_id, uid FROM messages WHERE id=?').get(msgId);
      check('audit13 L1(b): deleting a sent message with null Message-ID still sweeps its fingerprint twin (uid 77)',
        ok === true && fakeClient._moved.length === 1 && fakeClient._moved[0][0] === '100'
        && fakeClient._deleted.includes('77')
        && rowAfter.folder_id === trashId && rowAfter.uid === 200,
        `moved=${JSON.stringify(fakeClient._moved)} deleted=${JSON.stringify(fakeClient._deleted)} row=${JSON.stringify(rowAfter)}`);
      engine.states.delete(accountId);
    }
    // L4：同步建连前的解析校验（缓存版）——本测试进程未设
    // ALLOW_PRIVATE_MAIL_HOSTS，拒绝路径如实触发；公网地址放行。
    {
      const { assertHostsSafe } = await import('../dist/imapUtil.js');
      let threwLoopback = false;
      try { await assertHostsSafe(['ip6-localhost']); } catch { threwLoopback = true; }
      check('audit13 L4: assertHostsSafe rejects a hostname resolving to loopback', threwLoopback);
      let threwLiteral = false;
      try { await assertHostsSafe(['127.0.0.1']); } catch { threwLiteral = true; }
      check('audit13 L4: assertHostsSafe rejects a loopback literal without DNS', threwLiteral);
      let threwPublic = false;
      try { await assertHostsSafe(['8.8.8.8']); } catch { threwPublic = true; }
      check('audit13 L4: assertHostsSafe allows a public literal IP', !threwPublic);
    }
  }

  // ---------- 22. audit #14 fixes ----------
  console.log('== audit #14 fixes ==');
  {
    // Audit #14 LOW-1：发信幂等占位“无行认领”竞态——claimSendKey 在
    // INSERT 冲突后两次都读不到行时，旧版谎报 claimed（库里无占位行，
    // 本次发送失去幂等保护）；新版 fail closed 返回 in-progress（409）。
    // 该竞态是微秒级窗口：双 worker 线程模拟曾试过，但紧循环抢同一
    // WAL 写锁时单条语句的 busy 等待把测试拖到分钟级，已放弃；这里用
    // claimSendKey 的测试用注入参数（第 4 参，默认 findSendKey）确定
    // 性覆盖：先插一行让 INSERT 冲突，再让查找恒返回 undefined，模拟
    // “行在两次读之间被并发删除”。F6 重认领 catch 分支是同款一行修
    // 改（对称处理，未单独覆盖——要触发它还需 DELETE 与重插之间再有
    // 一次并发插入，同样测不到）。
    const { claimSendKey, findSendKey } = await import('../dist/idempotency.js');
    const { openDb } = await import('../dist/db.js');
    const vdb22 = openDb();
    const raceAccount = 424244;
    const raceKey = 'phantom-k-14';
    vdb22.prepare(
      `INSERT INTO sent_idempotency (account_id, idempotency_key, message_db_id, message_id, planned_message_id, created_at)
       VALUES (?, ?, NULL, NULL, '<phantom-planned@x>', datetime('now'))`,
    ).run(raceAccount, raceKey);
    const phantom = claimSendKey(raceAccount, raceKey, null, () => undefined);
    check('audit14 LOW-1: claim with row vanishing after UNIQUE conflict fails closed (in-progress, row null)',
      phantom.status === 'in-progress' && phantom.row === null,
      JSON.stringify(phantom));
    const stillThere = findSendKey(raceAccount, raceKey);
    check('audit14 LOW-1: phantom claim leaves the existing row untouched',
      !!stillThere && stillThere.planned_message_id === '<phantom-planned@x>',
      JSON.stringify(stillThere?.planned_message_id));
    // 对照组：真实查找下同一行应返回 in-progress 且带回该行（未过期、
    // message_id 为空 → 首发进行中），证明注入参数没改正常路径。
    const real = claimSendKey(raceAccount, raceKey);
    check('audit14 LOW-1 control: real lookup on the same row returns in-progress with the row',
      real.status === 'in-progress' && real.row?.planned_message_id === '<phantom-planned@x>',
      JSON.stringify(real.status));
    vdb22.prepare('DELETE FROM sent_idempotency WHERE account_id=? AND idempotency_key=?').run(raceAccount, raceKey);
    // Audit #15 L1：F6 重认领 catch 分支原来是裸 catch——重插失败不是
    // UNIQUE 冲突（例如 SQLITE_BUSY、磁盘满）时也被吞掉，调用方按重读
    // 结果返回 in-progress（409），真实错误无日志。新版与 :100-107
    // 的另一重试分支同款：非 UNIQUE 错误重新抛出。
    // 触发手段：先建一行过期占位（created_at 推到 11 分钟前），再在
    // 表上建一个只对本 key 生效的临时触发器，让重插以自定义错误失败
    // （不是 UNIQUE 冲突）；断言 claimSendKey 把该错误抛出来，而不是
    // 返回 in-progress。触发器用完即删，不影响后续测试。
    const f6Account = 424245;
    const f6Key = 'f6-boom-k-15';
    vdb22.prepare(
      `INSERT INTO sent_idempotency (account_id, idempotency_key, message_db_id, message_id, planned_message_id, created_at)
       VALUES (?, ?, NULL, NULL, '<f6-planned@x>', datetime('now','-11 minutes'))`,
    ).run(f6Account, f6Key);
    vdb22.prepare(
      `CREATE TRIGGER verify_f6_boom AFTER INSERT ON sent_idempotency
       WHEN NEW.idempotency_key='f6-boom-k-15'
       BEGIN SELECT RAISE(ABORT, 'simulated disk full'); END`,
    ).run();
    let boomErr = null;
    try {
      claimSendKey(f6Account, f6Key);
    } catch (e) {
      boomErr = e;
    }
    check('audit15 L1: non-UNIQUE error on F6 re-claim re-INSERT is rethrown, not swallowed into in-progress',
      boomErr != null && /simulated disk full/i.test(String(boomErr?.message || boomErr)),
      String(boomErr?.message || boomErr));
    vdb22.prepare('DROP TRIGGER IF EXISTS verify_f6_boom').run();
    vdb22.prepare('DELETE FROM sent_idempotency WHERE account_id=? AND idempotency_key=?').run(f6Account, f6Key);
  }

  // ---------- 23. audit #18 fixes ----------
  console.log('== audit #18 fixes ==');
  {
    // Audit #18 LOW-1：stopAccount 先摘掉 error 监听再异步登出——对方在
    // 登出握手完成前 RST 连接时，无监听的 'error' 事件直接打死进程
    // （verify-all import18b 节末 3 次运行崩 2 次即此路径）。确定性复现：
    // 假 IMAP 服务器收到 LOGOUT 故意不回（登出握手必然挂住），DELETE 账号
    // 后立即对服务端 socket 调 resetAndDestroy() 发 RST——logout 必定还
    // 在进行中，客户端 socket 收到 ECONNRESET；修好后保留的 error 监听
    // 接住并记日志，子进程存活。修之前跑这一节会直接 abort 整个 verify-all
    // （子进程死、health 不通）。
    // 注意：假 IMAP 必须走明文（imapSecure STARTTLS、CAPABILITY 不报
    // STARTTLS，imapflow 降级明文继续）——TLS socket 没有 resetAndDestroy
    //（调它抛 ERR_INVALID_HANDLE_TYPE），只有明文 TCP socket 才能确定
    // 发 RST；普通 destroy() 在无待发数据时只发 FIN、客户端只会干净
    // 'close'，复现不到 error 事件。
    {
      let fakeImap18 = null;
      let fakeSmtp18 = null;
      let logoutAccId = 0;
      let logoutHeld = false;
      try {
        fakeSmtp18 = await new Promise((resolve, reject) => {
          const sockets = new Set();
          const srv = net.createServer((socket) => {
            sockets.add(socket);
            socket.on('close', () => sockets.delete(socket));
            let buf = '';
            let authStep = 0;
            let dataMode = false;
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
        const fakeSmtpPort18 = fakeSmtp18.address().port;
        fakeImap18 = await new Promise((resolve, reject) => {
          const sockets = new Set();
          // 明文假 IMAP（见节首注释：只有明文 socket 才能 resetAndDestroy
          // 确定发 RST）。CAPABILITY 故意不报 STARTTLS，imapflow 明文继续。
          const srv = net.createServer((socket) => {
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
                  const pass = (parts[1] || '').replace(/^"|"$/g, '');
                  if (pass === 'GOODPASS') socket.write(`${tag} OK LOGIN completed\r\n`);
                  else socket.write(`${tag} NO [AUTHENTICATIONFAILED] Invalid credentials (Failure)\r\n`);
                } else if (cmd === 'LOGOUT') {
                  // 关键：故意不回 LOGOUT——登出握手挂住，DELETE 后立即毁
                  // socket 时 logout 必定还在进行中，复现才确定。
                  logoutHeld = true;
                } else if (cmd === 'LIST') socket.write(`* LIST (\\HasNoChildren) "/" INBOX\r\n${tag} OK LIST completed\r\n`);
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
        const fakeImapPort18 = fakeImap18.address().port;
        // 注意：不用 CSV 导入接口——它限流 5 次/分钟，前面小节已用完额度
        // （曾因此 429）；单个添加 POST /api/accounts 不限流，同样先测
        // 连通再入库、同样启动引擎。
        const addRes18 = await api('POST', '/api/accounts', {
          email: 'goodlogout@gmail.com',
          password: 'GOODPASS',
          imapHost: '127.0.0.1',
          imapPort: fakeImapPort18,
          imapSecure: 'STARTTLS',
          smtpHost: '127.0.0.1',
          smtpPort: fakeSmtpPort18,
          smtpSecure: 'STARTTLS',
        });
        const row18 = db.prepare('SELECT * FROM accounts WHERE email=?').get('goodlogout@gmail.com');
        logoutAccId = row18 ? Number(row18.id) : 0;
        check('audit18 LOW-1: good account imported for logout-race test', !!row18 && addRes18.status === 201,
          `status=${addRes18.status} error=${JSON.stringify(addRes18.json?.error)} row=${!!row18}`);
        let online18 = false;
        for (let i = 0; i < 20; i++) {
          const l = await api('GET', '/api/accounts');
          const g = (l.json?.accounts || []).find((a) => a.email === 'goodlogout@gmail.com');
          if (g?.status === 'online') { online18 = true; break; }
          await new Promise((r2) => setTimeout(r2, 500));
        }
        check('audit18 LOW-1: account online before DELETE (live IDLE connection exists)', online18);
        if (online18 && logoutAccId) {
          const logBefore18 = serverLog.length;
          await api('DELETE', `/api/accounts/${logoutAccId}`);
          // 假服务器根本没回 LOGOUT，登出握手此时必然还在进行中；立即毁
          // 掉全部服务端 socket，客户端 socket 收到 ECONNRESET。
          // 注意：必须用 resetAndDestroy() 发 RST——普通 destroy() 在无
          // 待发数据时只发 FIN，客户端只会看到干净 EOF（'close' 事件，
          // 不触发 'error'）；import18b 之所以 3 次崩 2 次，正是毁 socket
          // 时服务端刚写了 LOGOUT 回包、待发数据未 flush 干净才发了 RST。
          // resetAndDestroy 显式发 RST，复现才确定，与待发数据无关。
          check('audit18 LOW-1: fake server held LOGOUT (logout was in flight at DELETE)', logoutHeld);
          try { for (const s of fakeImap18._sockets || []) (typeof s.resetAndDestroy === 'function' ? s.resetAndDestroy() : s.destroy()); } catch { /* ignore */ }
          await new Promise((r2) => setTimeout(r2, 1500));
          let healthOk18 = false;
          try {
            const hr = await api('GET', '/api/health');
            healthOk18 = hr.status === 200 && hr.json?.ok === true;
          } catch { healthOk18 = false; }
          check('audit18 LOW-1: server survives socket error during logout (health 200, no abort)', healthOk18);
          let apiOk18 = false;
          try {
            const lr = await api('GET', '/api/accounts');
            apiOk18 = lr.status === 200 && Array.isArray(lr.json?.accounts);
          } catch { apiOk18 = false; }
          check('audit18 LOW-1: API still responsive after the race', apiOk18);
          const newLog18 = serverLog.slice(logBefore18);
          check('audit18 LOW-1: retained error listener logged the socket error (race actually exercised)',
            newLog18.includes(`imap account ${logoutAccId} error`),
            newLog18.slice(-300));
        }
      } finally {
        if (fakeImap18) {
          try { for (const s of fakeImap18._sockets || []) s.destroy(); } catch { /* ignore */ }
          await new Promise((resolve) => fakeImap18.close(resolve));
        }
        if (fakeSmtp18) {
          try { for (const s of fakeSmtp18._sockets || []) s.destroy(); } catch { /* ignore */ }
          await new Promise((resolve) => fakeSmtp18.close(resolve));
        }
      }
    }
  }

  // ---------- 24. audit #19 fixes ----------
  console.log('== audit #19 fixes ==');
  {
    // Audit #19 HIGH-1：自发邮件的收件箱副本与已发送副本共享同一
    // Message-ID，先后移入已删除时旧版在本地 UPDATE 上撞唯一索引
    // idx_messages_account_folder_mid（db.ts:429），服务器移动已不可逆、
    // 本地行永久 stale，重试仍报 UNIQUE。修法：_moveMessage 移动前预查
    // 目标文件夹同 Message-ID 行、有则合并（服务器端删源副本、本地删
    // 源行、目标里已有行作代表）；UPDATE 抛错时补偿（有代表行则删源行，
    // 否则移回服务器副本再抛原错）。以下用真实编译产物 + 模拟 IMAP
    // 客户端直测引擎（审计员 /tmp/audit19-repro.cjs 同款，UIDPLUS 与
    // 非 UIDPLUS 两个变体；enabled=0，活服务器的引擎不会碰这些假账号）。
    const { openDb } = await import('../dist/db.js');
    const { SyncEngine } = await import('../dist/engine.js');
    const vdb24 = openDb();
    const MID24 = '<self19@x>';
    const mkAcc24 = (email) => Number(vdb24.prepare(
      `INSERT INTO accounts (email, display_name, password_enc, imap_host, imap_port, imap_secure,
        smtp_host, smtp_port, smtp_secure, enabled, status) VALUES (?,?,?,?,?,?,?,?,?,?, 'offline')`,
    ).run(email, '', encryptSecret('FAKE', key), '127.0.0.1', 9999, 'SSL', '127.0.0.1', 9999, 'STARTTLS', 0).lastInsertRowid);
    const mkFolders24 = (accId) => {
      const mk = (p, name, type) => Number(vdb24.prepare(
        'INSERT INTO folders (account_id, path, name, type) VALUES (?,?,?,?)',
      ).run(accId, p, name, type).lastInsertRowid);
      return { inboxId: mk('INBOX', 'INBOX', 'inbox'), sentId: mk('Sent', 'Sent', 'sent'), trashId: mk('Trash', 'Trash', 'trash') };
    };
    const seedTwin24 = (accId, inboxId, sentId) => {
      const now = new Date().toISOString();
      const mk = (folderId, uid) => Number(vdb24.prepare(
        `INSERT INTO messages (account_id, folder_id, uid, message_id, subject, from_addr, to_json, date, size, is_read)
         VALUES (?,?,?,?,?,?,?,?,?,1)`,
      ).run(accId, folderId, uid, MID24, 'self mail', 'self@163.com', JSON.stringify(['self@163.com']), now, 100).lastInsertRowid);
      return { inboxRowId: mk(inboxId, 10), sentRowId: mk(sentId, 20) };
    };
    const countIn24 = (accId, folderId) => vdb24.prepare(
      'SELECT COUNT(*) c FROM messages WHERE account_id=? AND folder_id=?',
    ).get(accId, folderId).c;
    const makeServer24 = () => ({
      INBOX: new Map([[10, { messageId: MID24 }]]),
      Sent: new Map([[20, { messageId: MID24 }]]),
      Trash: new Map(),
      nextUid: { INBOX: 11, Sent: 21, Trash: 1 },
    });
    let server24 = makeServer24();
    let uidplus24 = true;
    let onMove24 = null; // 补偿分支测试用：在 messageMove 期间插双生行
    const makeClient24 = () => {
      let selected = null;
      const client = {
        mailbox: null,
        on() {}, removeAllListeners() {}, logout: async () => {},
        async mailboxOpen(p) {
          selected = p;
          client.mailbox = { path: p };
          const box = server24[p];
          return { exists: box ? box.size : 0, uidValidity: 1, uidNext: server24.nextUid[p] || 1 };
        },
        async messageMove(uidStr, target) {
          const uid = Number(uidStr);
          const src = server24[selected];
          if (onMove24) onMove24(selected, uid, target);
          if (!src || !src.has(uid)) return {};
          const msg = src.get(uid);
          src.delete(uid);
          const nu = server24.nextUid[target]++;
          server24[target].set(nu, msg);
          if (uidplus24) return { uidMap: new Map([[uid, nu]]) };
          return {};
        },
        async search() {
          const box = server24[selected];
          return box ? [...box.keys()] : [];
        },
        async *fetch(range) {
          const box = server24[selected];
          if (!box) return;
          const [a, b] = String(range).split(':').map(Number);
          const lo = Math.min(a, b), hi = Math.max(a, b);
          for (const [uid, m] of [...box.entries()].sort((x, y) => x[0] - y[0])) {
            if (uid >= lo && uid <= hi) {
              yield { uid, envelope: { messageId: m.messageId, subject: 'self mail', from: [{ address: 'self@163.com' }] }, size: 100 };
            }
          }
        },
        async messageFlagsAdd() {},
        async messageDelete(uidStr) {
          const box = server24[selected];
          if (box) box.delete(Number(uidStr));
        },
      };
      return client;
    };
    const engine24 = new SyncEngine(key);
    engine24.withClient = async (accountId, fn) => fn(makeClient24());

    // A. 主序列（UIDPLUS）：先删已发送副本、再删收件箱副本。
    server24 = makeServer24();
    uidplus24 = true;
    onMove24 = null;
    const accA = mkAcc24('self19a@163.com');
    const fA = mkFolders24(accA);
    const rowsA = seedTwin24(accA, fA.inboxId, fA.sentId);
    let errA1 = null; let errA2 = null;
    try { await engine24.deleteMessage(accA, rowsA.sentRowId); } catch (e) { errA1 = e; }
    try { await engine24.deleteMessage(accA, rowsA.inboxRowId); } catch (e) { errA2 = e; }
    check('audit19 HIGH-1: delete sent copy then inbox copy both succeed (no UNIQUE)',
      errA1 === null && errA2 === null, `err1=${errA1?.message} err2=${errA2?.message}`);
    check('audit19 HIGH-1: trash holds exactly one merged row, inbox/sent empty, no stale row',
      countIn24(accA, fA.trashId) === 1 && countIn24(accA, fA.inboxId) === 0 && countIn24(accA, fA.sentId) === 0,
      `trash=${countIn24(accA, fA.trashId)} inbox=${countIn24(accA, fA.inboxId)} sent=${countIn24(accA, fA.sentId)}`);
    check('audit19 HIGH-1: server INBOX/Sent empty, Trash has exactly one copy',
      server24.INBOX.size === 0 && server24.Sent.size === 0 && server24.Trash.size === 1,
      `INBOX=${[...server24.INBOX.keys()]} Sent=${[...server24.Sent.keys()]} Trash=${[...server24.Trash.keys()]}`);
    let errA3 = null;
    try { await engine24.deleteMessage(accA, rowsA.inboxRowId); } catch (e) { errA3 = e; }
    check('audit19 HIGH-1: retrying the merged-away inbox copy reports "邮件不存在", not UNIQUE',
      errA3 != null && /邮件不存在/.test(errA3.message) && !/UNIQUE/i.test(errA3.message),
      String(errA3?.message));

    // B. 反向顺序：先删收件箱副本、再删已发送副本。
    server24 = makeServer24();
    const accB = mkAcc24('self19b@163.com');
    const fB = mkFolders24(accB);
    const rowsB = seedTwin24(accB, fB.inboxId, fB.sentId);
    let errB = null;
    try {
      await engine24.deleteMessage(accB, rowsB.inboxRowId);
      await engine24.deleteMessage(accB, rowsB.sentRowId);
    } catch (e) { errB = e; }
    check('audit19 HIGH-1 reverse: delete inbox copy then sent copy both succeed',
      errB === null, String(errB?.message));
    check('audit19 HIGH-1 reverse: trash holds exactly one merged row',
      countIn24(accB, fB.trashId) === 1 && countIn24(accB, fB.inboxId) === 0 && countIn24(accB, fB.sentId) === 0,
      `trash=${countIn24(accB, fB.trashId)} inbox=${countIn24(accB, fB.inboxId)} sent=${countIn24(accB, fB.sentId)}`);

    // C. 非 UIDPLUS 变体：无 uidMap 时走 Message-ID 反查，合并仍生效。
    server24 = makeServer24();
    uidplus24 = false;
    const accC = mkAcc24('self19c@163.com');
    const fC = mkFolders24(accC);
    const rowsC = seedTwin24(accC, fC.inboxId, fC.sentId);
    let errC = null;
    try {
      await engine24.deleteMessage(accC, rowsC.sentRowId);
      await engine24.deleteMessage(accC, rowsC.inboxRowId);
    } catch (e) { errC = e; }
    check('audit19 HIGH-1 no-UIDPLUS: both deletes succeed, trash holds one merged row',
      errC === null && countIn24(accC, fC.trashId) === 1 && countIn24(accC, fC.inboxId) === 0,
      `err=${errC?.message} trash=${countIn24(accC, fC.trashId)} inbox=${countIn24(accC, fC.inboxId)}`);
    uidplus24 = true;

    // D. 补偿分支：移动期间目标文件夹出现同 Message-ID 行（模拟预查与
    // UPDATE 之间的并发插入），UPDATE 撞唯一索引时补偿生效——删掉本地
    // 源行、返回代表行，不留 stale 行。插进来的双生行 uid 是任意值
    // （只模拟并发插入），断言只看行数、不看 uid 是否与服务器一致。
    server24 = makeServer24();
    const accD = mkAcc24('self19d@163.com');
    const fD = mkFolders24(accD);
    const rowsD = seedTwin24(accD, fD.inboxId, fD.sentId);
    await engine24.deleteMessage(accD, rowsD.sentRowId); // 已发送副本先入已删除（代表行）
    vdb24.prepare('DELETE FROM messages WHERE account_id=? AND folder_id=?').run(accD, fD.trashId);
    onMove24 = () => {
      vdb24.prepare(
        `INSERT INTO messages (account_id, folder_id, uid, message_id, subject, from_addr, to_json, date, size, is_read)
         VALUES (?,?,?,?,?,?,?,?,?,1)`,
      ).run(accD, fD.trashId, 999, MID24, 'self mail', 'self@163.com', JSON.stringify(['self@163.com']), new Date().toISOString(), 100);
    };
    let errD = null;
    try { await engine24.deleteMessage(accD, rowsD.inboxRowId); } catch (e) { errD = e; }
    onMove24 = null;
    check('audit19 HIGH-1 compensation: twin inserted mid-move, delete still succeeds (UPDATE error compensated)',
      errD === null, String(errD?.message));
    check('audit19 HIGH-1 compensation: no stale inbox row, trash holds exactly the injected twin',
      countIn24(accD, fD.inboxId) === 0 && countIn24(accD, fD.trashId) === 1,
      `inbox=${countIn24(accD, fD.inboxId)} trash=${countIn24(accD, fD.trashId)}`);

    // E. Audit #19 LOW-1：反查助手 mailboxOpen 后核对实际选中的邮箱，
    // 错选时抛错、不再静默返回空；一致时正常返回。
    {
      const lyingClient = {
        mailbox: { path: 'INBOX' }, // mailboxOpen 不切换，仍停留 INBOX
        mailboxOpen: async () => ({ uidValidity: 1, uidNext: 1, highestModseq: null, exists: 1 }),
        search: async () => [10],
        fetch: async function* () {
          yield { uid: 10, envelope: { messageId: MID24, subject: 'self mail', from: [{ address: 'self@163.com' }] }, size: 100 };
        },
      };
      let errE = null;
      try { await engine24._findUidByMessageId(lyingClient, 'Trash', MID24); } catch (e) { errE = e; }
      check('audit19 LOW-1: Message-ID lookup throws on mailbox.path mismatch instead of silently returning empty',
        errE != null && /mailbox open mismatch/.test(errE.message), String(errE?.message));
      const honestClient = {
        mailbox: { path: 'Trash' },
        mailboxOpen: async function (p) { this.mailbox = { path: p }; return { uidValidity: 1, uidNext: 1, highestModseq: null, exists: 1 }; },
        search: async () => [1],
        fetch: async function* () {
          yield { uid: 1, envelope: { messageId: MID24, subject: 'self mail', from: [{ address: 'self@163.com' }] }, size: 100 };
        },
      };
      const uidE = await engine24._findUidByMessageId(honestClient, 'Trash', MID24);
      check('audit19 LOW-1 control: lookup with matching mailbox still returns the UID',
        uidE === 1, `uid=${uidE}`);
    }
  }

  // ---------- 25. audit #20 fixes ----------
  console.log('== audit #20 fixes ==');
  {
    // Audit #20 LOW-1：_findUidsByFingerprint 缺 F2 邮箱核对——指纹口径
    // 比 Message-ID 粗（主题/发件人/时间±10 秒/大小±1024 字节/收件人），
    // 若 mailboxOpen 静默停留在错误文件夹，清扫会读错文件夹的信封、命
    // 中双生副本的 UID，随后按该 UID 在目标文件夹里删信可能删掉完全不
    // 相干的另一封信。修法：助手内加同款 F2 核对（路径不符抛错）；
    // _deleteOtherCopiesInFolder 的 sweep 把指纹调用单独包 try/catch，
    // 抛错时只跳过指纹分支、Message-ID 分支已收集的目标照删。
    const MID25 = '<self20@x>';
    const now25 = new Date().toISOString();
    const fp25 = { subject: 'self mail', from: 'self@163.com', dateMs: Date.now(), size: 100, messageId: '<planned@luck-mail.local>', to: ['self@163.com'] };
    // engine24 是第 24 节块内的局部变量，这里自建实例（只调纯客户端
    // 助手与清扫，不建真实连接）。
    const { SyncEngine: SyncEngine25 } = await import('../dist/engine.js');
    const engine25 = new SyncEngine25(key);

    // A. 指纹反查：mailbox 错指时抛错、不再静默返回空。
    {
      const lyingClient = {
        mailbox: { path: 'INBOX' }, // mailboxOpen 不切换，仍停留 INBOX
        mailboxOpen: async () => ({ uidValidity: 1, uidNext: 1, highestModseq: null, exists: 1 }),
        search: async () => [10],
        fetch: async function* () {
          yield { uid: 10, envelope: { messageId: MID25, subject: 'self mail', from: [{ address: 'self@163.com' }], to: [{ address: 'self@163.com' }], date: new Date() }, size: 100 };
        },
      };
      let errA = null;
      try { await engine25._findUidsByFingerprint(lyingClient, 'Trash', fp25); } catch (e) { errA = e; }
      check('audit20 LOW-1: fingerprint lookup throws on mailbox.path mismatch instead of silently returning hits',
        errA != null && /mailbox open mismatch/.test(errA.message), String(errA?.message));
      const honestClient = {
        mailbox: { path: 'Trash' },
        mailboxOpen: async function (p) { this.mailbox = { path: p }; return { uidValidity: 1, uidNext: 1, highestModseq: null, exists: 1 }; },
        search: async () => [1],
        fetch: async function* () {
          yield { uid: 1, envelope: { messageId: MID25, subject: 'self mail', from: [{ address: 'self@163.com' }], to: [{ address: 'self@163.com' }], date: new Date() }, size: 100 };
        },
      };
      const hitsA = await engine25._findUidsByFingerprint(honestClient, 'Trash', fp25);
      check('audit20 LOW-1 control: fingerprint lookup with matching mailbox still returns the UID',
        Array.isArray(hitsA) && hitsA.length === 1 && hitsA[0] === 1, `hits=${JSON.stringify(hitsA)}`);
    }

    // B/C. 清扫 sweep：指纹分支抛错时跳过、Message-ID 双生照删；对照组
    // 指纹分支正常工作（messageId 为 null 时只靠指纹也能清掉双生）。
    const folder25 = { id: 1, account_id: 1, path: 'Trash', name: 'Trash', type: 'trash' };
    const makeServer25 = () => ({
      Trash: new Map([
        [5, { messageId: MID25, subject: 'self mail', from: 'self@163.com', date: now25, size: 100, to: ['self@163.com'] }],
        [9, { messageId: '<other@x>', subject: 'other mail', from: 'other@x', date: now25, size: 500, to: ['other@x'] }],
      ]),
      INBOX: new Map(),
    });
    let server25 = makeServer25();
    const makeSweepClient25 = (stuckOnSecond) => {
      let selected = null;
      let opens = 0;
      const client = {
        mailbox: null,
        async mailboxOpen(p) {
          opens++;
          selected = p;
          // 第二次打开（指纹反查那次）卡住不动，模拟 \Noselect 命名空间
          // 上 mailboxOpen 不报错、实际仍停留在上一个文件夹。
          if (stuckOnSecond && opens === 2) { client.mailbox = { path: 'INBOX' }; }
          else { client.mailbox = { path: p }; }
          return { exists: 1, uidValidity: 1, uidNext: 100 };
        },
        async search() { return [...(server25[selected]?.keys() || [])]; },
        async *fetch(range) {
          const box = server25[selected];
          if (!box) return;
          // 真实 imapflow 的 fetch 接受单个 UID（'5'）与区间（'5:9'）两种
          // 写法；单值时不要按区间解析，否则 NaN 会把全部候选滤掉。
          const parts = String(range).split(':').map(Number);
          const lo = parts.length === 1 ? parts[0] : Math.min(parts[0], parts[1]);
          const hi = parts.length === 1 ? parts[0] : Math.max(parts[0], parts[1]);
          for (const [uid, m] of [...box.entries()].sort((x, y) => x[0] - y[0])) {
            if (uid >= lo && uid <= hi) {
              yield { uid, envelope: { messageId: m.messageId, subject: m.subject, from: [{ address: m.from }], to: (m.to || []).map((x) => ({ address: x })), date: new Date(m.date) }, size: m.size };
            }
          }
        },
        async messageFlagsAdd() {},
        async messageDelete(uidStr) { const box = server25[selected]; if (box) box.delete(Number(uidStr)); },
      };
      return client;
    };
    // B. 指纹分支抛错：Message-ID 双生（uid 5）照删，无关信（uid 9）不动。
    server25 = makeServer25();
    const twinsB = await engine25._deleteOtherCopiesInFolder(1, folder25, MID25, null, undefined, makeSweepClient25(true), fp25);
    check('audit20 LOW-1: sweep with failing fingerprint branch still deletes the Message-ID twin',
      !server25.Trash.has(5) && server25.Trash.has(9) && twinsB.twinIds.includes(MID25),
      `Trash=${[...server25.Trash.keys()]} twins=${JSON.stringify(twinsB)}`);
    // C. 对照组：指纹分支正常，messageId 为 null 时只靠指纹清掉双生。
    server25 = makeServer25();
    const twinsC = await engine25._deleteOtherCopiesInFolder(1, folder25, null, null, undefined, makeSweepClient25(false), fp25);
    check('audit20 LOW-1 control: sweep with working fingerprint branch deletes the twin by fingerprint alone',
      !server25.Trash.has(5) && server25.Trash.has(9) && twinsC.twinIds.includes(MID25),
      `Trash=${[...server25.Trash.keys()]} twins=${JSON.stringify(twinsC)}`);
  }

  // ---------- 26. audit #21 fixes ----------
  console.log('== audit #21 fixes ==');
  {
    // Audit #21 LOW-1：清扫删掉服务器副本后，被清副本的本地行一直留
    // 到下一次同步对账才消失。修法：sweep 返回确认删掉的服务器 UID
    // （sweptUids），调用方（彻底删除分支的同文件夹/已发送清扫、从
    // 已发送移走时的同文件夹清扫）同步按 (folder_id, uid) 删本地行
    // （FTS + 正文文件同款清理），不等同步对账。直接测 _deleteMessage，
    // 不跑同步——断言行“立即”消失。
    const { openDb: openDb26 } = await import('../dist/db.js');
    const { SyncEngine: SyncEngine26 } = await import('../dist/engine.js');
    const vdb26 = openDb26();
    const MID26 = '<self21@x>';
    const mkAcc26 = (email) => Number(vdb26.prepare(
      `INSERT INTO accounts (email, display_name, password_enc, imap_host, imap_port, imap_secure,
        smtp_host, smtp_port, smtp_secure, enabled, status) VALUES (?,?,?,?,?,?,?,?,?,?, 'offline')`,
    ).run(email, '', encryptSecret('FAKE', key), '127.0.0.1', 9999, 'SSL', '127.0.0.1', 9999, 'STARTTLS', 0).lastInsertRowid);
    const mkFolders26 = (accId) => {
      const mk = (p, name, type) => Number(vdb26.prepare(
        'INSERT INTO folders (account_id, path, name, type) VALUES (?,?,?,?)',
      ).run(accId, p, name, type).lastInsertRowid);
      return { inboxId: mk('INBOX', 'INBOX', 'inbox'), sentId: mk('Sent', 'Sent', 'sent'), trashId: mk('Trash', 'Trash', 'trash') };
    };
    const seedRow26 = (accId, folderId, uid, mid = MID26) => Number(vdb26.prepare(
      `INSERT INTO messages (account_id, folder_id, uid, message_id, subject, from_addr, to_json, date, size, is_read)
       VALUES (?,?,?,?,?,?,?,?,?,1)`,
    ).run(accId, folderId, uid, mid, 'self mail', 'self@163.com', JSON.stringify(['self@163.com']), new Date().toISOString(), 100).lastInsertRowid);
    const countIn26 = (accId, folderId) => vdb26.prepare(
      'SELECT COUNT(*) c FROM messages WHERE account_id=? AND folder_id=?',
    ).get(accId, folderId).c;
    const makeServer26 = () => ({
      INBOX: new Map([[10, { messageId: MID26 }]]),
      Sent: new Map([[20, { messageId: MID26 }]]),
      Trash: new Map(),
      nextUid: { INBOX: 11, Sent: 21, Trash: 1 },
    });
    let server26 = makeServer26();
    const makeClient26 = () => {
      let selected = null;
      const client = {
        mailbox: null,
        on() {}, removeAllListeners() {}, logout: async () => {},
        async mailboxOpen(p) {
          selected = p;
          client.mailbox = { path: p };
          const box = server26[p];
          return { exists: box ? box.size : 0, uidValidity: 1, uidNext: server26.nextUid[p] || 1 };
        },
        async messageMove(uidStr, target) {
          const uid = Number(uidStr);
          const src = server26[selected];
          if (!src || !src.has(uid)) return {};
          const msg = src.get(uid);
          src.delete(uid);
          const nu = server26.nextUid[target]++;
          server26[target].set(nu, msg);
          return { uidMap: new Map([[uid, nu]]) };
        },
        async search() {
          const box = server26[selected];
          return box ? [...box.keys()] : [];
        },
        async *fetch(range) {
          const box = server26[selected];
          if (!box) return;
          const [a, b] = String(range).split(':').map(Number);
          const lo = Math.min(a, b), hi = Math.max(a, b);
          for (const [uid, m] of [...box.entries()].sort((x, y) => x[0] - y[0])) {
            if (uid >= lo && uid <= hi) {
              yield { uid, envelope: { messageId: m.messageId, subject: 'self mail', from: [{ address: 'self@163.com' }], date: new Date() }, size: 100 };
            }
          }
        },
        async messageFlagsAdd() {},
        async messageDelete(uidStr) {
          const box = server26[selected];
          if (box) box.delete(Number(uidStr));
        },
      };
      return client;
    };
    const engine26 = new SyncEngine26(key);
    engine26.withClient = async (accountId, fn) => fn(makeClient26());

    // A. 主序列：收件箱副本移入已删除、再彻底删除——不等同步，已发送
    // 本地行立即消失，服务器已发送文件夹也无该副本。
    server26 = makeServer26();
    const accA26 = mkAcc26('self21a@163.com');
    const fA26 = mkFolders26(accA26);
    const inboxRowA = seedRow26(accA26, fA26.inboxId, 10);
    seedRow26(accA26, fA26.sentId, 20);
    let errA26 = null;
    try {
      await engine26.deleteMessage(accA26, inboxRowA); // 移入已删除
      await engine26.deleteMessage(accA26, inboxRowA); // 彻底删除（同行已在已删除）
    } catch (e) { errA26 = e; }
    check('audit21 LOW-1: permanent delete of inbox copy removes the sent local row immediately (no sync)',
      errA26 === null && countIn26(accA26, fA26.sentId) === 0 && countIn26(accA26, fA26.trashId) === 0 && countIn26(accA26, fA26.inboxId) === 0,
      `err=${errA26?.message} sent=${countIn26(accA26, fA26.sentId)} trash=${countIn26(accA26, fA26.trashId)} inbox=${countIn26(accA26, fA26.inboxId)}`);
    check('audit21 LOW-1: server Sent folder has no copy left after permanent delete',
      server26.Sent.size === 0 && server26.INBOX.size === 0 && server26.Trash.size === 0,
      `INBOX=${[...server26.INBOX.keys()]} Sent=${[...server26.Sent.keys()]} Trash=${[...server26.Trash.keys()]}`);

    // B. 对照组：仅移入已删除、不彻底删除——已发送副本仍在（本地行
    // 与服务器副本都不动，清扫只发生在彻底删除时）。
    server26 = makeServer26();
    const accB26 = mkAcc26('self21b@163.com');
    const fB26 = mkFolders26(accB26);
    const inboxRowB = seedRow26(accB26, fB26.inboxId, 10);
    seedRow26(accB26, fB26.sentId, 20);
    let errB26 = null;
    try { await engine26.deleteMessage(accB26, inboxRowB); } catch (e) { errB26 = e; }
    check('audit21 LOW-1 control: move-to-trash only leaves the sent copy untouched',
      errB26 === null && countIn26(accB26, fB26.sentId) === 1 && countIn26(accB26, fB26.trashId) === 1 && server26.Sent.size === 1,
      `err=${errB26?.message} sent=${countIn26(accB26, fB26.sentId)} trash=${countIn26(accB26, fB26.trashId)} serverSent=${server26.Sent.size}`);

    // C. 从已发送删信（:1988 调用点）：已发送里有同一封信的两份副本——
    // luck-mail APPEND 的那份（planned Message-ID）与服务器自动保存
    // 的那份（Message-ID 被重写，指纹相同）。同文件夹同 Message-ID
    // 的两行在库里不可能存在（唯一索引），所以双生只能是指纹双生。
    // 删其中一份移走后，另一份的服务器副本被指纹清扫、本地行同步消失。
    server26 = makeServer26();
    server26.Sent.set(21, { messageId: '<server21@163.com>' });
    server26.nextUid.Sent = 22;
    const accC26 = mkAcc26('self21c@163.com');
    const fC26 = mkFolders26(accC26);
    seedRow26(accC26, fC26.inboxId, 10);
    const sentRowC1 = seedRow26(accC26, fC26.sentId, 20, '<planned21@luck-mail.local>');
    seedRow26(accC26, fC26.sentId, 21, '<server21@163.com>');
    let errC26 = null;
    try { await engine26.deleteMessage(accC26, sentRowC1); } catch (e) { errC26 = e; }
    check('audit21 LOW-1: deleting one sent copy sweeps the fingerprint twin locally too (no sync)',
      errC26 === null && countIn26(accC26, fC26.sentId) === 0 && countIn26(accC26, fC26.trashId) === 1,
      `err=${errC26?.message} sent=${countIn26(accC26, fC26.sentId)} trash=${countIn26(accC26, fC26.trashId)}`);
    check('audit21 LOW-1: server Sent folder empty after the sent-copy sweep',
      server26.Sent.size === 0,
      `Sent=${[...server26.Sent.keys()]}`);
  }

  // ---------- 27. audit #23 fixes ----------
  console.log('== audit #23: duplicate-add race ==');
  {
    // Audit #23 LOW-1：并发重复提交第二路撞 email 唯一约束时返回 409
    // 而不是 500；CSV 导入撞唯一约束时该行进 failed、批次继续。
    // 两路请求的前置查重都在连通测试（await）之前跑完——Node 同步段不
    // 可交错，所以两路一定都通过查重、第二路必走新加的 UNIQUE 兜底。
    // 假 IMAP/SMTP 与第 18 节同款（GOODPASS 才放行登录）。
    let fakeImap23 = null;
    let fakeSmtp23 = null;
    const raceIds = [];
    try {
      fakeSmtp23 = await new Promise((resolve, reject) => {
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
      const fakeSmtpPort23 = fakeSmtp23.address().port;
      fakeImap23 = await new Promise((resolve, reject) => {
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
                const pass = (parts[1] || '').replace(/^"|"$/g, '');
                if (pass === 'GOODPASS') socket.write(`${tag} OK LOGIN completed\r\n`);
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
      const fakeImapPort23 = fakeImap23.address().port;
      const raceBody = {
        email: 'race23@gmail.com', password: 'GOODPASS',
        imapHost: '127.0.0.1', imapPort: fakeImapPort23, imapSecure: 'SSL',
        smtpHost: '127.0.0.1', smtpPort: fakeSmtpPort23, smtpSecure: 'STARTTLS',
      };
      const [raceA, raceB] = await Promise.all([
        api('POST', '/api/accounts', raceBody),
        api('POST', '/api/accounts', raceBody),
      ]);
      const raceStatuses = [raceA.status, raceB.status].sort();
      check('audit23 LOW-1: concurrent duplicate adds -> one 201 + one 409, no 500',
        raceStatuses[0] === 201 && raceStatuses[1] === 409,
        `statuses=${raceA.status},${raceB.status} errA=${raceA.json?.error} errB=${raceB.json?.error}`);
      const loser = raceA.status === 409 ? raceA : raceB;
      check('audit23 LOW-1: losing request reports "该邮箱已添加过" (409, not a 500 stack)',
        /该邮箱已添加过/.test(loser.json?.error || '') && !loser.text.includes(' at '),
        `status=${loser.status} error=${loser.json?.error}`);
      const raceRows = db.prepare('SELECT id FROM accounts WHERE email=?').all('race23@gmail.com');
      check('audit23 LOW-1: exactly one race account in DB',
        raceRows.length === 1, `rows=${raceRows.length}`);
      if (raceRows.length === 1) raceIds.push(Number(raceRows[0].id));
      // 清理第一路的账号（停引擎），再测导入竞态。
      for (const id of raceIds.splice(0)) { try { await api('DELETE', `/api/accounts/${id}`); } catch { /* ignore */ } }

      // CSV 导入竞态：两份各一行的 CSV 同时导入同一邮箱——快照都在
      // INSERT 之前，两路都通过判重；一路 added=1，另一路该行进 failed
      // （原因“该邮箱已添加过”），批次继续、两个响应都是 200。
      const impCsv = '序号,邮箱名,授权码,接收服务器（IMAP）,IMAP端口,发送服务器（SMTP）,SMTP端口,备注\r\n'
        + `1,race23import@gmail.com,GOODPASS,127.0.0.1,${fakeImapPort23},127.0.0.1,${fakeSmtpPort23},race\r\n`;
      const importOne = () => {
        const form = new FormData();
        form.append('file', new Blob([impCsv], { type: 'text/csv' }), 'import.csv');
        return fetch(BASE + '/api/accounts/import', { method: 'POST', headers: { Cookie: cookie, Origin: BASE }, body: form })
          .then(async (res) => ({ status: res.status, json: await res.json().catch(() => null) }));
      };
      // 导入限流（60 秒窗口、每 IP 5 次）：前面章节的导入可能已占满桶，
      // 两路同发会 429；此时先清掉首轮可能已建的账号（否则重试时该邮箱
      // 会在快照里被判重跳过），等 65 秒窗口排空后重试一次。
      let impA, impB;
      for (let attempt = 0; attempt < 2; attempt++) {
        [impA, impB] = await Promise.all([importOne(), importOne()]);
        if (impA.status !== 429 && impB.status !== 429) break;
        const listR = await api('GET', '/api/accounts');
        const dup = (listR.json?.accounts || []).find((a) => a.email === 'race23import@gmail.com');
        if (dup) { try { await api('DELETE', `/api/accounts/${dup.id}`); } catch { /* ignore */ } }
        if (attempt === 0) await new Promise((r2) => setTimeout(r2, 65000));
      }
      const totalAdded = (impA.json?.added || 0) + (impB.json?.added || 0);
      const failedRows = [...(impA.json?.failed || []), ...(impB.json?.failed || [])];
      check('audit23 LOW-1: concurrent duplicate imports -> one added, other row failed, both 200',
        impA.status === 200 && impB.status === 200 && totalAdded === 1
        && failedRows.length === 1 && failedRows[0].email === 'race23import@gmail.com'
        && failedRows[0].reason === '该邮箱已添加过',
        `statuses=${impA.status},${impB.status} added=${impA.json?.added},${impB.json?.added} failed=${JSON.stringify(failedRows)}`);
      const impRows = db.prepare('SELECT id FROM accounts WHERE email=?').all('race23import@gmail.com');
      check('audit23 LOW-1: exactly one import account in DB',
        impRows.length === 1, `rows=${impRows.length}`);
      if (impRows.length === 1) raceIds.push(Number(impRows[0].id));
    } finally {
      for (const id of raceIds) { try { await api('DELETE', `/api/accounts/${id}`); } catch { /* ignore */ } }
      if (fakeImap23) {
        try { for (const s of fakeImap23._sockets || []) s.destroy(); } catch { /* ignore */ }
        await new Promise((resolve) => fakeImap23.close(resolve));
      }
      if (fakeSmtp23) {
        try { for (const s of fakeSmtp23._sockets || []) s.destroy(); } catch { /* ignore */ }
        await new Promise((resolve) => fakeSmtp23.close(resolve));
      }
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
