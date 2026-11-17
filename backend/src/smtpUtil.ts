import nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';
import { makeSmtpTransporter, accountToImap } from './imapUtil.js';
import type { ImapAccount } from './imapUtil.js';
import type { AccountRow } from './db.js';

// Nodemailer MailComposer has no bundled types; declare the module loosely.
import MailComposer from 'nodemailer/lib/mail-composer/index.js';

export interface SendMailInput {
  to: string | string[];
  cc?: string | string[];
  bcc?: string | string[];
  subject: string;
  text?: string;
  html?: string;
  attachments?: { filename: string; content: Buffer; contentType?: string }[];
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

// Build the raw MIME buffer (for APPEND to Sent) and send via nodemailer.
// Returns { messageId, raw }.
export async function sendMail(
  account: AccountRow,
  password: string,
  input: SendMailInput,
): Promise<{ messageId: string | null; raw: Buffer }> {
  const from = account.display_name
    ? `"${account.display_name.replace(/"/g, '')}" <${account.email}>`
    : account.email;
  const mailOptions = {
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
      contentType: a.contentType,
    })),
  };
  const raw: Buffer = await new MailComposer(mailOptions).compile().build();
  const transporter = getTransporter(account, password);
  const info = await transporter.sendMail(mailOptions);
  return { messageId: (info.messageId as string) || null, raw };
}

export type { ImapAccount };
