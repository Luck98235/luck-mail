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
const ipAttempts = new Map<string, { count: number; lockedUntil: number }>();

function ipKey(req: Request, scope: string): string {
  return `${scope}:${req.ip || req.socket?.remoteAddress || 'unknown'}`;
}

function ipLocked(req: Request, scope: string): number {
  const rec = ipAttempts.get(ipKey(req, scope));
  if (rec && rec.lockedUntil > Date.now()) return rec.lockedUntil;
  return 0;
}

export function ipFail(req: Request, scope: string): { count: number; lockedUntil: number } {
  const k = ipKey(req, scope);
  const rec = ipAttempts.get(k) || { count: 0, lockedUntil: 0 };
  rec.count += 1;
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

export function createSession(userId: number, rememberMe: boolean): { token: string; expiresAt: Date } {
  const db = getDb();
  const token = randomToken(32);
  const expiresAt = new Date(Date.now() + (rememberMe ? 30 : 1) * DAY_MS);
  // S2: 存 SQLite datetime 格式（'YYYY-MM-DD HH:MM:SS'），不要 ISO 的 T/Z。
  // 旧版存 toISOString()（'2026-11-18T05:40:19.455Z'），与 datetime('now')
  // 做字符串比较时第 11 位 'T'(0x54) 恒大于空格(0x20)，同一天内无论几点
  // 过期都判有效，会话最长多活 ~24 小时。
  const expiresSqlite = expiresAt.toISOString().replace('T', ' ').slice(0, 19);
  db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?,?,?)')
    .run(sha256Hex(token), userId, expiresSqlite);
  return { token, expiresAt };
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
  res.clearCookie(SESSION_COOKIE, { httpOnly: true, sameSite: 'strict', path: '/' });
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
