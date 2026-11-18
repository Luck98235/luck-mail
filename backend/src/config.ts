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
export const SESSION_COOKIE = 'lm_session';

// Max failed logins before a 15-minute lockout (contract).
export const MAX_FAILED_ATTEMPTS = 5;
export const LOCKOUT_MS = 15 * 60 * 1000;

// Messages larger than this are parsed in a worker thread (contract).
export const LARGE_PARSE_THRESHOLD: number = Number(
  process.env.MAIL_PARSE_WORKER_THRESHOLD_BYTES || 5 * 1024 * 1024
);

/** Ensure data dirs exist. Returns the 32-byte master key (generated once, mode 0600). */
export function initStorage(): Buffer {
  for (const d of [DATA_DIR, ATTACHMENTS_DIR, BODIES_DIR]) fs.mkdirSync(d, { recursive: true });
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
