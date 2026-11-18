import type { Request, Response, NextFunction } from 'express';
import { getDb } from './db.js';
import type { UserRow } from './db.js';
import { sha256Hex, randomToken } from './cryptoUtil.js';
import { SESSION_COOKIE, MAX_FAILED_ATTEMPTS, LOCKOUT_MS, COOKIE_SECURE } from './config.js';

const DAY_MS = 24 * 60 * 60 * 1000;

export interface AuthedRequest extends Request {
  user?: { id: number; username: string };
  sessionToken?: string;
}

// In-memory lockout for login attempts against unknown usernames and for
// setup (no user row exists yet to carry the counters).
// Audit #9 L18：记录带 updatedAt；锁过期时清零计数（见 ipLocked/ipFail），
// 另有定时清理扫掉过期/陈旧记录——旧版 Map 常驻内存、无 TTL，
// 未知用户名锁定计数永不衰减。
const ipAttempts = new Map<string, { count: number; lockedUntil: number; updatedAt: number }>();
const IP_ATTEMPT_TTL_MS = 24 * 60 * 60 * 1000;

function ipKey(req: Request, scope: string): string {
  return `${scope}:${req.ip || req.socket?.remoteAddress || 'unknown'}`;
}

// 锁过期即清零计数并删记录：下一次失败从 count=1 重新计，不再
// “锁过期后一次输错立即再锁 15 分钟”（已知用户侧 D7 同款语义）。
function ipLocked(req: Request, scope: string): number {
  const rec = ipAttempts.get(ipKey(req, scope));
  if (!rec) return 0;
  if (rec.lockedUntil > Date.now()) return rec.lockedUntil;
  if (rec.lockedUntil) ipAttempts.delete(ipKey(req, scope));
  return 0;
}

// Audit #10 M-1：登录锁定改为双轨计数——旧版失败计数在 users 行上、
// 与 IP 无关：攻击者对已知用户名连错 5 次即锁 15 分钟，锁过期后 5 次
// 又锁，可无限期锁死唯一账号（锁定 DoS），锁期内站长连改密码也被挡。
// 现在登录失败分两轨记（都在内存，与 ipAttempts 同款 TTL 清理）：
//   (a) 按 (user_id, IP)：同一 IP 对同一用户连错 5 次 → 该 IP 对该用户锁 15 分钟；
//   (b) 按 user_id 全局：跨 IP 累计连错 20 次 → 该用户锁 15 分钟（防多 IP 分布式爆破）。
// 单 IP 攻击者最多锁住自己那条 IP，站长换个 IP 仍能登录；全局轨阈值
// 20 次，正常用户误输够不着。成功登录清零两轨。
// users 行上的 failed_attempts/locked_until 自此只归改密码用（认证后
// 操作，攻击者须先拿到会话），登录不再读写它。
const userIpAttempts = new Map<string, { count: number; lockedUntil: number; updatedAt: number }>();
const userGlobalAttempts = new Map<number, { count: number; lockedUntil: number; updatedAt: number }>();
export const LOGIN_IP_MAX_ATTEMPTS = 5;
export const LOGIN_GLOBAL_MAX_ATTEMPTS = 20;

function userIpKey(userId: number, req: Request): string {
  return `${userId}:${req.ip || req.socket?.remoteAddress || 'unknown'}`;
}

function trackFail(rec: { count: number; lockedUntil: number; updatedAt: number }, maxAttempts: number): { count: number; lockedUntil: number } {
  // 锁已过期：先清零再计本次失败（与 ipFail 同款语义）。
  if (rec.lockedUntil && rec.lockedUntil <= Date.now()) {
    rec.count = 0;
    rec.lockedUntil = 0;
  }
  rec.count += 1;
  rec.updatedAt = Date.now();
  if (rec.count >= maxAttempts) rec.lockedUntil = Date.now() + LOCKOUT_MS;
  return rec;
}

export function userIpLockRemaining(userId: number, req: Request): number {
  const rec = userIpAttempts.get(userIpKey(userId, req));
  if (!rec) return 0;
  if (rec.lockedUntil > Date.now()) return Math.ceil((rec.lockedUntil - Date.now()) / 1000);
  if (rec.lockedUntil) userIpAttempts.delete(userIpKey(userId, req));
  return 0;
}

export function userGlobalLockRemaining(userId: number): number {
  const rec = userGlobalAttempts.get(userId);
  if (!rec) return 0;
  if (rec.lockedUntil > Date.now()) return Math.ceil((rec.lockedUntil - Date.now()) / 1000);
  if (rec.lockedUntil) userGlobalAttempts.delete(userId);
  return 0;
}

