import type { Transporter } from 'nodemailer';
import { makeSmtpTransporter, accountToImap } from './imapUtil.js';
import type { AccountRow } from './db.js';

// MailComposer types come from @types/nodemailer.
import MailComposer from 'nodemailer/lib/mail-composer/index.js';

export interface SendMailInput {
  to: string | string[];
  cc?: string | string[];
  bcc?: string | string[];
  subject: string;
  text?: string;
  html?: string;
  // 附件二选一：content（内存 Buffer，旧调用）或 path（磁盘临时文件，
  // 发信路由用 multer diskStorage 落盘后传 path，不再把大附件全放内存）。
  attachments?: { filename: string; content?: Buffer; path?: string; contentType?: string; size?: number }[];
}

// One cached transporter per account id; invalidated on credential/server change.
interface CachedTransporter {
  transporter: Transporter;
  _password: string;
  _smtpKey: string;
}

const transporters = new Map<number, CachedTransporter>();

export function getTransporter(account: AccountRow, password: string): Transporter {
  const cached = transporters.get(account.id);
  if (cached && cached._password === password && cached._smtpKey === smtpKey(accountToImap(account))) {
    return cached.transporter;
  }
  const transporter = makeSmtpTransporter(accountToImap(account), password);
  transporters.set(account.id, { transporter, _password: password, _smtpKey: smtpKey(accountToImap(account)) });
  return transporter;
}

export function dropTransporter(accountId: number): void {
  const cached = transporters.get(accountId);
  if (cached) { try { cached.transporter.close(); } catch { /* ignore */ } }
  transporters.delete(accountId);
}

function smtpKey(a: { smtpHost: string; smtpPort: number; smtpSecure: string }): string {
  return `${a.smtpHost}:${a.smtpPort}:${a.smtpSecure}`;
}

function splitAddrs(v: string | string[] | undefined): string[] {
  if (!v) return [];
  if (Array.isArray(v)) return v.map(String).map((s) => s.trim()).filter(Boolean);
  return String(v).split(',').map((s) => s.trim()).filter(Boolean);
}

// Build the nodemailer mail options (from / to / cc / bcc / subject /
// text / html / attachments) — shared by buildRawMail and sendMail.
function buildMailOptions(account: AccountRow, input: SendMailInput) {
  const from = account.display_name
    ? `"${account.display_name.replace(/"/g, '')}" <${account.email}>`
    : account.email;
  return {
    from,
    to: splitAddrs(input.to),
    cc: splitAddrs(input.cc),
    bcc: splitAddrs(input.bcc),
    subject: input.subject || '',
    text: input.text || undefined,
    html: input.html || undefined,
    attachments: (input.attachments || []).map((a) => ({
      filename: a.filename,
      content: a.content,
      path: a.path,
      contentType: a.contentType,
    })),
  };
}

// Compile the raw MIME buffer + Message-ID once.
// F4: 发信重试必须复用同一份 raw / 同一 Message-ID——每次重调
// sendMail 都 new MailComposer 会生成新的 Message-ID，APPEND 的副本
// 与实际发出的邮件就对不上号。调用方（发信路由）在第一次发送前调
// 一次，重试时把结果传给 sendMail。
export async function buildRawMail(
  account: AccountRow,
  input: SendMailInput,
): Promise<{ raw: Buffer; messageId: string | null }> {
  const mailOptions = buildMailOptions(account, input);
  // 只生成一次 Message-ID：先 build raw，取其 Message-ID，再显式传给
  // sendMail。否则两个独立的 MailComposer 各生成一个不同的 Message-ID，
  // raw（APPEND 进已发送）与实际发出的邮件对不上号，之后按 Message-ID
  // 关联、去重、墓碑判断都会错位。
  const composer = new MailComposer(mailOptions).compile();
  const raw: Buffer = await composer.build();
  return { raw, messageId: composer.messageId() };
}

// Build the raw MIME buffer (for APPEND to Sent) and send via nodemailer.
// Returns { messageId, raw, rejected }.
// prebuilt: buildRawMail 的结果——重试时传同一份，不再重新编译
// （否则重试会生成新的 Message-ID，见 F4）。
export async function sendMail(
  account: AccountRow,
  password: string,
  input: SendMailInput,
  prebuilt?: { raw: Buffer; messageId: string | null },
): Promise<{ messageId: string | null; raw: Buffer; rejected: string[] }> {
  const mailOptions = buildMailOptions(account, input);
  const { raw, messageId } = prebuilt ?? (await buildRawMail(account, input));
  const transporter = getTransporter(account, password);
  const info = await transporter.sendMail({ ...mailOptions, messageId: messageId ?? undefined });
  // nodemailer 只在全部收件人都被拒时才抛错；单个收件人被拒（550）时
  // 只记进 info.rejected、继续发给其他人，调用方必须检查它。
  const rejected = Array.isArray(info?.rejected) ? (info.rejected as string[]) : [];
  return { messageId: (info.messageId as string) || messageId || null, raw, rejected };
}
