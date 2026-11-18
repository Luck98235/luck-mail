import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BACKEND_ROOT = path.resolve(__dirname, '..');

function resolveDir(v: string | undefined, fallback: string): string {
  return path.resolve(v || fallback);
}

export const PORT: number = Number(process.env.PORT || 8080);
export const DATA_DIR: string = resolveDir(process.env.DATA_DIR, path.join(BACKEND_ROOT, 'data'));
export const PUBLIC_DIR: string = resolveDir(process.env.PUBLIC_DIR, path.join(BACKEND_ROOT, 'public'));
export const KEY_FILE: string = process.env.KEY_FILE
  ? path.resolve(process.env.KEY_FILE)
  : path.join(DATA_DIR, '.key');
export const DB_FILE: string = path.join(DATA_DIR, 'luck-mail.db');
export const ATTACHMENTS_DIR: string = path.join(DATA_DIR, 'attachments');
export const BODIES_DIR: string = path.join(DATA_DIR, 'bodies');
export const COOKIE_SECURE: boolean = process.env.COOKIE_SECURE === '1';
// Audit #10 L-9：__Host- 前缀——浏览器只接受 Secure + Path=/ + 无 Domain
// 的 __Host- Cookie，子域无法覆盖/冒充会话 Cookie。生产 COOKIE_SECURE=1
// 时用 __Host-lm_session；本地 HTTP 开发（COOKIE_SECURE=0）时 Secure
// 的 __Host- Cookie 会被浏览器拒绝，仍用 lm_session。改名前旧会话
// Cookie 失效，用户需重新登录一次（部署后首次登录即生效）。
export const SESSION_COOKIE = COOKIE_SECURE ? '__Host-lm_session' : 'lm_session';

// Max mailboxes (architecture decision 2026-11-17, enforced 2026-11-18
// audit #10 D5): POST /api/accounts and CSV import both reject above this.
export const MAX_ACCOUNTS = 50;

// First-run bootstrap token for POST /api/auth/setup (audit #10 H-1):
// generated at startup while the users table is empty, written to this
// file (0600) and logged once; deleted when the first user is created.
// The file lives in DATA_DIR, next to the DB and .key.
export const SETUP_TOKEN_FILE: string = path.join(DATA_DIR, '.setup-token');

// Audit #10 M-2：测试专用逃生口——默认拒绝私有/回环地址；仅当显式设置
// ALLOW_PRIVATE_MAIL_HOSTS=1（verify-all 本地测试用，假 IMAP/SMTP
// 服务器跑在 127.0.0.1）时才放行。生产绝不设此变量。
export const ALLOW_PRIVATE_MAIL_HOSTS: boolean = process.env.ALLOW_PRIVATE_MAIL_HOSTS === '1';
export const MAX_FAILED_ATTEMPTS = 5;
export const LOCKOUT_MS = 15 * 60 * 1000;

// Messages larger than this are parsed in a worker thread (contract).
export const LARGE_PARSE_THRESHOLD: number = Number(
  process.env.MAIL_PARSE_WORKER_THRESHOLD_BYTES || 5 * 1024 * 1024
);

/** Ensure data dirs exist. Returns the 32-byte master key (generated once, mode 0600). */
export function initStorage(): Buffer {
  for (const d of [DATA_DIR, ATTACHMENTS_DIR, BODIES_DIR]) fs.mkdirSync(d, { recursive: true });
  // Audit #10 M-4：DATA_DIR 本身也只允许属主访问（旧版默认 umask，
  // 与 -wal/-shm 的 0644 泄漏同源：本地其他账号能读近期数据库页）。
  try { fs.chmodSync(DATA_DIR, 0o700); } catch { /* ignore */ }
  // S10: 正文与附件缓存目录只允许属主访问（旧版是默认 umask，0775/0755，
  // 服务器上任何本地账号都能读全部邮件明文）。
  try { fs.chmodSync(BODIES_DIR, 0o700); } catch { /* ignore */ }
  try { fs.chmodSync(ATTACHMENTS_DIR, 0o700); } catch { /* ignore */ }
  const keyDir = path.dirname(KEY_FILE);
  if (keyDir) fs.mkdirSync(keyDir, { recursive: true });

  if (fs.existsSync(KEY_FILE)) {
    // Audit #9 L15：已存在的 .key 也要强制 0600——旧版只在新建时写
    // 0600，已存在时直接读、不校验不纠正；若线上文件实际是 0644，
    // 会一直保持。stat 校验，不符则纠正并记告警（纠正失败也记告警，
    // 不阻塞启动——读密钥本身不受权限位影响）。
    try {
      const st = fs.statSync(KEY_FILE);
      if ((st.mode & 0o777) !== 0o600) {
        fs.chmodSync(KEY_FILE, 0o600);
        log(`[warn] KEY_FILE ${KEY_FILE} mode was 0${(st.mode & 0o777).toString(8)}, chmod to 0600`);
      }
    } catch (e) {
      log('[warn] failed to enforce KEY_FILE mode 0600:', (e as Error)?.message || e);
    }
    const key = fs.readFileSync(KEY_FILE);
    if (key.length !== 32) throw new Error(`KEY_FILE ${KEY_FILE} is not 32 bytes`);
    return key;
  }
  const key = crypto.randomBytes(32);
  fs.writeFileSync(KEY_FILE, key, { mode: 0o600 });
  // writeFileSync mode applies on creation; enforce it explicitly too.
  fs.chmodSync(KEY_FILE, 0o600);
  return key;
}

export function log(...args: unknown[]): void {
  console.log(new Date().toISOString(), ...args);
}