export function userIpFail(userId: number, req: Request): { count: number; lockedUntil: number } {
  const k = userIpKey(userId, req);
  const rec = userIpAttempts.get(k) || { count: 0, lockedUntil: 0, updatedAt: Date.now() };
  const out = trackFail(rec, LOGIN_IP_MAX_ATTEMPTS);
  userIpAttempts.set(k, rec);
  return out;
}

export function userGlobalFail(userId: number): { count: number; lockedUntil: number } {
  const rec = userGlobalAttempts.get(userId) || { count: 0, lockedUntil: 0, updatedAt: Date.now() };
  const out = trackFail(rec, LOGIN_GLOBAL_MAX_ATTEMPTS);
  userGlobalAttempts.set(userId, rec);
  return out;
}

export function userIpReset(userId: number, req: Request): void {
  userIpAttempts.delete(userIpKey(userId, req));
}

export function userGlobalReset(userId: number): void {
  userGlobalAttempts.delete(userId);
}

// 定时清理：过期锁已在各 ipLocked/ipFail 里清零；这里扫掉无有效锁且
// 超过 24 小时未更新的陈旧记录，避免 Map 无限增长。unref，不挡进程退出。
setInterval(() => {
  const now = Date.now();
  for (const [k, rec] of ipAttempts) {
    if (rec.lockedUntil && rec.lockedUntil <= now) ipAttempts.delete(k);
    else if (!rec.lockedUntil && now - rec.updatedAt > IP_ATTEMPT_TTL_MS) ipAttempts.delete(k);
  }
  for (const [k, rec] of userIpAttempts) {
    if (rec.lockedUntil && rec.lockedUntil <= now) userIpAttempts.delete(k);
    else if (!rec.lockedUntil && now - rec.updatedAt > IP_ATTEMPT_TTL_MS) userIpAttempts.delete(k);
  }
  for (const [k, rec] of userGlobalAttempts) {
    if (rec.lockedUntil && rec.lockedUntil <= now) userGlobalAttempts.delete(k);
    else if (!rec.lockedUntil && now - rec.updatedAt > IP_ATTEMPT_TTL_MS) userGlobalAttempts.delete(k);
  }
}, 60 * 60 * 1000).unref();

export function ipFail(req: Request, scope: string): { count: number; lockedUntil: number } {
  const k = ipKey(req, scope);
  const rec = ipAttempts.get(k) || { count: 0, lockedUntil: 0, updatedAt: Date.now() };
  // 锁已过期：先清零再计本次失败（与 ipLocked 同款语义），否则锁过期后
  // 下一次失败立即重新锁定 15 分钟。
  if (rec.lockedUntil && rec.lockedUntil <= Date.now()) {
    rec.count = 0;
    rec.lockedUntil = 0;
  }
  rec.count += 1;
  rec.updatedAt = Date.now();
  if (rec.count >= MAX_FAILED_ATTEMPTS) rec.lockedUntil = Date.now() + LOCKOUT_MS;
  ipAttempts.set(k, rec);
  return rec;
}

export function ipReset(req: Request, scope: string): void {
  ipAttempts.delete(ipKey(req, scope));
}

export function ipLockRemaining(req: Request, scope: string): number {
  const until = ipLocked(req, scope);
  return until ? Math.ceil((until - Date.now()) / 1000) : 0;
}

export function createSession(
  userId: number,
  rememberMe: boolean,
  expiresAt?: Date,
): { token: string; expiresAt: Date } {
  const db = getDb();
  const token = randomToken(32);
  // Audit #9 L17：改密码轮换会话时可传入原会话的过期时间，保留剩余
  // 有效期（不传时按 rememberMe 算 30 天/1 天，与旧行为一致）。
  const exp = expiresAt && expiresAt.getTime() > Date.now()
    ? expiresAt
    : new Date(Date.now() + (rememberMe ? 30 : 1) * DAY_MS);
  // S2: 存 SQLite datetime 格式（'YYYY-MM-DD HH:MM:SS'），不要 ISO 的 T/Z。
  // 旧版存 toISOString()（'2026-11-18T05:40:19.455Z'），与 datetime('now')
  // 做字符串比较时第 11 位 'T'(0x54) 恒大于空格(0x20)，同一天内无论几点
  // 过期都判有效，会话最长多活 ~24 小时。
  const expiresSqlite = exp.toISOString().replace('T', ' ').slice(0, 19);
  db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?,?,?)')
    .run(sha256Hex(token), userId, expiresSqlite);
  return { token, expiresAt: exp };
}

