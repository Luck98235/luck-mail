import { ImapFlow } from 'imapflow';
import nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';
import { log, ALLOW_PRIVATE_MAIL_HOSTS } from './config.js';
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

// Audit #10 M-2：拒绝回环/私有/链路本地/组播字面 IP——已认证的 SSRF：
// 邮箱服务器地址原来只验非空与端口范围，可指向 127.0.0.1、内网段或
// 169.254.169.254（云元数据）。主机名仍按原样解析（DNS 解析后是否
// 内网由上游网络隔离处理——服务端只应连互联网邮件服务商；常见内网
// 主机名如 localhost 也一并拒绝）。
// 字面 IPv4/IPv6 的判定：10/8、172.16/12、192.168/16、127/8、169.254/16、
// 0.0.0.0/8、100.64/10（CGNAT）、192.0.0.0/24、192.0.2.0/24、198.51.100.0/24、
// 203.0.113.0/24（文档段）、224.0.0.0/4（组播）、240.0.0.0/4（保留）、
// ::1、fe80::/10、fc00::/7、ff00::/8、::（未指定）。
export function isPrivateOrLoopbackHost(host: string): boolean {
  const h = String(host || '').trim().toLowerCase();
  if (!h) return false;
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return true;
  // IPv6 字面（可能带方括号）。
  const v6 = h.replace(/^\[(.*)\]$/, '$1');
  if (v6.includes(':')) {
    if (v6 === '::1' || v6 === '::') return true;
    const head = v6.split(':')[0];
    const first = parseInt(head, 16);
    if (Number.isNaN(first)) return false;
    if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10 链路本地
    if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7 唯一本地
    if ((first & 0xff00) === 0xff00) return true; // ff00::/8 组播
    return false;
  }
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false; // 不是字面 IPv4（主机名）→ 不拦截
  const [a, b] = [Number(m[1]), Number(m[2])];
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 0) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 192 && b === 0 && (Number(m[3]) === 0 || Number(m[3]) === 2)) return true;
  if (a === 198 && b === 51 && Number(m[3]) === 100) return true;
  if (a === 203 && b === 0 && Number(m[3]) === 113) return true;
  if (a >= 224 && a <= 239) return true; // 组播
  if (a >= 240) return true; // 保留段
  return false;
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
    // Audit #10 M-12：logout 加 5 秒超时——旧版 finally 里裸 await
    // logout()，超时 race 触发后底层连接仍可能在 logout 里挂住
    // （imapflow 默认无 logout 超时），最坏再等 socketTimeout。
    try {
      await Promise.race([
        client.logout(),
        new Promise<void>((resolve) => setTimeout(resolve, 5000)),
      ]);
    } catch { /* already closed */ }
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
// timeoutMs：单次调用的封顶（默认 15 秒）；CSV 导入按剩余总预算递减传入
// （audit #10 H-3），预算耗尽时整批提前结束。
const CONNECTIVITY_TEST_TIMEOUT_MS = 15 * 1000;
export async function testConnectivity(
  account: ImapAccount,
  password: string,
  logger?: unknown,
  timeoutMs: number = CONNECTIVITY_TEST_TIMEOUT_MS,
): Promise<ConnectivityResult> {
  // Audit #10 M-2：回环/私有/链路本地/组播地址在建连之前就拒掉——
  // 不触网、不泄露底层 socket 错误细节，错误文案统一为“连接失败”。
  // ALLOW_PRIVATE_MAIL_HOSTS=1 时放行（仅 verify-all 本地测试用，
  // 见 config.ts；生产绝不设）。
  if (!ALLOW_PRIVATE_MAIL_HOSTS
    && (isPrivateOrLoopbackHost(account.imapHost) || isPrivateOrLoopbackHost(account.smtpHost))) {
    return { imapOk: false, smtpOk: false, error: '连接失败（服务器地址不合法）' };
  }
  const budgetSec = Math.max(1, Math.round(timeoutMs / 1000));
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
        resolve({ imapOk: false, smtpOk: false, error: `${where}：连接超时（${budgetSec} 秒内服务器无响应）` });
      }, timeoutMs);
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
  const err = e as { message?: string; responseText?: string; code?: string; response?: string | { attributes?: { section?: { value?: unknown }[] }[] } };
  // Audit #9 M8：response 为对象时也提取响应码——之前只拼字符串，
  // 对象经模板字符串变成 "[object Object]"，421/451 码丢失。
  // 复用 isAuthError 的对象解析方式（attributes[0].section[0].value）。
  const text = `${err?.message || ''} ${err?.responseText || ''} ${responseObjectText(err?.response)}`;
  if (/\b(421|451)\b/.test(text)) return true;
  return /too many connections|too frequent|temporarily blocked|temporarily banned|rate limit|throttl|login too frequent|too many login/i.test(text);
}

// 从 imapflow 的结构化 response 对象里提取可读文本（与 isAuthError
// 同款解析：attributes[].section[].value），字符串 response 原样返回。
function responseObjectText(resp: unknown): string {
  if (typeof resp === 'string') return resp;
  if (resp && typeof resp === 'object') {
    const r = resp as { attributes?: { section?: { value?: unknown }[] }[]; text?: unknown };
    const parts: string[] = [];
    for (const attr of r.attributes || []) {
      for (const s of attr?.section || []) {
        if (typeof s?.value === 'string') parts.push(s.value);
      }
    }
    if (typeof r.text === 'string') parts.push(r.text);
    return parts.join(' ');
  }
  return '';
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
