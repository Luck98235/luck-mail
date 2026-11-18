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
// `clientInfo` option. imapflow 的 ID 编译器按值拼：纯 atom 字符的值发
// atom、不带引号，只有含 `:` `/` 等特殊字符的值才发带引号字符串
// （imapflow/lib/commands/id.js）——键与值并非一律加引号，行为本身
// 没问题（24 个 163 账号线上正常同步即是活证据）。We pass explicit
// luck-mail clientInfo so the wire form is ("name" "luck-mail" "version" "0.1.0" ...).
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
    // B10: 显式 IMAP 超时——不靠 imapflow 默认值（无响应时连接不能无限挂住，
    // 否则 _runOp 一直等、IDLE 也永远不触发重连）。
    socketTimeout: 120000,
    connectionTimeout: 30000,
    greetingTimeout: 30000,
  });
}

// Test IMAP login only (connect + ID + login, then logout). Throws on failure.
async function testImap(
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
    // B5: 连接池——每次发信不再新建连接+重新登录。单账号同时只发一封
    // （maxConnections: 1），一个连接最多发 100 封后轮换，对服务器友好、
    // 也不怕并发登录被限。nodemailer 10.x 仍支持 pool 选项；close() 仍
    // 可正常关闭池（dropTransporter 已验证）。
    pool: true,
    maxConnections: 1,
    maxMessages: 100,
    // Fail fast instead of hanging on a slow/unreachable server (nodemailer
    // defaults are minutes-long; the add-account form must answer quickly).
    connectionTimeout: 15000,
    greetingTimeout: 15000,
    socketTimeout: 30000,
    tls: { rejectUnauthorized: true },
  });
}

// ---- B15: SMTP 4xx/5xx 分类（发信失败时按响应码决定重试/直接失败）----
// nodemailer 的 SMTP 错误带 responseCode（如 421/450/550）；没有时从
// response/message 文本里抓第一个三位数响应码；都没有返回 null。
export function smtpResponseCode(e: unknown): number | null {
  const err = e as { responseCode?: unknown; response?: unknown; message?: unknown };
  if (typeof err?.responseCode === 'number') return err.responseCode;
  const text = String(err?.response || err?.message || '');
  const m = text.match(/(\d{3})\b/);
  return m ? Number(m[1]) : null;
}

// 4xx = 临时拒绝（灰名单/限流/对方繁忙）：值得重试 1 次。
export function isTransientSmtpError(e: unknown): boolean {
  const c = smtpResponseCode(e);
  return c !== null && c >= 400 && c < 500;
}

// 5xx = 永久拒绝（收件人不存在/内容被拒/认证错）：重试也没用，直接失败。
export function isPermanentSmtpError(e: unknown): boolean {
  const c = smtpResponseCode(e);
  return c !== null && c >= 500 && c < 600;
}

