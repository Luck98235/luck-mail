import { ImapFlow } from 'imapflow';
import dns from 'node:dns';
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

// Audit #11 L7：字面 IP 先归一化成 32 位整数再判定——旧版只认标准
// 点分十进制与冒号 IPv6，Node 的解析器（getaddrinfo）却会把非常规
// 写法也解析成 127.0.0.1，已实测证实：'2130706433'、'0x7f.0.0.1'、
// '0177.0.0.1'、'0x7f000001' 全部解析到 127.0.0.1，'::ffff:127.0.0.1'
// 是 IPv4 映射 IPv6。归一化覆盖：单数字（十进制/0x 十六进制/0 八进制）、
// 2/3/4 段点分（每段可为十进制/0x/0 前缀）、IPv4 映射 IPv6（::ffff:a.b.c.d
// 与 ::ffff:7f00:0001 两种写法，十六进制段数不限——::ffff:0:7f00:0001、
// ::ffff:0:0:7f00:0001 都是 127.0.0.1，见 Audit #16 LOW-1）。主机名
// （含字母的段）一律不是字面 IP，不拦截。
function ipv4PartToInt(part: string): number | null {
  if (!/^(0[xX][0-9a-fA-F]+|0[0-7]*|[0-9]+)$/.test(part)) return null;
  let v: number;
  if (/^0[xX]/.test(part)) v = parseInt(part, 16);
  else if (/^0[0-9]+$/.test(part)) v = parseInt(part, 8);
  else v = parseInt(part, 10);
  return Number.isSafeInteger(v) && v >= 0 ? v : null;
}

// 把各种写法的 IPv4 字面量归一化成 32 位整数；不是字面 IP 返回 null。
function ipv4LiteralToInt(h: string): number | null {
  const parts = h.split('.');
  if (parts.length < 1 || parts.length > 4) return null;
  const nums: number[] = [];
  for (const p of parts) {
    const v = ipv4PartToInt(p);
    if (v === null) return null;
    nums.push(v);
  }
  if (nums.length === 1) {
    return nums[0] <= 0xffffffff ? nums[0] >>> 0 : null;
  }
  if (nums.length === 2) {
    if (nums[0] > 255 || nums[1] > 0xffffff) return null;
    return (((nums[0] << 24) | nums[1]) >>> 0);
  }
  if (nums.length === 3) {
    if (nums[0] > 255 || nums[1] > 255 || nums[2] > 0xffff) return null;
    return (((nums[0] << 24) | (nums[1] << 16) | nums[2]) >>> 0);
  }
  if (nums.some((v) => v > 255)) return null;
  return (((nums[0] << 24) | (nums[1] << 16) | (nums[2] << 8) | nums[3]) >>> 0);
}

