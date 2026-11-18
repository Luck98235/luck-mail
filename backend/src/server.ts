import express from 'express';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import cookieParser from 'cookie-parser';
import { Server as SocketIOServer } from 'socket.io';
import { fileURLToPath } from 'node:url';
import {
  PORT, DATA_DIR, PUBLIC_DIR, initStorage, log, SESSION_COOKIE, SETUP_TOKEN_FILE,
} from './config.js';
import { openDb, closeDb, pruneExpiredRows, getDb } from './db.js';
import { lookupSession, requireAuth } from './auth.js';
import { SyncEngine } from './engine.js';
import { attachIo, trackSocket } from './hub.js';
import { authRoutes } from './routes/authRoutes.js';
import { accountRoutes } from './routes/accountRoutes.js';
import type { Ctx } from './routes/accountRoutes.js';
import { messageRoutes } from './routes/messageRoutes.js';
import { miscRoutes } from './routes/miscRoutes.js';
import { draftRoutes } from './routes/draftRoutes.js';

const masterKey = initStorage();
openDb();
// 启动时一次性清理：已过期会话 + 180 天以上的删除墓碑（S2/D5/L6）。
pruneExpiredRows();
// Audit #10 H-1：首次启动引导 token——users 表为空时生成一次性 token，
// 写 DATA_DIR/.setup-token（0600）并打到日志；POST /api/auth/setup
// 必须带该 token；建成首个用户后删除文件。取用方式见 backend/README.md。
function ensureSetupToken(): void {
  const db = getDb();
  const count = (db.prepare('SELECT COUNT(*) c FROM users').get() as { c: number }).c;
  if (count > 0) {
    try { fs.rmSync(SETUP_TOKEN_FILE, { force: true }); } catch { /* ignore */ }
    return;
  }
  if (fs.existsSync(SETUP_TOKEN_FILE)) return; // 重启后 setup 前仍有效
  const token = crypto.randomBytes(24).toString('hex');
  fs.writeFileSync(SETUP_TOKEN_FILE, token + '\n', { mode: 0o600 });
  try { fs.chmodSync(SETUP_TOKEN_FILE, 0o600); } catch { /* ignore */ }
  log(`[setup] first-run bootstrap token: ${token} (also in DATA_DIR/.setup-token; deleted after the first user is created)`);
}
ensureSetupToken();
// Audit #8 LOW-5：清掉上次运行崩溃时残留的 multer 上传临时文件
// （luck-mail-upload-*，发信附件落盘在 os.tmpdir()）；正常发信的
// finally 里已删，这里只处理崩溃残留。busboy 流式计数（发信中途超
// 50MB 立即中断）不在本次范围。
// Audit #10 M-18：同时清备份打包（luck-mail-backup-*）与正文解析
// （luck-mail-parse-*.eml）的崩溃残留——旧版只清上传临时文件。
try {
  for (const f of fs.readdirSync(os.tmpdir())) {
    if (f.startsWith('luck-mail-upload-') || f.startsWith('luck-mail-backup-') || f.startsWith('luck-mail-parse-')) {
      try { fs.rmSync(path.join(os.tmpdir(), f), { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }
} catch { /* ignore */ }
const engine = new SyncEngine(masterKey);
const ctx: Ctx = { engine, masterKey };

const app = express();
// S4: 信任本机回环反代的 X-Forwarded-For——不设时 req.ip 恒为 127.0.0.1，
// IP 锁定变成全局锁定（任何人对不存在的用户名连错 5 次就锁全站登录）。
app.set('trust proxy', 'loopback');
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.disable('x-powered-by');
// Audit #5b：应用层安全响应头已删——OpenResty 是唯一一层（反代配了
// X-Content-Type-Options、X-Frame-Options、CSP frame-ancestors
// 'self'、Referrer-Policy、HSTS includeSubDomains）。之前两边叠加，
// 且 Referrer-Policy 冲突（应用层 same-origin、反代层 no-referrer）。
// /api 的 Content-Type + Cache-Control: no-store 保留（D1，防敏感
// JSON 被缓存落盘；反代层没设这一项，不冲突）。

// All API responses are JSON; never leak a stack trace to the client.
// D1: /api 一律 no-store——/api/accounts/:id/password 的明文密码 JSON
// 等敏感响应不能被浏览器启发式缓存落盘。
app.use('/api', (_req, res, next) => {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  next();
});

// 健康检查（部署轨第 8 项）：轻量状态，不需登录，供监控/探活。
// 注意它挂在 requireAuth 之前，否则探活请求会被 401 挡住。
// Audit #5b：只返回 {ok, db}——之前无会话可访问还返回在线邮箱数，
// 属于信息披露；与 README 的 {ok:true} 写法一致。
app.get('/api/health', (_req, res) => {
  try {
    const db = getDb();
    db.prepare('SELECT 1').get();
    res.json({ ok: true, db: 'ok' });
  } catch {
    res.status(500).json({ ok: false, db: 'error' });
  }
});

// Audit #9 L16 / #10 M-5：/api 写接口（POST/PUT/DELETE）同源 Origin/
// Referer 校验——CSRF 防御此前完全依赖 SameSite=Strict Cookie。
// 两层：(1) 本中间件对全部 /api 写请求校验 Origin/Referer 存在时的
// 情形（存在时必须与 Host 一致，只比 Host、不比协议：反代终结 TLS
// 后未必透传 X-Forwarded-Proto，按协议比会误拦正常同源请求；Host
// 由浏览器按 URL 生成，跨站伪造不了）；(2) 已认证写请求的缺失
// Origin/Referer 由 requireAuth 后的严格中间件拦下（见下）。
// Audit #10 M-5：expectedHosts 只用 Host，不再信任 X-Forwarded-Host
// ——XFH 是客户端可控的请求头，信任它等于信任攻击者自报的来源；
// 线上 OpenResty 配置已核查（2026-11-18）：两处 location 都有
// `proxy_set_header Host $host;`，Host 头可信。
// 被拦的记告警日志。GET 不校验（读接口无写副作用；GET /messages/:id
// 的读副作用由另一路在路由层去掉）。
app.use('/api', (req, res, next) => {
  if (req.method !== 'POST' && req.method !== 'PUT' && req.method !== 'DELETE') return next();
  const src = req.headers.origin || req.headers.referer || '';
  if (!src) return next();
  let srcHost = '';
  try {
    srcHost = new URL(src).host;
  } catch {
    log('[warn] CSRF check: malformed Origin/Referer rejected', req.method, req.path, src);
    res.status(403).json({ ok: false, error: '跨站请求被拒绝' });
    return;
  }
  // 只认 Host 头（见上：XFH 不再信任）。
  const expectedHost = req.get('host') || '';
  if (srcHost !== expectedHost) {
    log('[warn] CSRF check: cross-origin write rejected', req.method, req.path, `origin-host=${srcHost} host=${req.get('host')}`);
    res.status(403).json({ ok: false, error: '跨站请求被拒绝' });
    return;
  }
  next();
});

// Auth: only /api/auth/status, /api/auth/setup, /api/auth/login are public;
// everything else under /api/* requires a valid lm_session cookie.
app.use('/api/auth', authRoutes());
app.use('/api', requireAuth);
// Audit #10 M-5（第二层）：已认证写请求缺失 Origin/Referer 时默认拒绝
// ——旧版缺失即放行，curl/脚本可绕过第一层校验直接带 Cookie 写接口。
// 浏览器 fetch/XHR 的 POST/PUT/DELETE 一律带 Origin，不误拦正常前端；
// 登录/setup 走 /api/auth，不受本层约束（首次建账号可能用 curl）。
app.use('/api', (req, res, next) => {
  if (req.method !== 'POST' && req.method !== 'PUT' && req.method !== 'DELETE') return next();
  const src = req.headers.origin || req.headers.referer || '';
  if (!src) {
    log('[warn] CSRF check: authenticated write without Origin/Referer rejected', req.method, req.path);
    res.status(403).json({ ok: false, error: '缺少来源校验，请求被拒绝' });
    return;
  }
  next();
});
app.use('/api', accountRoutes(ctx));
app.use('/api', messageRoutes(ctx));
app.use('/api', miscRoutes());
app.use('/api', draftRoutes());

// ---- Static frontend (Vite dist in PUBLIC_DIR; placeholder if absent) ----
const indexHtml = path.join(PUBLIC_DIR, 'index.html');
if (fs.existsSync(indexHtml)) {
  app.use(express.static(PUBLIC_DIR));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api') || req.path.startsWith('/socket.io')) return next();
    res.sendFile(indexHtml);
  });
} else {
  // Audit #10 L-30：占位页不再泄漏服务器绝对路径（旧版把 PUBLIC_DIR
  // 的绝对路径直接写进 HTML）。
  app.get('/', (_req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>luck-mail</title>
<style>body{font-family:system-ui,sans-serif;max-width:640px;margin:10vh auto;padding:0 20px;color:#1e293b}h1{color:#2563eb}.ok{color:#16a34a}</style></head>
<body><h1>luck-mail 后端已启动</h1><p class="ok">● API 与 Socket.io 正常运行</p>
<p>前端（Vite dist）尚未部署，放进去后这里会自动改为前端页面。</p>
<p>接口：<code>GET /api/auth/status</code> · Socket.io <code>/socket.io/</code></p></body></html>`);
  });
}

// 404 for unknown API paths.
app.use('/api', (_req, res) => res.status(404).json({ ok: false, error: '接口不存在' }));

// Error handler: JSON, no stack leak.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err: Error, req: express.Request, res: express.Response, _next: express.NextFunction) => {
  log('[error]', req.method, req.path, err?.message || err);
  if (res.headersSent) return;
  // Audit #10 L-21：express.json 1MB 超限走 413 而非通用 500——旧版
  // entity.too.large 掉进通用 500，客户端分不清是“请求体过大”还是
  // “服务器内部错误”。
  if ((err as { type?: string }).type === 'entity.too.large') {
    res.status(413).json({ ok: false, error: '请求体过大（上限 1MB）' });
    return;
  }
  // MulterError（附件上传超限）：返回 413 + 明确文案，不要笼统 500。
  if ((err as { name?: string }).name === 'MulterError') {
    const code = (err as { code?: string }).code;
    if (code === 'LIMIT_FILE_SIZE') {
      res.status(413).json({ ok: false, error: '单个附件超过 25MB 上限' });
      return;
    }
    if (code === 'LIMIT_FILE_COUNT') {
      res.status(413).json({ ok: false, error: '附件数量超过 10 个上限' });
      return;
    }
    res.status(413).json({ ok: false, error: '附件上传失败' });
    return;
  }
  res.status(500).json({ ok: false, error: '服务器内部错误' });
});

async function main(): Promise<void> {
  const server = http.createServer(app);

  // Audit #10 L-28：Socket.io 握手限流计数（每 IP 每分钟 30 次，见 io.use）。
  const socketHandshakeAttempts = new Map<string, number[]>();

  // ---- Socket.io (contract: /socket.io/, handshake checks lm_session) ----
  const io = new SocketIOServer(server, {
    path: '/socket.io/',
    cors: { origin: false }, // same-origin only
  });
  io.use((socket, next) => {
    try {
      // Audit #10 L-2：Socket.io 握手显式校验 Origin——旧版只验 Cookie，
      // 跨站页面拿到 Cookie 就能建连接收事件（SameSite=Strict 挡顶层
      // 导航，但 WebSocket 握手不走顶层导航）。Origin 存在时其 host
      // 必须等于 Host 头；缺失时放行（非浏览器客户端不带 Origin）。
      const origin = socket.handshake.headers.origin;
      if (origin) {
        let originHost = '';
        try { originHost = new URL(origin).host; } catch { return next(new Error('unauthorized')); }
        if (originHost !== (socket.handshake.headers.host || '')) return next(new Error('unauthorized'));
      }
      // Audit #10 L-28：握手限流——每 IP 每分钟最多 30 次握手，防
      // 被盗会话/爆破反复握手耗尽连接。计数在内存，重启清零。
      const ip = socket.handshake.address || 'unknown';
      const nowMs = Date.now();
      const attempts = (socketHandshakeAttempts.get(ip) || []).filter((t) => nowMs - t < 60_000);
      if (attempts.length >= 30) return next(new Error('unauthorized'));
      attempts.push(nowMs);
      socketHandshakeAttempts.set(ip, attempts);
      const cookieHeader = socket.handshake.headers.cookie || '';
      const match = cookieHeader.match(new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([^;]+)`));
      const token = match ? decodeURIComponent(match[1]) : null;
      const session = lookupSession(token);
      if (!session) return next(new Error('unauthorized'));
      socket.data.user = { id: session.user_id, username: session.username };
      next();
    } catch {
      next(new Error('unauthorized'));
    }
  });
  io.on('connection', (socket) => {
    log(`socket.io connected: ${socket.id} user=${(socket.data.user as { username?: string } | undefined)?.username}`);
    // Audit #10 L-12：按用户跟踪 socket——登录吊销旧会话 / 改密码轮换后
    // 一并断开该用户已建立的连接（见 hub.ts disconnectUserSockets）。
    trackSocket(socket);
    socket.on('ping', () => socket.emit('pong'));
    socket.on('disconnect', (reason) => log(`socket.io disconnected: ${socket.id} (${reason})`));
  });
  attachIo(io);

  // Start the sync engine (enabled accounts connect + IDLE).
  engine.startAll();

  // Audit #10 L-30：过期会话每小时清理一次——旧版只在启动时清理，
  // 长期运行的进程里过期会话行一直留着。unref，不挡进程退出。
  const sessionPruneTimer = setInterval(() => {
    try { pruneExpiredRows(); } catch { /* ignore */ }
  }, 60 * 60 * 1000);
  sessionPruneTimer.unref();

  // D3: 只监听回环——OpenResty 在本机反代，8080 不需要对外暴露。
  // （之前 server.listen(PORT) 绑 0.0.0.0，靠云防火墙挡着才没暴露。）
  server.listen(PORT, '127.0.0.1', () => {
    log(`luck-mail backend listening on 127.0.0.1:${PORT} (DATA_DIR=${DATA_DIR})`);
  });

  const shutdown = (): void => {
    log('shutting down…');
    // Audit #6 查因：旧进程 16:32:10 停服、16:32:40 才退出（正好 30 秒），
    // systemd 记 status=1/FAILURE。根因是 server.close() 要等全部连接
    // 结束才回调，而 io.close() 原来在回调里——Socket.io 的 websocket
    // 一直占着，回调永远等不到，30 秒兜底触发 process.exit(1)。
    // 修法：先断所有 Socket.io 连接，再关 HTTP 服务；兜底也退出 0
    // （主动停服本身不是失败）。Node 默认 keepAliveTimeout 5 秒，
    // 闲置的浏览器连接会自己断，回调一般几秒内就到。
    try { io.close(); } catch { /* ignore */ }
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      try { engine.stopAll(); } catch { /* ignore */ }
      try { closeDb(); } catch { /* ignore */ }
      process.exit(0);
    };
    try {
      server.close(() => finish());
    } catch {
      finish();
    }
    // Audit #10 L-29：关机宽限 85 秒——旧版 30 秒兜底可截断进行中的
    // 大附件下载；systemd TimeoutStopSec 默认 90 秒，85 秒留 5 秒余量。
    setTimeout(() => finish(), 85000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  // Audit #9 M3：unhandledRejection 兜底——记告警级别日志，不让进程
  // 直接崩溃；不静默吞掉：日志含原因，便于排查。注意这只是最后一道
  // 防线：各 async 路由须各自 try/catch 走统一 500 JSON（见
  // accountRoutes/messageRoutes 的 asyncHandler），全局错误中间件
  // 仍处理同步抛错。uncaughtException 不兜底（崩溃才是正确行为）。
  process.on('unhandledRejection', (reason: unknown) => {
    log('[warn] unhandledRejection:', (reason as Error)?.message || reason);
  });
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

export { app, engine };
