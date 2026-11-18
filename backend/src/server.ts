import express from 'express';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import cookieParser from 'cookie-parser';
import { Server as SocketIOServer } from 'socket.io';
import { fileURLToPath } from 'node:url';
import {
  PORT, DATA_DIR, PUBLIC_DIR, initStorage, log, SESSION_COOKIE,
} from './config.js';
import { openDb, closeDb } from './db.js';
import { lookupSession, requireAuth } from './auth.js';
import { SyncEngine } from './engine.js';
import { attachIo } from './hub.js';
import { authRoutes } from './routes/authRoutes.js';
import { accountRoutes } from './routes/accountRoutes.js';
import type { Ctx } from './routes/accountRoutes.js';
import { messageRoutes } from './routes/messageRoutes.js';
import { miscRoutes } from './routes/miscRoutes.js';

const masterKey = initStorage();
openDb();
const engine = new SyncEngine(masterKey);
const ctx: Ctx = { engine, masterKey };

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.disable('x-powered-by');

// All API responses are JSON; never leak a stack trace to the client.
app.use('/api', (_req, res, next) => {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  next();
});

// Auth: only /api/auth/status, /api/auth/setup, /api/auth/login are public;
// everything else under /api/* requires a valid lm_session cookie.
app.use('/api/auth', authRoutes());
app.use('/api', requireAuth);
app.use('/api', accountRoutes(ctx));
app.use('/api', messageRoutes(ctx));
app.use('/api', miscRoutes());

// ---- Static frontend (Vite dist in PUBLIC_DIR; placeholder if absent) ----
const indexHtml = path.join(PUBLIC_DIR, 'index.html');
if (fs.existsSync(indexHtml)) {
  app.use(express.static(PUBLIC_DIR));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api') || req.path.startsWith('/socket.io')) return next();
    res.sendFile(indexHtml);
  });
} else {
  app.get('/', (_req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>luck-mail</title>
<style>body{font-family:system-ui,sans-serif;max-width:640px;margin:10vh auto;padding:0 20px;color:#1e293b}h1{color:#2563eb}.ok{color:#16a34a}</style></head>
<body><h1>luck-mail 后端已启动</h1><p class="ok">● API 与 Socket.io 正常运行</p>
<p>前端（Vite dist）尚未放入 <code>${PUBLIC_DIR}</code>，放进去后这里会自动改为前端页面。</p>
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

  // ---- Socket.io (contract: /socket.io/, handshake checks lm_session) ----
  const io = new SocketIOServer(server, {
    path: '/socket.io/',
    cors: { origin: false }, // same-origin only
  });
  io.use((socket, next) => {
    try {
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
    socket.on('ping', () => socket.emit('pong'));
    socket.on('disconnect', (reason) => log(`socket.io disconnected: ${socket.id} (${reason})`));
  });
  attachIo(io);

  // Start the sync engine (enabled accounts connect + IDLE).
  engine.startAll();

  server.listen(PORT, () => {
    log(`luck-mail backend listening on :${PORT} (DATA_DIR=${DATA_DIR})`);
  });

  const shutdown = (): void => {
    log('shutting down…');
    server.close(() => {
      try { engine.stopAll(); } catch { /* ignore */ }
      try { io.close(); } catch { /* ignore */ }
      closeDb();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 5000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

export { app, engine };
