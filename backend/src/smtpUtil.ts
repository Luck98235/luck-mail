import type { Transporter } from 'nodemailer';
import { makeSmtpTransporter, accountToImap } from './imapUtil.js';
import type { AccountRow } from './db.js';

// MailComposer types come from @types/nodemailer.
// nodemailer 10.x 的 exports map 只认 'nodemailer/lib/mail-composer'
// （不带 /index.js）；6.x 下该路径同样解析到 lib/mail-composer/index.js。
import MailComposer from 'nodemailer/lib/mail-composer';

export interface SendMailInput {
  to: string | string[];
  cc?: string | string[];
  bcc?: string | string[];
  subject: string;
  text?: string;
  html?: string;
  // 回复/转发 threading 头（审计 #2 缺口，后端半边）：前端回复时把
  // 原信的 Message-ID 当 inReplyTo、把原信的 References 链传下来，
  // 收件方才能把回复归入原会话线程。不传则不带这两个头。
  inReplyTo?: string;
  references?: string | string[];
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
  // Threading 头先消毒：去 CR/LF（防头注入）、限长；格式不对的直接丢弃、
  // 不让一封回复因为头格式问题发不出去。
  const cleanHeader = (v: string, maxLen: number): string | undefined => {
    const s = v.replace(/[\r\n]/g, '').trim();
    return s.length > 0 && s.length <= maxLen ? s : undefined;
  };
  const inReplyTo = typeof input.inReplyTo === 'string' ? cleanHeader(input.inReplyTo, 2000) : undefined;
  const refsRaw = Array.isArray(input.references)
    ? input.references.filter((x): x is string => typeof x === 'string')
    : (typeof input.references === 'string' ? [input.references] : []);
  const refs = refsRaw.map((x) => cleanHeader(x, 2000)).filter((x): x is string => !!x);
  const references = refs.length ? refs.join(' ').slice(0, 4000) : undefined;
  return {
    from,
    to: splitAddrs(input.to),
    cc: splitAddrs(input.cc),
    bcc: splitAddrs(input.bcc),
    subject: input.subject || '',
    text: input.text || undefined,
    html: input.html || undefined,
    ...(inReplyTo ? { inReplyTo } : {}),
    ...(references ? { references } : {}),
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