export function lookupSession(token: string | null | undefined): { user_id: number; username: string } | null {
  if (!token) return null;
  const db = getDb();
  // datetime() 包一层：新格式直接比对；旧版 ISO 格式（T/Z）的遗留行
  // 也能正确过期（datetime() 会把两种格式都归一化）。
  const row = db.prepare(
    `SELECT s.user_id, u.username FROM sessions s JOIN users u ON u.id=s.user_id
     WHERE s.token_hash=? AND datetime(s.expires_at) > datetime('now')`,
  ).get(sha256Hex(token)) as { user_id: number; username: string } | undefined;
  return row || null;
}

export function destroySession(token: string | null | undefined): void {
  if (!token) return;
  getDb().prepare('DELETE FROM sessions WHERE token_hash=?').run(sha256Hex(token));
}

export function setSessionCookie(res: Response, token: string, expiresAt: Date): void {
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    // S1: SameSite=strict——本站是同源 SPA，所有 API 调用都是同站请求，
    // Strict 不影响正常使用，但能挡住跨站顶层导航 GET 携带 Cookie
    // （Lax 只挡 fetch/XHR 与跨站 POST，挡不住点链接/跳转触发的下载）。
    sameSite: 'strict',
    path: '/',
    secure: COOKIE_SECURE,
    expires: expiresAt,
  });
}

export function clearSessionCookie(res: Response): void {
  // 清除时 sameSite 须与设置时一致，否则浏览器认不出是同一个 Cookie。
  // Audit #9 L19a：secure 也须与设置时一致——生产 COOKIE_SECURE=1 时
  // Chrome 会拒绝用不带 Secure 的 Set-Cookie 覆盖/删除 Secure Cookie，
  // 登出后浏览器可能残留已失效的会话 Cookie（服务端会话已删，仅为残留）。
  res.clearCookie(SESSION_COOKIE, { httpOnly: true, sameSite: 'strict', path: '/', secure: COOKIE_SECURE });
}

// Express middleware: requires a valid session; sets req.user.
export function requireAuth(req: AuthedRequest, res: Response, next: NextFunction): void {
  const cookies = (req as Request & { cookies?: Record<string, string> }).cookies;
  const session = lookupSession(cookies?.[SESSION_COOKIE]);
  if (!session) {
    res.status(401).json({ ok: false, error: '未登录' });
    return;
  }
  req.user = { id: session.user_id, username: session.username };
  req.sessionToken = cookies?.[SESSION_COOKIE];
  next();
}

// SQLite datetime('now') 存的是 UTC 的 'YYYY-MM-DD HH:MM:SS'；
// new Date('YYYY-MM-DD HH:MM:SS') 会按本地时区解析（服务器在 CST 时
// 会早 8 小时），锁会提前失效。凡是拿 SQLite 时间串跟现在比，都走
// 这里按 UTC 解析；会话过期比较已在 SQL 里用 datetime()，不受影响。
// Audit #8 LOW-7（死代码）：原来 auth.ts 与 idempotency.ts 各有一份
// parseSqliteUtc，行为一致却各管各的；现在只留这一份共享实现——
// 毫秒版带正则守卫、解析不出返回 null；Date 版包一层，非法输入仍得
// Invalid Date（与旧行为一致）。
export function parseSqliteUtcMs(s: string | null | undefined): number | null {
  if (!s) return null;
  let iso = String(s).trim();
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(iso)) iso = `${iso.replace(' ', 'T')}Z`;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

export function parseSqliteUtc(s: string): Date {
  const ms = parseSqliteUtcMs(s);
  return new Date(ms ?? NaN);
}

// Failed-login bookkeeping on the user row (5 fails -> lock 15 min).
// Audit #10 M-1：自此只归改密码用（认证后操作，攻击者须先拿到会话）；
// 登录失败改走内存双轨（userIpFail / userGlobalFail），不再读写该行。
export function userLocked(user: UserRow): number {
  if (user.locked_until && parseSqliteUtc(user.locked_until) > new Date()) {
    return Math.ceil((parseSqliteUtc(user.locked_until).getTime() - Date.now()) / 1000);
  }
  return 0;
}

export function userFail(db: ReturnType<typeof getDb>, user: UserRow): number {
  const attempts = (user.failed_attempts || 0) + 1;
  if (attempts >= MAX_FAILED_ATTEMPTS) {
    db.prepare("UPDATE users SET failed_attempts=?, locked_until=datetime('now', '+15 minutes') WHERE id=?")
      .run(attempts, user.id);
    return LOCKOUT_MS / 1000;
  }
  db.prepare('UPDATE users SET failed_attempts=? WHERE id=?').run(attempts, user.id);
  return 0;
}

export function userReset(db: ReturnType<typeof getDb>, userId: number): void {
  db.prepare('UPDATE users SET failed_attempts=0, locked_until=NULL WHERE id=?').run(userId);
}