// 32 位 IPv4 整数是否属于回环/私有/链路本地/组播/保留段。
function isPrivateIPv4Int(n: number): boolean {
  const a = (n >>> 24) & 0xff;
  const b = (n >>> 16) & 0xff;
  const c = (n >>> 8) & 0xff;
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 0) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return true;
  if (a === 198 && b === 51 && c === 100) return true;
  if (a === 203 && b === 0 && c === 113) return true;
  if (a >= 224 && a <= 239) return true; // 组播
  if (a >= 240) return true; // 保留段
  return false;
}
// 把 IPv6 字面展开成 8 段十六进制组（处理 :: 压缩），无效形状返回
// null。Audit #17 LOW-1：SSRF 判定需要按展开后的段位判断是不是
// IPv4 映射/兼容形式，不能只认 ::ffff: 前缀（未压缩的
// 0:0:0:0:0:ffff:7f00:1 与兼容形式 ::7f00:1 都会漏网）。点分十进制
// 尾部（::ffff:127.0.0.1）由调用方先行处理，不进这里。
function expandIPv6Groups(v6: string): string[] | null {
  const parts = v6.split('::');
  if (parts.length > 2) return null;
  const left = parts[0] ? parts[0].split(':') : [];
  const right = parts.length === 2 ? (parts[1] ? parts[1].split(':') : []) : [];
  const total = left.length + right.length;
  if (parts.length === 1 && total !== 8) return null;
  if (total > 8) return null;
  const groups = [...left, ...Array<string>(8 - total).fill('0'), ...right];
  if (groups.length !== 8) return null;
  if (!groups.every((g) => /^[0-9a-f]{1,4}$/.test(g))) return null;
  return groups;
}
export function isPrivateOrLoopbackHost(host: string): boolean {
  const h = String(host || '').trim().toLowerCase();
  if (!h) return false;
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return true;
  // IPv6 字面（可能带方括号）。
  const v6 = h.replace(/^\[(.*)\]$/, '$1');
  if (v6.includes(':')) {
    if (v6 === '::1' || v6 === '::') return true;
    // IPv4 映射/兼容 IPv6：分两支判定（Audit #17 LOW-1 修正——第一版
    // 只留展开分支，把 #16 的 ::ffff: 多段写法误放行了）。
    // (a) ::ffff: 前缀：沿用 Audit #16 LOW-1 的保守口径——取最后 32 位
    // 判定（最后两段作高低 16 位），前面的 0 段只是补位。注意
    // ::ffff:0:7f00:0001 严格展开是 0:0:0:0:ffff:0:7f00:0001，
    // 不在 ::ffff:0:0/96 映射范围里，但 #16 已定按最后 32 位拦截，
    // 断言在位，不得收窄（可疑写法宁可多拦；正常邮件服务器不会用
    // 这种地址）。
    // (b) 其余写法：展开成 8 段后判定——前 5 段全 0 且第 6 段为 0
    // （兼容 ::/96）或 0xffff（映射 ::ffff:0:0/96）时，尾部就是一个
    // IPv4，按 IPv4 规则判定；前段非零（如 2001:db8::7f00:1）不得
    // 按 IPv4 解释。
    // 点分十进制尾部（::ffff:127.0.0.1）仍按旧口径直接取尾部判定。
    if (v6.includes('.')) {
      const n = ipv4LiteralToInt(v6.slice(v6.lastIndexOf(':') + 1));
      if (n !== null) return isPrivateIPv4Int(n);
      // 尾部不是合法 IPv4 字面 → 落到下方首段判定（无效字面不拦截）。
    } else if (v6.startsWith('::ffff:')) {
      const groups = v6.slice('::ffff:'.length).split(':').filter(Boolean);
      if (groups.length >= 2 && groups.every((g) => /^[0-9a-f]{1,4}$/.test(g))) {
        const n = ((parseInt(groups[groups.length - 2], 16) << 16) | parseInt(groups[groups.length - 1], 16)) >>> 0;
        return isPrivateIPv4Int(n);
      }
      return false;
    } else {
      const groups = expandIPv6Groups(v6);
      if (groups !== null) {
        const embedded = groups.slice(0, 5).every((g) => parseInt(g, 16) === 0)
          && (parseInt(groups[5], 16) === 0 || parseInt(groups[5], 16) === 0xffff);
        if (embedded) {
          const n = ((parseInt(groups[6], 16) << 16) | parseInt(groups[7], 16)) >>> 0;
          return isPrivateIPv4Int(n);
        }
      }
      // 展开失败（无效字面）或不是 IPv4 嵌入形式 → 落到下方首段判定。
    }
    const head = v6.split(':')[0];
    const first = parseInt(head, 16);
    if (Number.isNaN(first)) return false;
    if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10 链路本地
    if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7 唯一本地
    if ((first & 0xff00) === 0xff00) return true; // ff00::/8 组播
    return false;
  }
  // IPv4 字面：标准点分十进制与非常规写法（单数字/0x/0 前缀）一律
  // 先归一化成 32 位整数再判定；主机名（含字母的段）返回 null，不拦截。
  const n = ipv4LiteralToInt(h);
  if (n === null) return false; // 不是字面 IPv4（主机名）→ 不拦截
  return isPrivateIPv4Int(n);
}

