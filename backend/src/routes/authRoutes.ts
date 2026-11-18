import express from 'express';
import type { Request, Response } from 'express';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { getDb } from '../db.js';
import type { UserRow } from '../db.js';
import { hashPassword, verifyPassword, dummyPasswordCheck, sha256Hex } from '../cryptoUtil.js';
import {
  createSession, destroySession, setSessionCookie, clearSessionCookie,
  ipFail, ipReset, ipLockRemaining, userLocked, userFail, userReset, requireAuth,
  parseSqliteUtc, parseSqliteUtcMs,
  userIpLockRemaining, userGlobalLockRemaining, userIpFail, userGlobalFail,
  userIpReset, userGlobalReset,
} from '../auth.js';
import { log, SETUP_TOKEN_FILE, SESSION_COOKIE } from '../config.js';
import { disconnectUserSockets } from '../hub.js';
import type { AuthedRequest } from '../auth.js';

// Audit #9 L17：密码策略——长度 8–128 位（旧版只有“≥8 位”，无上限）；
// 用户名最多 64 位（旧版无上限）。强度只提示、不强制：单用户本机系统，
// 弱口令仍可建，提示经响应里的 passwordHint 字段给前端展示。
const MAX_PASSWORD_LEN = 128;
const MAX_USERNAME_LEN = 64;

function passwordLengthError(pw: unknown): string | null {
  if (typeof pw !== 'string' || pw.length < 8) return '密码至少 8 位';
  if (pw.length > MAX_PASSWORD_LEN) return '密码最多 128 位';
  return null;
}

function passwordStrengthHint(pw: string): string | null {
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((re) => re.test(pw)).length;
  if (classes < 2) return '建议密码包含字母、数字、符号中的至少两种，安全性更高';
  return null;
}

// Audit #9 L19e：hashPassword/verifyPassword 已改异步——下面三个
// 处理器均为 async，抛错时各自 try/catch 走统一 500 JSON（Express 4
// 不自动接 async 处理器的拒绝，见 accountRoutes 的 asyncHandler 同款）。
function authFail(res: Response, e: unknown, what: string): void {
  log(`${what} failed`, (e as Error)?.message || e);
  if (!res.headersSent) res.status(500).json({ ok: false, error: '服务器内部错误' });
}

