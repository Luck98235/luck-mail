import express from 'express';
import type { Request, Response } from 'express';
import { getDb } from '../db.js';
import type { UserRow } from '../db.js';
import { hashPassword, verifyPassword, sha256Hex } from '../cryptoUtil.js';
import {
  createSession, destroySession, setSessionCookie, clearSessionCookie,
  ipFail, ipReset, ipLockRemaining, userLocked, userFail, userReset, requireAuth,
} from '../auth.js';
import type { AuthedRequest } from '../auth.js';

export function authRoutes(): express.Router {
  const r = express.Router();

  r.get('/status', (req: Request, res: Response) => {
    const db = getDb();
    const userCount = (db.prepare('SELECT COUNT(*) c FROM users').get() as { c: number }).c;
    const cookies = (req as Request & { cookies?: Record<string, string> }).cookies;
    const token = cookies?.lm_session;
    const session = token
      ? db.prepare(
          `SELECT u.username FROM sessions s JOIN users u ON u.id=s.user_id
           WHERE s.token_hash=? AND s.expires_at > datetime('now')`,
        ).get(sha256Hex(token)) as { username: string } | undefined
      : undefined;
    res.json({
      ok: true,
      setupRequired: userCount === 0,
      loggedIn: !!session,
      ...(session ? { username: session.username } : {}),
    });
  });

  r.post('/setup', (req: Request, res: Response) => {
    const db = getDb();
    const count = (db.prepare('SELECT COUNT(*) c FROM users').get() as { c: number }).c;
    if (count > 0) return res.status(409).json({ ok: false, error: '已创建过账号' });
    const remaining = ipLockRemaining(req, 'setup');
    if (remaining > 0) {
      return res.status(429).json({ ok: false, error: '尝试次数过多，请稍后再试', retryAfter: remaining });
    }
    const { username, password, confirm } = (req.body || {}) as Record<string, unknown>;
    const fail = (msg: string, code = 400): Response => {
      ipFail(req, 'setup');
      return res.status(code).json({ ok: false, error: msg });
    };
    if (!username || typeof username !== 'string' || !username.trim()) return fail('用户名必填');
    if (username.includes('@')) return fail('用户名不要带邮箱后缀');
    if (!password || typeof password !== 'string' || password.length < 8) return fail('密码至少 8 位');
    if (password !== confirm) return fail('两次密码不一致');
    const { salt, hash } = hashPassword(password);
    db.prepare('INSERT INTO users (username, password_hash, salt) VALUES (?,?,?)')
      .run((username as string).trim(), hash, salt);
    ipReset(req, 'setup');
    return res.status(201).json({ ok: true });
  });

  r.post('/login', (req: Request, res: Response) => {
    const db = getDb();
    const { username, password, rememberMe } = (req.body || {}) as Record<string, unknown>;
    if (!username || !password) {
      return res.status(401).json({ ok: false, error: '用户名或密码不正确' });
    }
    // 用户名不区分大小写：用户建账号用的是 Luck235，保存的登录是 luck235，
    // SQLite 默认 = 是区分大小写的，查不到用户就直接报“用户名或密码不正确”。
    const user = db.prepare('SELECT * FROM users WHERE username=? COLLATE NOCASE').get(String(username).trim()) as UserRow | undefined;
    if (!user) {
      const rec = ipFail(req, 'login');
      if (rec.lockedUntil > Date.now()) {
        return res.status(429).json({ ok: false, error: '尝试次数过多，已锁定 15 分钟', retryAfter: Math.ceil((rec.lockedUntil - Date.now()) / 1000) });
      }
      return res.status(401).json({ ok: false, error: '用户名或密码不正确' });
    }
    const lockedSec = userLocked(user);
    if (lockedSec > 0) {
      return res.status(429).json({ ok: false, error: '账号已锁定，请稍后再试', retryAfter: lockedSec });
    }
    if (!verifyPassword(String(password), user.salt, user.password_hash)) {
      const lockSec = userFail(db, user);
      if (lockSec > 0) {
        return res.status(429).json({ ok: false, error: '密码错误次数过多，已锁定 15 分钟', retryAfter: lockSec });
      }
      return res.status(401).json({ ok: false, error: '用户名或密码不正确' });
    }
    userReset(db, user.id);
    ipReset(req, 'login');
    const { token, expiresAt } = createSession(user.id, rememberMe !== false);
    setSessionCookie(res, token, expiresAt);
    return res.json({ ok: true, username: user.username });
  });

  r.post('/logout', requireAuth, (req: AuthedRequest, res: Response) => {
    destroySession(req.sessionToken);
    clearSessionCookie(res);
    return res.json({ ok: true });
  });

  r.post('/change-password', requireAuth, (req: AuthedRequest, res: Response) => {
    const db = getDb();
    const { current, next } = (req.body || {}) as Record<string, unknown>;
    if (!next || typeof next !== 'string' || next.length < 8) {
      return res.status(400).json({ ok: false, error: '新密码至少 8 位' });
    }
    const user = db.prepare('SELECT * FROM users WHERE id=?').get(req.user?.id) as UserRow | undefined;
    if (!user || !verifyPassword(String(current || ''), user.salt, user.password_hash)) {
      return res.status(401).json({ ok: false, error: '当前密码不正确' });
    }
    const { salt, hash } = hashPassword(next);
    db.prepare('UPDATE users SET password_hash=?, salt=?, failed_attempts=0, locked_until=NULL WHERE id=?')
      .run(hash, salt, user.id);
    // Invalidate all other sessions; keep the current one.
    db.prepare('DELETE FROM sessions WHERE user_id=? AND token_hash != ?')
      .run(user.id, sha256Hex(req.sessionToken || ''));
    return res.json({ ok: true });
  });

  // 改用户名：单用户系统，只改自己的；用户名不带邮箱后缀，不可与已有用户名重名（不区分大小写）。
  r.post('/change-username', requireAuth, (req: AuthedRequest, res: Response) => {
    const db = getDb();
    const { username } = (req.body || {}) as Record<string, unknown>;
    const name = typeof username === 'string' ? username.trim() : '';
    if (!name) return res.status(400).json({ ok: false, error: '用户名必填' });
    if (name.includes('@')) return res.status(400).json({ ok: false, error: '用户名不要带邮箱后缀' });
    const taken = db.prepare('SELECT id FROM users WHERE username=? COLLATE NOCASE AND id != ?')
      .get(name, req.user?.id) as { id: number } | undefined;
    if (taken) return res.status(409).json({ ok: false, error: '该用户名已被使用' });
    db.prepare('UPDATE users SET username=? WHERE id=?').run(name, req.user?.id);
    return res.json({ ok: true, username: name });
  });

  return r;
}
