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
  const keyDir = path.dirname(KEY_FILE);
  if (keyDir) fs.mkdirSync(keyDir, { recursive: true });

  if (fs.existsSync(KEY_FILE)) {
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