export function authRoutes(): express.Router {
  const r = express.Router();

  r.get('/status', (req: Request, res: Response) => {
    const db = getDb();
    const userCount = (db.prepare('SELECT COUNT(*) c FROM users').get() as { c: number }).c;
    const cookies = (req as Request & { cookies?: Record<string, string> }).cookies;
    // 生产 COOKIE_SECURE=1 时会话 Cookie 名是 __Host-lm_session（见 config.ts），
    // 不能写死 lm_session——写死会导致线上每次刷新都判未登录、跳回登录页。
    const token = cookies?.[SESSION_COOKIE];
    const session = token
      ? db.prepare(
          `SELECT u.username FROM sessions s JOIN users u ON u.id=s.user_id
           WHERE s.token_hash=? AND datetime(s.expires_at) > datetime('now')`,
        ).get(sha256Hex(token)) as { username: string } | undefined
      : undefined;
    res.json({
      ok: true,
      setupRequired: userCount === 0,
      loggedIn: !!session,
      ...(session ? { username: session.username } : {}),
    });
  });

  r.post('/setup', async (req: Request, res: Response) => {
    try {
    const db = getDb();
    const count = (db.prepare('SELECT COUNT(*) c FROM users').get() as { c: number }).c;
    if (count > 0) return res.status(409).json({ ok: false, error: '已创建过账号' });
    // Audit #10 H-1：一次性引导 token——users 表为空时首次启动生成，
    // 写 DATA_DIR/.setup-token（0600）并打到启动日志；setup 必须带
    // setupToken 字段（与文件内容一致），否则 403。建成首个用户后
    // 删除 token 文件。取用方式见 backend/README.md“首次建账号”。
    // accounts 等表加 user_id 是远期项（多用户隔离），本次不做。
    const { username, password, confirm, setupToken } = (req.body || {}) as Record<string, unknown>;
    let expectedToken = '';
    try { expectedToken = fs.readFileSync(SETUP_TOKEN_FILE, 'utf8').trim(); } catch { /* missing */ }
    if (!expectedToken) {
      return res.status(403).json({ ok: false, error: '引导凭证缺失，请查看服务器启动日志或 DATA_DIR/.setup-token' });
    }
    const provided = typeof setupToken === 'string' ? setupToken.trim() : '';
    if (!provided || provided.length !== expectedToken.length
      || !crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expectedToken))) {
      ipFail(req, 'setup');
      return res.status(403).json({ ok: false, error: '引导凭证不正确' });
    }
    const remaining = ipLockRemaining(req, 'setup');
    if (remaining > 0) {
      return res.status(429).json({ ok: false, error: '账号已锁定，请稍后再试', retryAfter: remaining });
    }
    const fail = (msg: string, code = 400): Response => {
      ipFail(req, 'setup');
      return res.status(code).json({ ok: false, error: msg });
    };
    if (!username || typeof username !== 'string' || !username.trim()) return fail('用户名必填');
    if (username.includes('@')) return fail('用户名不要带邮箱后缀');
    if ((username as string).trim().length > MAX_USERNAME_LEN) return fail('用户名最多 64 位');
    const pwErr = passwordLengthError(password);
    if (pwErr) return fail(pwErr);
    if (password !== confirm) return fail('两次密码不一致');
    const { salt, hash } = await hashPassword(password as string);
    // Audit #10 H-1：count 检查与 INSERT 包进 BEGIN IMMEDIATE 事务并
    // 重查 count——旧版 SELECT 与 INSERT 之间隔着一次 await（scrypt），
    // 并发两请求可同时通过检查、双双入库，第二用户即完全接管。
    // better-sqlite3 的 db.transaction() 默认是 DEFERRED（写锁到第一次
    // 写时才拿），这里手动 BEGIN IMMEDIATE，检查与插入之间不留窗口。
    let info: { lastInsertRowid: number | bigint };
    db.exec('BEGIN IMMEDIATE');
    try {
      const recount = (db.prepare('SELECT COUNT(*) c FROM users').get() as { c: number }).c;
      if (recount > 0) {
        db.exec('ROLLBACK');
        return res.status(409).json({ ok: false, error: '已创建过账号' });
      }
      info = db.prepare('INSERT INTO users (username, password_hash, salt) VALUES (?,?,?)')
        .run((username as string).trim(), hash, salt);
      db.exec('COMMIT');
    } catch (e) {
      try { db.exec('ROLLBACK'); } catch { /* ignore */ }
      throw e;
    }
    ipReset(req, 'setup');
    // 首个用户建成：引导 token 即刻失效（删文件）。
    try { fs.rmSync(SETUP_TOKEN_FILE, { force: true }); } catch { /* ignore */ }
    // D6: 建账号后直接建会话——旧版只返回 201 不建会话，前端 setup()
    // 却置 loggedIn=true，随后 API 401 又跳回登录页。
    const userId = Number(info.lastInsertRowid);
    const { token, expiresAt } = createSession(userId, true);
    setSessionCookie(res, token, expiresAt);
    const hint = passwordStrengthHint(password as string);
    return res.status(201).json({ ok: true, username: (username as string).trim(), ...(hint ? { passwordHint: hint } : {}) });
    } catch (e) {
      authFail(res, e, 'setup');
      return;
    }
  });

  r.post('/login', async (req: Request, res: Response) => {
    try {
    const db = getDb();
    const { username, password, rememberMe } = (req.body || {}) as Record<string, unknown>;
    if (!username || !password) {
      // Audit #10 L-1：缺字段也先跑一次 dummy scrypt 再返回——旧版直接
      // 401，时序可区分“缺字段”与“正常校验”两条路径。
      await dummyPasswordCheck(String(password || 'x'));
      return res.status(401).json({ ok: false, error: '用户名或密码不正确' });
    }
    // 用户名不区分大小写：用户建账号用的是 zm235，保存的登录是 zm235，
    // SQLite 默认 = 是区分大小写的，查不到用户就直接报“用户名或密码不正确”。
    const user = db.prepare('SELECT * FROM users WHERE username=? COLLATE NOCASE').get(String(username).trim()) as UserRow | undefined;
    if (!user) {
      // Audit #9 L18：未知用户名也跑一次固定成本的 dummy scrypt 再返回——
      // 已知用户名走 verifyPassword（数十毫秒），未知用户名若直接 401，
      // 时序可区分用户名是否存在；中性文案已做，这里补时序。
      await dummyPasswordCheck(String(password));
      const rec = ipFail(req, 'login');
      if (rec.lockedUntil > Date.now()) {
        // Audit #6：锁定文案与已知用户完全一致（中性），不泄露用户名是否存在。
        return res.status(429).json({ ok: false, error: '账号已锁定，请稍后再试', retryAfter: Math.ceil((rec.lockedUntil - Date.now()) / 1000) });
      }
      return res.status(401).json({ ok: false, error: '用户名或密码不正确' });
    }
    // Audit #10 M-1：登录锁定双轨——(a) 按 (user, IP) 5 次锁该 IP 15 分钟；
    // (b) 跨 IP 累计 20 次锁该用户 15 分钟。单 IP 攻击者锁不死账号。
    // Audit #10 L-1：已锁定也先跑一次 dummy scrypt 再返回 429，
    // 不让“已锁定”与“正常校验”在时序上可区分。
    const ipLockedSec = userIpLockRemaining(user.id, req);
    const globalLockedSec = ipLockedSec > 0 ? 0 : userGlobalLockRemaining(user.id);
    if (ipLockedSec > 0 || globalLockedSec > 0) {
      await dummyPasswordCheck(String(password));
      return res.status(429).json({
        ok: false,
        error: '账号已锁定，请稍后再试',
        retryAfter: Math.max(ipLockedSec, globalLockedSec),
      });
    }
    if (!(await verifyPassword(String(password), user.salt, user.password_hash))) {
      const ipRec = userIpFail(user.id, req);
      const gRec = userGlobalFail(user.id);
      if (ipRec.lockedUntil > Date.now() || gRec.lockedUntil > Date.now()) {
        // Audit #6：锁定文案与未知用户完全一致（中性），不泄露用户名是否存在。
        return res.status(429).json({
          ok: false,
          error: '账号已锁定，请稍后再试',
          retryAfter: Math.ceil((Math.max(ipRec.lockedUntil, gRec.lockedUntil) - Date.now()) / 1000),
        });
      }
      return res.status(401).json({ ok: false, error: '用户名或密码不正确' });
    }
    userIpReset(user.id, req);
    userGlobalReset(user.id);
    ipReset(req, 'login');
    // Audit #10 M-1 连带：登录成功也清掉 users 行上的失败计数/锁定——
    // 行计数器现只归改密码用，但一次正确登录即证明持有人知道密码，
    // 残留的失败计数不应再锁改密码；同时保留 D7 契约（锁过期后一次
    // 正确登录即解锁并清零）。
    db.prepare('UPDATE users SET failed_attempts=0, locked_until=NULL WHERE id=?').run(user.id);
    // S3: rememberMe 缺省按 false（1 天会话）；只有明确传 true 才 30 天。
    // 旧版 `rememberMe !== false` 在前端不传该字段（undefined）时恒为真，
    // “30天内免登录”复选框成了摆设，每次登录都是 30 天。
    // 多点登录（用户 2026-11-19 决定）：登录不再吊销该用户其他会话——
    // 手机、平板、桌面可以同时在线。改密码仍轮换全部会话（见 change-password）。
    const { token, expiresAt } = createSession(user.id, rememberMe === true);
    setSessionCookie(res, token, expiresAt);
    return res.json({ ok: true, username: user.username });
    } catch (e) {
      authFail(res, e, 'login');
      return;
    }
  });

  r.post('/logout', requireAuth, (req: AuthedRequest, res: Response) => {
    destroySession(req.sessionToken);
    clearSessionCookie(res);
    return res.json({ ok: true });
  });

  r.post('/change-password', requireAuth, async (req: AuthedRequest, res: Response) => {
    try {
    const db = getDb();
    const { current, next } = (req.body || {}) as Record<string, unknown>;
    const pwErr = passwordLengthError(next);
    if (pwErr) {
      return res.status(400).json({ ok: false, error: pwErr });
    }
    const user = db.prepare('SELECT * FROM users WHERE id=?').get(req.user?.id) as UserRow | undefined;
    if (!user) return res.status(401).json({ ok: false, error: '当前密码不正确' });
    // Audit #9 L17：改密码失败也计数/锁定（5 次锁 15 分钟）。
    // Audit #10 M-1/L-8：users 行上的计数器自此只归改密码用——登录
    // 失败改走内存双轨（userIpFail / userGlobalFail），不再共用该行；
    // 锁期内即使当前密码输对也先 429，等锁过期或 D7 清零逻辑。
    const lockedSec = userLocked(user);
    if (lockedSec > 0) {
      return res.status(429).json({ ok: false, error: '账号已锁定，请稍后再试', retryAfter: lockedSec });
    }
    if (user.locked_until && parseSqliteUtc(user.locked_until) <= new Date()) {
      userReset(db, user.id);
      user.failed_attempts = 0;
      user.locked_until = null;
    }
    if (!(await verifyPassword(String(current || ''), user.salt, user.password_hash))) {
      const lockSec = userFail(db, user);
      if (lockSec > 0) {
        return res.status(429).json({ ok: false, error: '账号已锁定，请稍后再试', retryAfter: lockSec });
      }
      return res.status(401).json({ ok: false, error: '当前密码不正确' });
    }
    const { salt, hash } = await hashPassword(next as string);
    db.prepare('UPDATE users SET password_hash=?, salt=?, failed_attempts=0, locked_until=NULL WHERE id=?')
      .run(hash, salt, user.id);
    // Audit #9 L17：改密码后连当前会话也轮换一次——旧版只删其他会话，
    // 当前会话用的还是改密码前的 token。先读当前会话剩余有效期，
    // 删全部会话后建新会话并保留原过期时间（前端无感，不用重登）。
    let keepUntil: Date | undefined;
    const cur = db.prepare('SELECT expires_at FROM sessions WHERE token_hash=?')
      .get(sha256Hex(req.sessionToken || '')) as { expires_at: string } | undefined;
    if (cur) {
      const ms = parseSqliteUtcMs(cur.expires_at);
      if (ms && ms > Date.now()) keepUntil = new Date(ms);
    }
    db.prepare('DELETE FROM sessions WHERE user_id=?').run(user.id);
    // Audit #10 L-12：改密码轮换会话后一并断开该用户已建立的
    // Socket.io 连接（同登录吊销）。
    disconnectUserSockets(user.id);
    const { token, expiresAt } = createSession(user.id, false, keepUntil);
    setSessionCookie(res, token, expiresAt);
    const hint = passwordStrengthHint(next as string);
    return res.json({ ok: true, ...(hint ? { passwordHint: hint } : {}) });
    } catch (e) {
      authFail(res, e, 'change-password');
      return;
    }
  });

  // 改用户名：单用户系统，只改自己的；用户名不带邮箱后缀，不可与已有用户名重名（不区分大小写）。
  // Audit #10 L-8：改用户名须输入当前密码确认——旧版只验会话，拿到
  // 会话即可改名；与改密码同款确认口径。前端须随请求传 current 字段。
  r.post('/change-username', requireAuth, async (req: AuthedRequest, res: Response) => {
    try {
    const db = getDb();
    const { username, current } = (req.body || {}) as Record<string, unknown>;
    const name = typeof username === 'string' ? username.trim() : '';
    if (!name) return res.status(400).json({ ok: false, error: '用户名必填' });
    if (name.includes('@')) return res.status(400).json({ ok: false, error: '用户名不要带邮箱后缀' });
    if (name.length > MAX_USERNAME_LEN) return res.status(400).json({ ok: false, error: '用户名最多 64 位' });
    const user = db.prepare('SELECT * FROM users WHERE id=?').get(req.user?.id) as UserRow | undefined;
    if (!user) return res.status(401).json({ ok: false, error: '当前密码不正确' });
    if (typeof current !== 'string' || !(await verifyPassword(current, user.salt, user.password_hash))) {
      return res.status(401).json({ ok: false, error: '当前密码不正确' });
    }
    const taken = db.prepare('SELECT id FROM users WHERE username=? COLLATE NOCASE AND id != ?')
      .get(name, req.user?.id) as { id: number } | undefined;
    if (taken) return res.status(409).json({ ok: false, error: '该用户名已被使用' });
    db.prepare('UPDATE users SET username=? WHERE id=?').run(name, req.user?.id);
    return res.json({ ok: true, username: name });
    } catch (e) {
      authFail(res, e, 'change-username');
      return;
    }
  });

  return r;
}
