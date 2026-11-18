import crypto from 'node:crypto';
import { promisify } from 'node:util';

// Audit #9 L19e：scrypt 改异步——同步版每次登录/建账号/改密码都阻塞
// 事件循环数十毫秒，暴力登录可放大为服务迟滞。调用方（authRoutes 的
// setup/login/change-password）均为 async 上下文，见该文件。
const scryptAsync = promisify(crypto.scrypt);

// ---- User password hashing: scrypt (Node built-in) ----
export async function hashPassword(password: string): Promise<{ salt: string; hash: string }> {
  const salt = crypto.randomBytes(16);
  const hash = (await scryptAsync(password, salt, 64)) as Buffer;
  return { salt: salt.toString('hex'), hash: hash.toString('hex') };
}

export async function verifyPassword(password: string, saltHex: string, hashHex: string): Promise<boolean> {
  const salt = Buffer.from(saltHex, 'hex');
  const expected = Buffer.from(hashHex, 'hex');
  const actual = (await scryptAsync(password, salt, 64)) as Buffer;
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

// Audit #9 L18：未知用户名也跑一次固定成本的 dummy scrypt 再返回——
// 已知用户名走 verifyPassword（数十毫秒），未知用户名若直接 401，
// 时序可区分用户名是否存在。固定盐/固定哈希，结果恒为 false，只取
// 与正常校验相同的计算成本。
const DUMMY_SALT_HEX = '00'.repeat(16);
const DUMMY_HASH_HEX = '00'.repeat(64);
export async function dummyPasswordCheck(password: string): Promise<boolean> {
  return verifyPassword(password, DUMMY_SALT_HEX, DUMMY_HASH_HEX);
}

// ---- Mailbox credential encryption: AES-256-GCM, one master key ----
// Envelope: base64( iv(12) || tag(16) || ciphertext ). Never store plaintext.
export function encryptSecret(plaintext: string, key: Buffer): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ct]).toString('base64');
}

export function decryptSecret(envelope: string, key: Buffer): string {
  const buf = Buffer.from(envelope, 'base64');
  // Audit #9 L19b：前置信封长度校验——信封为 iv(12) + tag(16) + 密文，
  // 解码后 <28 字节时以前在 setAuthTag 抛错（走通用 500）；现在抛
  // 明确的业务错，各调用点统一 try/catch 后按 500 JSON 返回。
  if (buf.length < 28) throw new Error('加密信封长度不足（损坏的密文）');
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const ct = buf.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

export function sha256Hex(s: string): string {
  return crypto.createHash('sha256').update(s).digest('hex');
}

export function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('hex');
}
