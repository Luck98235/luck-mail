import { ImapFlow } from 'imapflow';
import nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';
import { log } from './config.js';
import type { AccountRow } from './db.js';

// ---------------------------------------------------------------------------
// IMAP ID (RFC 2971) — NetEase Coremail (163/126/yeah/188) requires the
// client to send ID *after login, before SELECT*, or SELECT is rejected with
// `NO SELECT Unsafe Login. Please contact kefu@188.com`.
// imapflow does this automatically: ImapFlow.startSession() sends ID before
// login AND re-sends it after login when the server advertises the ID
// capability (see imapflow/lib/imap-flow.js ~1516-1526), using the
// `clientInfo` option, with keys AND values sent as quoted strings
// (imapflow/lib/commands/id.js). We pass explicit luck-mail clientInfo so
// the wire form is ("name" "luck-mail" "version" "0.1.0" ...).
// ---------------------------------------------------------------------------
export const CLIENT_INFO = {
  name: 'luck-mail',
  version: '0.1.0',
  vendor: 'luck-mail',
  'support-url': 'https://mm.ynzb.cn',
};

export interface ImapAccount {
  email: string;
  imapHost: string;
  imapPort: number;
  imapSecure: string;
  smtpHost: string;
  smtpPort: number;
  smtpSecure: string;
}

export function accountToImap(a: AccountRow): ImapAccount {
  return {
    email: a.email,
    imapHost: a.imap_host,
    imapPort: a.imap_port,
    imapSecure: a.imap_secure,
    smtpHost: a.smtp_host,
    smtpPort: a.smtp_port,
    smtpSecure: a.smtp_secure,
  };
}

export function makeImapClient(
  account: ImapAccount,
  password: string,
  extra: { logger?: unknown; disableAutoIdle?: boolean } = {},
): ImapFlow {
  return new ImapFlow({
    host: account.imapHost,
    port: Number(account.imapPort) || 993,
    secure: account.imapSecure !== 'STARTTLS',
    auth: { user: account.email, pass: password },
    clientInfo: CLIENT_INFO,
    logger: (extra.logger as never) || false,
    // Never auto-IDLE on short-lived operation clients; the engine's idle
    // client leaves the default (auto-IDLE on) enabled.
    disableAutoIdle: extra.disableAutoIdle ?? true,
    tls: { rejectUnauthorized: true },
  });
}

// Test IMAP login only (connect + ID + login, then logout). Throws on failure.
export async function testImap(
  account: ImapAccount,
  password: string,
  logger?: unknown,
): Promise<{ ok: boolean; serverInfo: unknown }> {
  const client = makeImapClient(account, password, { logger });
  try {
    await client.connect();
    // connect() runs startSession(): CAPABILITY, ID, LOGIN, ID again.
    return { ok: true, serverInfo: client.serverInfo || null };
  } finally {
    try { await client.logout(); } catch { /* already closed */ }
  }
}

export function makeSmtpTransporter(account: ImapAccount, password: string): Transporter {
  const secure = account.smtpSecure !== 'STARTTLS';
  return nodemailer.createTransport({
    host: account.smtpHost,
    port: Number(account.smtpPort) || (secure ? 465 : 587),
    secure,
    auth: { user: account.email, pass: password },
    // Fail fast instead of hanging on a slow/unreachable server (nodemailer
    // defaults are minutes-long; the add-account form must answer quickly).
    connectionTimeout: 15000,
    greetingTimeout: 15000,
    socketTimeout: 30000,
    tls: { rejectUnauthorized: true },
  });
}

// Test SMTP connectivity: TCP+TLS handshake + AUTH (verify). Throws on failure.
export async function testSmtp(account: ImapAccount, password: string): Promise<{ ok: boolean }> {
  const transporter = makeSmtpTransporter(account, password);
  try {
    await transporter.verify();
    return { ok: true };
  } finally {
    transporter.close();
  }
}

export interface ConnectivityResult {
  imapOk: boolean;
  smtpOk: boolean;
  error: string | null;
}

// Combined connectivity test used by account create/update. Returns step
// results; never throws for a plain connection/auth failure.
export async function testConnectivity(
  account: ImapAccount,
  password: string,
  logger?: unknown,
): Promise<ConnectivityResult> {
  const result: ConnectivityResult = { imapOk: false, smtpOk: false, error: null };
  try {
    await testImap(account, password, logger);
    result.imapOk = true;
  } catch (e) {
    result.error = `IMAP 连接失败（${account.imapHost}:${account.imapPort}）：${readableImapError(e)}`;
    return result;
  }
  try {
    await testSmtp(account, password);
    result.smtpOk = true;
  } catch (e) {
    result.error = `SMTP 连接失败（${account.smtpHost}:${account.smtpPort}）：${readableImapError(e)}`;
    return result;
  }
  return result;
}

export function readableImapError(e: unknown): string {
  const err = e as { message?: string; authenticationFailed?: boolean; responseText?: string; code?: string; response?: string };
  const msg = String(err?.message || e || '未知错误');
  // imapflow puts the real verdict in `authenticationFailed` + `responseText`
  // (its .message is just the generic "Command failed"); nodemailer uses
  // code EAUTH / "Invalid login: 550 ...".
  const serverText = err?.responseText || err?.response || '';
  if (err?.authenticationFailed || err?.code === 'EAUTH'
    || /Invalid login|AUTHENTICATIONFAILED|Login error/i.test(msg + ' ' + serverText)) {
    return `用户名或密码/授权码不正确（认证被拒${serverText ? '：' + serverText.slice(0, 120) : ''}）`;
  }
  if (/Timed out|timeout/i.test(msg)) return '连接超时（服务器无响应）';
  if (/ENOTFOUND|getaddrinfo/i.test(msg)) return '域名解析失败（服务器地址不对或网络不通）';
  if (/ECONNREFUSED/i.test(msg)) return '连接被拒（端口不对或服务未开）';
  if (/certificate|SELF_SIGNED|UNABLE_TO_VERIFY/i.test(msg)) return 'TLS 证书校验失败';
  return (serverText ? `${msg}（${serverText.slice(0, 120)}）` : msg).slice(0, 300);
}

export function logError(...args: unknown[]): void {
  log('[error]', ...args);
}
