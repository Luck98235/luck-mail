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
  db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?,?,?)')
    .run(sha256Hex(token), userId, expiresAt.toISOString());
  return { token, expiresAt };
}

export function lookupSession(token: string | null | undefined): { user_id: number; username: string } | null {
  if (!token) return null;
  const db = getDb();
  const row = db.prepare(
    `SELECT s.user_id, u.username FROM sessions s JOIN users u ON u.id=s.user_id
     WHERE s.token_hash=? AND s.expires_at > datetime('now')`,
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
    sameSite: 'lax',
    path: '/',
    secure: COOKIE_SECURE,
    expires: expiresAt,
  });
}

export function clearSessionCookie(res: Response): void {
  res.clearCookie(SESSION_COOKIE, { httpOnly: true, sameSite: 'lax', path: '/' });
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

// Failed-login bookkeeping on the user row (5 fails -> lock 15 min).
export function userLocked(user: UserRow): number {
  if (user.locked_until && new Date(user.locked_until) > new Date()) {
    return Math.ceil((new Date(user.locked_until).getTime() - Date.now()) / 1000);
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