// Test SMTP connectivity: TCP+TLS handshake + AUTH (verify). Throws on failure.
async function testSmtp(account: ImapAccount, password: string): Promise<{ ok: boolean }> {
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
// 总封顶 15 秒：IMAP 单项超时最长 30 秒、SMTP 最长 15+30 秒，一个死服务器
// 会拖住整次调用（批量导入逐行测时更糟）。Promise.race 只截断等待、不取
// 消底层的建连尝试（imapflow/nodemailer 不提供取消），超时后底层 socket
// 仍受各自的 connectionTimeout/socketTimeout 约束、最长 30 秒内自行收敛，
// 不影响已返回的结果。超时按连接失败返回，文案说明是超时及卡在哪一步。
const CONNECTIVITY_TEST_TIMEOUT_MS = 15 * 1000;
export async function testConnectivity(
  account: ImapAccount,
  password: string,
  logger?: unknown,
): Promise<ConnectivityResult> {
  let phase: 'imap' | 'smtp' = 'imap';
  const run = (async (): Promise<ConnectivityResult> => {
    const result: ConnectivityResult = { imapOk: false, smtpOk: false, error: null };
    try {
      await testImap(account, password, logger);
      result.imapOk = true;
    } catch (e) {
      result.error = `IMAP 连接失败（${account.imapHost}:${account.imapPort}）：${readableImapError(e)}`;
      return result;
    }
    phase = 'smtp';
    try {
      await testSmtp(account, password);
      result.smtpOk = true;
    } catch (e) {
      result.error = `SMTP 连接失败（${account.smtpHost}:${account.smtpPort}）：${readableImapError(e)}`;
      return result;
    }
    return result;
  })();
  let timer: NodeJS.Timeout | undefined;
  try {
    const timeout = new Promise<ConnectivityResult>((resolve) => {
      timer = setTimeout(() => {
        const where = phase === 'imap'
          ? `IMAP 连接失败（${account.imapHost}:${account.imapPort}）`
          : `SMTP 连接失败（${account.smtpHost}:${account.smtpPort}）`;
        resolve({ imapOk: false, smtpOk: false, error: `${where}：连接超时（15 秒内服务器无响应）` });
      }, CONNECTIVITY_TEST_TIMEOUT_MS);
      timer.unref?.();
    });
    return await Promise.race([run, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// B2: 判断一次 IMAP/SMTP 错误是不是认证失败（密码/授权码错）。
// imapflow 把真实结论放在 `authenticationFailed` + `responseText` 里
// （.message 只是通用的 "Command failed"）；nodemailer 用 code EAUTH /
// "Invalid login: 550 ..."。
// 注意 Gmail/Outlook 风格：服务器回 `NO [AUTHENTICATIONFAILED] Invalid
// credentials`——imapflow 的 responseText 只含 TEXT 段（方括号里的响应码
// 被解析成 section，不在文本里），message 又是通用的 "Command failed"，
// 光看文本认不出来；响应码在 err.response（解析后的响应对象）里，直接
// 按码判定。只看文本的旧版会把这类失败当成普通连接错误：引擎不置
// authFailed、账号继续拿错凭证重连；导入失败原因也只会是含糊的
// "Command failed"。密码错与授权码错同等对待：服务器拒绝登录即认证失败。
export function isAuthError(e: unknown): boolean {
  const err = e as {
    message?: string; authenticationFailed?: boolean; responseText?: string; code?: string;
    response?: string | { attributes?: { section?: { value?: unknown }[] }[] };
  };
  if (err?.authenticationFailed || err?.code === 'EAUTH') return true;
  const resp = err?.response;
  if (resp && typeof resp === 'object') {
    const code = resp.attributes?.[0]?.section?.[0]?.value;
    if (typeof code === 'string' && code.toUpperCase() === 'AUTHENTICATIONFAILED') return true;
  }
  const text = `${err?.message || ''} ${err?.responseText || ''} ${typeof resp === 'string' ? resp : ''}`;
  return /Invalid login|AUTHENTICATIONFAILED|Login error|Invalid credentials/i.test(text);
}

// Audit #8 LOW-1（友好性）：识别服务器的限流/拒绝信号（不是认证失败）。
// 命中时调用方把退避下限提到 5 分钟、且不走重连循环只等轮询——
// 否则按通用错误 5 秒就重试，会延长服务器限流。网易 451（登录失败
// 过多临时禁登）、421 HL:ICC（并发连接过大临时禁连）都在这里。
export function isThrottleError(e: unknown): boolean {
  const err = e as { message?: string; responseText?: string; code?: string; response?: string };
  const text = `${err?.message || ''} ${err?.responseText || ''} ${err?.response || ''}`;
  if (/\b(421|451)\b/.test(text)) return true;
  return /too many connections|too frequent|temporarily blocked|temporarily banned|rate limit|throttl|login too frequent|too many login/i.test(text);
}

export function readableImapError(e: unknown): string {
  const err = e as { message?: string; authenticationFailed?: boolean; responseText?: string; code?: string; response?: string };
  const msg = String(err?.message || e || '未知错误');
  const serverText = err?.responseText || err?.response || '';
  if (isAuthError(e)) {
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