// Audit #12 L4：主机名解析结果校验——任一主机解析出的地址是私有/
// 回环地址即返回 true。解析失败（NXDOMAIN、超时等）返回 false、
// 不提前拦截，让调用方的建连报错（信息更准确）；字面量主机直接调
// isPrivateOrLoopbackHost 也能判定，这里统一走同一口径。
export async function hostsResolveToPrivate(hosts: string[]): Promise<boolean> {
  for (const host of hosts) {
    let addrs: dns.LookupAddress[];
    try {
      addrs = await dns.promises.lookup(String(host || '').trim(), { all: true });
    } catch { continue; }
    for (const a of addrs) {
      if (isPrivateOrLoopbackHost(a.address)) return true;
    }
  }
  return false;
}

// Audit #13 L4：同步建连前的解析校验（缓存版）——审计 #12 L4 的校验
// 只在加账号/改服务器/导入（testConnectivity）时跑，引擎同步用的已存
// 账号直连，不再校验解析结果；主机 DNS 事后被改指私有地址（DNS 重绑定）
// 时同步会照连。改在引擎每次新建 IMAP 连接前都校验一次：通过的主机
// 缓存 5 分钟（同步周期内不再重复查 DNS，延迟不上升）；失败的不缓存，
// 下次建连重查（失败路径本来就走不通，不怕多一次 lookup）。
// 字面量私有地址每次都拦（判定不花 DNS，本来就便宜）。ALLOW_PRIVATE_
// MAIL_HOSTS=1 时同样放行（仅 verify-all 本地测试用）。
// 残留：缓存窗口内 DNS 被改指私有地址仍会放行一次（最长 5 分钟），以及
// lookup 与建连之间的 TOCTOU——单用户系统、只有站长本人能加账号，可接受。
const _safeHostCache = new Map<string, number>();
const SAFE_HOST_CACHE_TTL_MS = 5 * 60 * 1000;
export async function assertHostsSafe(hosts: string[]): Promise<void> {
  if (ALLOW_PRIVATE_MAIL_HOSTS) return;
  const now = Date.now();
  const toCheck: string[] = [];
  for (const h of hosts) {
    const host = String(h || '').trim();
    if (!host) continue;
    if (isPrivateOrLoopbackHost(host)) throw new Error('连接失败（服务器地址不合法）');
    const at = _safeHostCache.get(host);
    if (at != null && now - at < SAFE_HOST_CACHE_TTL_MS) continue;
    toCheck.push(host);
  }
  if (toCheck.length && await hostsResolveToPrivate(toCheck)) {
    throw new Error('连接失败（服务器地址不合法）');
  }
  for (const h of toCheck) _safeHostCache.set(h, now);
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
  // Audit #18 LOW-1 纵深防御：短命测试连接也没有 error 监听；connect→
  // logout 窗口极小，但对方 RST 仍会在无监听时抛错打死进程。挂一个空
  // 兜底（连接失败本身由 await connect() 的 rejection 报告，不记日志，
  // 免得正常测连通失败也刷一条 error 日志）。
  client.on('error', () => {});
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
  // Audit #12 L4：字面量检查拦不住解析到私有地址的主机名（DNS
  // rebinding / 攻击者控制的解析）。建连前用 dns.lookup 校验解析结果——
  // 任一解析地址是私有/回环地址即拒绝，文案与字面量路径统一。查不到
  // （NXDOMAIN 等）时不提前失败，让后续建连报错（信息更准确）。
  // 残留：lookup 与建连之间仍有竞态窗口（TOCTOU），单用户系统、只有
  // 站长本人能加账号，该残留可接受；检查范围只到解析结果，不做连接时
  // 复核。ALLOW_PRIVATE_MAIL_HOSTS=1 时同样放行。
  if (!ALLOW_PRIVATE_MAIL_HOSTS && await hostsResolveToPrivate([account.imapHost, account.smtpHost])) {
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
