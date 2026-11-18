import fs from 'node:fs';
import { pipeline } from 'node:stream/promises';
import type { ImapFlow, FetchMessageObject } from 'imapflow';
import {
  getDb, refreshFolderCounts, indexMessageFts, indexMessageEnvelope, removeMessageFts,
  removeMessagesFtsByFolder, bodyHtmlPath, bodyTextPath, removeBodyFiles,
} from './db.js';
import type { AccountRow, FolderRow, MessageRow, AttachmentRow } from './db.js';
import { decryptSecret } from './cryptoUtil.js';
import { makeImapClient, accountToImap, logError, isAuthError } from './imapUtil.js';
import {
  detectFolderType, displayNameOf, collectAttachmentParts, matchAttachmentParts,
  isNonSelectable, toIsoDate,
} from './mailUtil.js';
import type { ListEntry, AttachmentPart } from './mailUtil.js';
import { streamToParsed } from './mailStream.js';
import { spoolToTemp, parseInWorker } from './streamParse.js';
import { emit } from './hub.js';
import { LARGE_PARSE_THRESHOLD, log } from './config.js';

const RECONNECT_BASE_MS = 5000;
const RECONNECT_MAX_MS = 5 * 60 * 1000;
// Fallback INBOX re-sync interval. IMAP IDLE is the primary new-mail path,
// but some servers (notably QQ Mail) do not reliably push `exists`
// notifications — the connection stays up yet new mail never triggers a
// sync, so it sits on the server until the next reconnect (hours/days).
// A periodic INBOX sync bounds that delay to this interval.
const PERIODIC_SYNC_MS = 5 * 60 * 1000;
// Full flag comparison (CONDSTORE fallback) runs at most this often per
// folder — it is a whole-folder FETCH, so it must not run on every IDLE
// event. Same cadence as the periodic INBOX sync.
const FLAG_SYNC_INTERVAL_MS = 5 * 60 * 1000;
// Fetch only the first bytes of the TEXT part for the list snippet; the full
// source is fetched (and parsed) only when a message is opened.
const SNIPPET_BYTES = 4096;
// B11: 短命共享连接的闲置保持窗口——队列里连续的 withClient 调用共用
// 一个连接；最后一个调用完成后闲置这么久无人用就登出。
const SHARED_IDLE_MS = 2000;

// 标准文件夹前台统一显示中文名（QQ 等服务器返回英文名，163 返回中文名，
// 映射后两边一致；服务器英文名只做分类依据，不直接显示）。
// 自定义文件夹（type=other，如 QQ邮件订阅、个人邮件）保留服务器原名。
const FOLDER_DISPLAY_NAMES: Record<string, string> = {
  inbox: '收件夹',
  drafts: '草稿箱',
  sent: '已发送',
  trash: '已删除',
  spam: '垃圾邮件',
};

// R1: 网易系邮箱（163/126/yeah/188，同属 Coremail）——服务器会在约
// 206 秒后静默断掉 IDLE 连接（每账号每小时约 400 次登录），长连接 +
// IDLE 在此基本无效；这类账号改固定轮询（短命连接，每 5 分钟同步全部
// 文件夹），QQ 等其他服务商保留 IDLE。
export function isNetEaseHost(host: string): boolean {
  const h = (host || '').toLowerCase().trim();
  return /(^|\.)(163\.com|126\.com|yeah\.net|188\.com)$/.test(h);
}

interface AccountState {
  account: AccountRow;
  client: ImapFlow | null;
  backoffMs: number;
  timer: NodeJS.Timeout | null;
  syncTimer: NodeJS.Timeout | null;
  queue: Promise<unknown>;
  // B2: 认证失败后停止自动重连（密码/授权码错时不再每 5 分钟登录一次）。
  authFailed: boolean;
  // B7: IDLE exists 事件合并——已有同步排队/进行中时直接跳过。
  syncPending: boolean;
  // B10: 连续 _runOp 失败计数（成功清零）；达 2 次且连接仍 usable 时主动重连。
  opFailures: number;
  // B11: 短命共享连接（无长连接时 on-demand 操作共用；闲置超时后登出）。
  sharedClient: ImapFlow | null;
  sharedTimer: NodeJS.Timeout | null;
  // B23: 上次 LIST 文件夹清单的时间；手动刷新 1 小时内复用缓存清单。
  lastFolderListAt: number | null;
  // R1: 网易系账号不保持长连接 IDLE，改轮询（_pollAllFolders）。
  pollOnly: boolean;
}

// Public envelope shape (contract): no body, no password, ever.
export function envelopeOf(row: MessageRow, accountEmail: string): Record<string, unknown> {
  return {
    id: row.id,
    accountId: row.account_id,
    accountEmail: accountEmail || row.account_email || '',
    folderId: row.folder_id,
    folderPath: row.folder_path || '',
    uid: row.uid,
    subject: row.subject || '',
    from: row.from_addr || '',
    fromName: row.from_name || '',
    to: JSON.parse(row.to_json || '[]') as string[],
    date: row.date || null,
    snippet: row.snippet || '',
    isRead: !!row.is_read,
    hasAttachments: !!row.has_attachments,
    size: row.size || 0,
  };
}

export class SyncEngine {
  private key: Buffer;
  private states = new Map<number, AccountState>();
  // Per-message in-flight full fetch (M1): concurrent opens of the same
  // message share one fetch, so attachment rows are never inserted twice.
  private fullFetchInflight = new Map<number, Promise<MessageRow>>();
  // Last full flag comparison per folder id (M5 CONDSTORE fallback throttle).
  private lastFullFlagSync = new Map<number, number>();
  // R3: F1 去重时被跳过的服务器副本 UID（按文件夹）。只记内存：
  // 下次同步直接跳过，不再重复 FETCH；全量重取/文件夹删除时清空。
  private skippedDupeUids = new Map<number, Set<number>>();

  constructor(masterKey: Buffer) {
    this.key = masterKey;
  }

  // ---------- lifecycle ----------
  startAll(): void {
    const db = getDb();
    const rows = db.prepare('SELECT * FROM accounts WHERE enabled=1').all() as AccountRow[];
    // B3(a): 启动错峰——每账号间隔约 300ms，避免 27 个账号同时建连、
    // 同时 ID+LOGIN，把服务器的并发登录打满（惊群）。
    rows.forEach((row, i) => {
      setTimeout(() => this.startAccount(row.id), i * 300);
    });
  }

  startAccount(accountId: number): void {
    const db = getDb();
    const account = db.prepare('SELECT * FROM accounts WHERE id=?').get(accountId) as AccountRow | undefined;
    if (!account || !account.enabled) return;
    this.stopAccount(accountId, true);
    const state: AccountState = {
      account,
      client: null,
      backoffMs: RECONNECT_BASE_MS,
      timer: null,
      syncTimer: null,
      queue: Promise.resolve(),
      authFailed: false,
      syncPending: false,
      opFailures: 0,
      sharedClient: null,
      sharedTimer: null,
      lastFolderListAt: null,
      pollOnly: isNetEaseHost(account.imap_host),
    };
    this.states.set(accountId, state);
    void this._connectLoop(accountId);
  }

  stopAccount(accountId: number, silent = false): void {
    const state = this.states.get(accountId);
    if (!state) return;
    this.states.delete(accountId);
    if (state.timer) clearTimeout(state.timer);
    if (state.syncTimer) clearInterval(state.syncTimer);
    if (state.sharedTimer) clearTimeout(state.sharedTimer);
    const client = state.client;
    state.client = null;
    if (client) {
      client.removeAllListeners();
      client.logout().catch(() => {});
    }
    // B11: 短命共享连接随账号一起关闭，不留闲置连接。
    const shared = state.sharedClient;
    state.sharedClient = null;
    if (shared) {
      shared.removeAllListeners();
      shared.logout().catch(() => {});
    }
    if (!silent) {
      getDb().prepare("UPDATE accounts SET status='offline' WHERE id=?").run(accountId);
    }
  }

  stopAll(): void {
    for (const id of [...this.states.keys()]) this.stopAccount(id);
  }

  setAccountStatus(accountId: number, status: string, error: string | null = null): void {
    getDb().prepare('UPDATE accounts SET status=?, error=? WHERE id=?').run(status, error, accountId);
  }

  // ---------- connection / IDLE ----------
  private async _connectLoop(accountId: number): Promise<void> {
    const state = this.states.get(accountId);
    if (!state) return; // stopped
    try {
      // R1: 网易系账号先起轮询定时器——之后无论首连成功与否，轮询
      // 都是同步的驱动力（首连失败时轮询每 5 分钟再试，不用等重连退避）。
      if (state.pollOnly) this._startPeriodicSync(accountId);
      const password = decryptSecret(state.account.password_enc, this.key);
      // R1: 网易系禁用 auto-IDLE（服务器约 206 秒静默断线，IDLE 无效）。
      const client = makeImapClient(accountToImap(state.account), password, { disableAutoIdle: state.pollOnly });
      state.client = client;
      client.on('exists', () => this._onExists(accountId));
      client.on('expunge', () => this._onExists(accountId));
      client.on('close', () => {
        // R1: 轮询账号没有要维持的长连接——close 不停轮询、不重连。
        if (state.pollOnly) return;
        this._stopPeriodicSync(accountId);
        // B2: 认证失败的账号不再重连（close 事件也会走到这里，同样拦截）。
        if (this.states.get(accountId) === state && !state.authFailed) {
          this.setAccountStatus(accountId, 'offline');
          this._scheduleReconnect(accountId);
        }
      });
      client.on('error', (err: Error) => logError(`imap account ${accountId} error:`, err?.message || err));
      await client.connect();
      // B9: connect() 成功后复核 state 是否还是当前这一个——stopAccount 后
      // 又 startAccount 会产生新 state，旧 _connectLoop 的 client 必须登出
      // 退出，不能继续往下跑（否则两个连接同时 IDLE/同步同一个账号）。
      if (this.states.get(accountId) !== state) {
        await client.logout().catch(() => {});
        return;
      }
      state.backoffMs = RECONNECT_BASE_MS;
      state.opFailures = 0;
      this.setAccountStatus(accountId, 'online');
      log(`imap connected: account ${accountId} (${state.account.email})`);
      // Initial: LIST folders + bookmark catch-up sync, then IDLE on INBOX.
      // 单个文件夹同步失败不拖垮整个账号（记日志、跳过、继续下一个文件夹），
      // 否则一个坏文件夹会让 _runOp 抛错、整个账号反复重连。
      await this._runOp(accountId, async (c) => {
        await this._syncFolders(c, accountId);
        for (const f of this._dbFolders(accountId)) {
          try {
            await this._syncFolder(c, accountId, f);
          } catch (e) {
            logError(`sync folder failed account ${accountId} folder ${f.path}:`, (e as Error)?.message || e);
          }
        }
      });
      await this._runOp(accountId, async (c) => { await this._openInbox(c, accountId); });
      // From here imapflow auto-IDLEs on INBOX (disableAutoIdle:false).
      // Plus a periodic INBOX re-sync as a fallback for servers whose
      // IDLE never fires (notably QQ Mail): without it, new mail can sit
      // on the server unsynced until the next reconnect.
      if (state.pollOnly) {
        // R1: 网易系不保持长连接——首连同步完就登出，之后只靠轮询
        // （短命连接）同步。不断开的话服务器约 206 秒后静默断线，
        // state.client 成半死连接，还会触发无意义的重连。
        try { await client.logout(); } catch { /* ignore */ }
        state.client = null;
      } else {
        this._startPeriodicSync(accountId);
      }
      getDb().prepare("UPDATE accounts SET last_sync_at=datetime('now') WHERE id=?").run(accountId);
    } catch (e) {
      if (!state.pollOnly) this._stopPeriodicSync(accountId);
      const msg = String((e as Error)?.message || e);
      // B2: 认证失败（密码/授权码错）不再无限重连：置 authFailed、写明原因、
      // 停在 error 状态，等用户在邮箱设置里重测/改密码/重新启用后
      // startAccount 建新 state 才恢复。其他错误走现有退避重连。
      if (isAuthError(e)) {
        state.authFailed = true;
        const authMsg = '认证失败，请检查密码/授权码（邮箱设置里重新测试或保存后恢复）';
        logError(`imap auth failed account ${accountId}:`, msg);
        this.setAccountStatus(accountId, 'error', authMsg);
        emit('sync', { accountId, state: 'error', error: authMsg });
        try { await state.client?.logout().catch(() => {}); } catch { /* ignore */ }
        state.client = null;
        return;
      }
      logError(`imap connect failed account ${accountId}:`, msg);
      this.setAccountStatus(accountId, 'error', msg.slice(0, 500));
      emit('sync', { accountId, state: 'error', error: msg.slice(0, 500) });
      try { await state.client?.logout().catch(() => {}); } catch { /* ignore */ }
      state.client = null;
      this._scheduleReconnect(accountId);
    }
  }

  private _scheduleReconnect(accountId: number): void {
    const state = this.states.get(accountId);
    if (!state || state.timer || state.authFailed) return;
    // B3(b): 退避加抖动 ±25%，避免多账号同一时刻一起重连（惊群）。
    const delay = Math.round(state.backoffMs * (0.75 + Math.random() * 0.5));
    state.backoffMs = Math.min(state.backoffMs * 2, RECONNECT_MAX_MS);
    log(`imap account ${accountId}: reconnect in ${Math.round(delay / 1000)}s`);
    state.timer = setTimeout(() => {
      state.timer = null;
      void this._connectLoop(accountId);
    }, delay);
  }

  private _startPeriodicSync(accountId: number): void {
    const state = this.states.get(accountId);
    if (!state || state.syncTimer) return;
    // B3(d): 定时间隔随机化为 4.5–5.5 分钟（PERIODIC_SYNC_MS ±10%），
    // 避免多账号的定时同步永远在同一秒齐发。
    const interval = Math.round(PERIODIC_SYNC_MS * (0.9 + Math.random() * 0.2));
    state.syncTimer = setInterval(() => {
      // R1: 轮询账号同步全部文件夹（短命连接）；其他账号仍是
      // INBOX 增量同步（与 IDLE `exists` 同款），只作 IDLE 不触发的兜底。
      if (state.pollOnly) {
        void this._pollAllFolders(accountId);
        return;
      }
      // Same incremental INBOX sync as the IDLE `exists` path; _onExists
      // no-ops safely when the connection is down (its _runOp rejects and
      // the error is logged), so a stale timer cannot corrupt anything.
      this._onExists(accountId);
    }, interval);
  }

  // R1: 网易系轮询——每 5 分钟用短命连接同步全部文件夹（LIST + 逐文件夹
  // 增量同步）。每次只登一次：24 个 163 账号每小时共约 288 次登录，
  // 且间隔带抖动；比 IDLE 静默断线后的约 400 次/小时/账号少一个量级。
  // 单个文件夹同步失败不拖垮整轮（记日志、跳过、继续下一个文件夹）。
  private async _pollAllFolders(accountId: number): Promise<void> {
    const state = this.states.get(accountId);
    if (!state) return;
    try {
      await this.withClient(accountId, async (c) => {
        await this._syncFolders(c, accountId);
        for (const f of this._dbFolders(accountId)) {
          try {
            await this._syncFolder(c, accountId, f);
          } catch (e) {
            logError(`poll sync folder failed account ${accountId} folder ${f.path}:`, (e as Error)?.message || e);
          }
        }
      });
      getDb().prepare("UPDATE accounts SET status='online', last_sync_at=datetime('now'), error=NULL WHERE id=?").run(accountId);
    } catch (e) {
      logError(`poll sync failed account ${accountId}:`, (e as Error)?.message || e);
    }
  }

  private _stopPeriodicSync(accountId: number): void {
    const state = this.states.get(accountId);
    if (state?.syncTimer) {
      clearInterval(state.syncTimer);
      state.syncTimer = null;
    }
  }

  private _onExists(accountId: number): void {
    // New mail arrived in INBOX (IDLE event) — incremental sync of INBOX only.
    // B7: 合并——已有同步排队/进行中（syncPending）时直接跳过，不再把同一个
    // INBOX 同步重复排进队列（IDLE 风暴/多 exists 事件时尤为明显）。
    const state = this.states.get(accountId);
    if (!state || state.syncPending) return;
    state.syncPending = true;
    this._runOp(accountId, async (c) => {
      const inbox = getDb().prepare(
        "SELECT * FROM folders WHERE account_id=? AND type='inbox' LIMIT 1",
      ).get(accountId) as FolderRow | undefined;
      if (inbox) {
        await this._syncFolder(c, accountId, inbox);
        await this._openInbox(c, accountId);
      }
    }).catch((e: unknown) => logError(`inbox sync on exists failed account ${accountId}:`, (e as Error)?.message || e))
      .finally(() => { state.syncPending = false; });
  }

  private async _openInbox(client: ImapFlow, accountId: number): Promise<void> {
    const inbox = getDb().prepare(
      "SELECT * FROM folders WHERE account_id=? AND type='inbox' LIMIT 1",
    ).get(accountId) as FolderRow | undefined;
    if (!inbox) return;
    if (client.mailbox && client.mailbox.path !== inbox.path) {
      await client.mailboxOpen(inbox.path);
    }
  }

  // Serialize all IMAP operations per account (one connection).
  private _runOp<T>(accountId: number, fn: (client: ImapFlow) => Promise<T>): Promise<T> {
    const state = this.states.get(accountId);
    if (!state) return Promise.reject(new Error('account not running'));
    const run = state.queue.then(async () => {
      if (!state.client || !state.client.usable) {
        throw new Error('IMAP 未连接（正在重连）');
      }
      try {
        const out = await fn(state.client);
        state.opFailures = 0;
        return out;
      } catch (e) {
        // B10: 同一账号连续 _runOp 失败 2 次，且连接表面上仍 usable（半死
        // 连接：不断线、但操作一直失败），主动登出一次，靠 close 事件走
        // 正常退避重连。连接已不可用时不动——重连流程已经在跑了。
        state.opFailures += 1;
        if (state.opFailures >= 2 && state.client?.usable) {
          state.opFailures = 0;
          log(`imap account ${accountId}: 2 consecutive op failures on a usable connection, forcing reconnect`);
          state.client.logout().catch(() => {});
        }
        throw e;
      }
    }) as Promise<T>;
    // Keep the chain alive after a failure so later ops still run.
    state.queue = run.catch(() => {});
    return run;
  }

  // Short-lived shared connection for on-demand ops (B11): while the account
  // has no live IDLE connection, queued withClient calls share ONE
  // short-lived connection instead of each opening its own. The connection
  // is kept for a short idle window (SHARED_IDLE_MS) so back-to-back queued
  // calls reuse it; the last call's idle timer logs out.
  // Accounts with no running state (disabled / never started) keep the old
  // one-off connection path — there is no queue to share through.
  private async _withSharedClient<T>(accountId: number, fn: (client: ImapFlow) => Promise<T>): Promise<T> {
    const state = this.states.get(accountId);
    if (!state) throw new Error('account not running');
    const run = state.queue.then(async () => {
      // The live connection may have come back while we were queued.
      if (state.client?.usable) return fn(state.client);
      if (state.sharedTimer) {
        clearTimeout(state.sharedTimer);
        state.sharedTimer = null;
      }
      if (!state.sharedClient || !state.sharedClient.usable) {
        const db = getDb();
        const account = db.prepare('SELECT * FROM accounts WHERE id=?').get(accountId) as AccountRow | undefined;
        if (!account) throw new Error('账号不存在');
        const password = decryptSecret(account.password_enc, this.key);
        const client = makeImapClient(accountToImap(account), password, { disableAutoIdle: true });
        await client.connect();
        state.sharedClient = client;
      }
      try {
        return await fn(state.sharedClient);
      } finally {
        // Idle window: a call queued right behind us cancels this timer on
        // entry and reuses the connection; otherwise we log out.
        if (state.sharedTimer) clearTimeout(state.sharedTimer);
        state.sharedTimer = setTimeout(() => {
          state.sharedTimer = null;
          const c = state.sharedClient;
          state.sharedClient = null;
          if (c) c.logout().catch(() => {});
        }, SHARED_IDLE_MS);
      }
    }) as Promise<T>;
    // Keep the chain alive after a failure so later ops still run.
    state.queue = run.catch(() => {});
    return run;
  }

  // Run an IMAP op, connecting a short-lived client if the account has no
  // live connection (used by on-demand actions: open/read/move/delete/send).
  // B11: 有长连接走 _runOp；无长连接时经 state.queue 串行、共用一个短命
  // 共享连接（_withSharedClient），不再每个调用各建各的连接、各登一次。
  async withClient<T>(accountId: number, fn: (client: ImapFlow) => Promise<T>): Promise<T> {
    const state = this.states.get(accountId);
    if (state?.client?.usable) return this._runOp(accountId, fn);
    if (state) return this._withSharedClient(accountId, fn);
    const db = getDb();
    const account = db.prepare('SELECT * FROM accounts WHERE id=?').get(accountId) as AccountRow | undefined;
    if (!account) throw new Error('账号不存在');
    const password = decryptSecret(account.password_enc, this.key);
    const client = makeImapClient(accountToImap(account), password, { disableAutoIdle: true });
    try {
      await client.connect();
      return await fn(client);
    } finally {
      try { await client.logout(); } catch { /* ignore */ }
    }
  }

  // ---------- manual refresh ----------
  // quiet=true 时不发 sync 事件（供 refreshAll 聚合用，见 refreshAll）。
  async refreshAccount(accountId: number, opts: { quiet?: boolean } = {}): Promise<void> {
    const state = this.states.get(accountId);
    if (!state) {
      // Account is disabled or not started: start it (it will sync on connect).
      this.startAccount(accountId);
      return;
    }
    // B2: 认证失败停住的账号，用户点手动刷新 = 明确要求再试一次：重建
    // state 走 _connectLoop（成功则恢复，仍认证失败则继续停住不重连）。
    if (state.authFailed) {
      this.startAccount(accountId);
      return;
    }
    const emitSync = (payload: Record<string, unknown>): void => { if (!opts.quiet) emit('sync', payload); };
    emitSync({ accountId, state: 'started' });
    try {
      // B23: 手动刷新复用已缓存的文件夹清单——LIST 只在连接建立时做，
      // 或上次 LIST 已超过 1 小时（文件夹删除的发现降级为定期）。
      // R1: 走 withClient 而不是 _runOp——轮询账号没有长连接，
      // _runOp 会直接报“IMAP 未连接”，手动刷新永远失败。
      const needList = !state.lastFolderListAt || Date.now() - state.lastFolderListAt > 60 * 60 * 1000;
      await this.withClient(accountId, async (c) => {
        if (needList) await this._syncFolders(c, accountId);
        for (const f of this._dbFolders(accountId)) {
          try {
            await this._syncFolder(c, accountId, f);
          } catch (e) {
            logError(`sync folder failed account ${accountId} folder ${f.path}:`, (e as Error)?.message || e);
          }
        }
        await this._openInbox(c, accountId);
      });
      getDb().prepare("UPDATE accounts SET status='online', last_sync_at=datetime('now'), error=NULL WHERE id=?").run(accountId);
      emitSync({ accountId, state: 'done' });
    } catch (e) {
      const msg = String((e as Error)?.message || e);
      this.setAccountStatus(accountId, 'error', msg.slice(0, 500));
      emitSync({ accountId, state: 'error', error: msg.slice(0, 500) });
      throw e;
    }
  }

  async refreshAll(): Promise<void> {
    const db = getDb();
    const ids = (db.prepare('SELECT id FROM accounts WHERE enabled=1').all() as { id: number }[]).map((r) => r.id);
    if (!ids.length) {
      emit('sync', { accountId: null, state: 'done' });
      return;
    }
    // 全部账号完成后只发一次聚合 sync done：以前每个账号各发一次 done，
    // 前端收到一次就 loadMessages 一次，28 个账号就是 28 次重载。
    // 单个账号的失败仍写进 accounts.status，聚合 done 触发的 loadAccounts
    // 会把它显示出来。
    // B3(c): 限并发——每批 5 个账号，Promise.allSettled 分批跑，不再 27 个
    // 账号同时全量同步（惊群 + 服务器并发上限）。
    for (let i = 0; i < ids.length; i += 5) {
      await Promise.allSettled(ids.slice(i, i + 5).map((id) => this.refreshAccount(id, { quiet: true })));
    }
    emit('sync', { accountId: null, state: 'done' });
  }

  // ---------- folders ----------
  private _dbFolders(accountId: number): FolderRow[] {
    return getDb().prepare('SELECT * FROM folders WHERE account_id=? ORDER BY path').all(accountId) as FolderRow[];
  }

  private async _syncFolders(client: ImapFlow, accountId: number): Promise<void> {
    const db = getDb();
    const list = await client.list() as unknown as ListEntry[];
    const flat: ListEntry[] = [];
    const walk = (entries: ListEntry[] | undefined): void => {
      for (const e of entries || []) {
        flat.push(e);
        if (e.children) walk(e.children);
      }
    };
    walk(list);
    const seen = new Set<string>();
    for (const entry of flat) {
      // F2: 跳过不可选文件夹（\Noselect / \NonExistent，如 QQ 的
      // “其他文件夹”父级命名空间）——它不能存邮件，建了 folder 行还会
      // 参与同步。只跳过这一项本身，不跳过它的子文件夹（flat 里子文件
      // 夹是独立项）；不进 seen，已有 folder 行由下面的清理删掉。
      if (isNonSelectable(entry)) continue;
      const rawName = displayNameOf(entry);
      const type = detectFolderType(entry.specialUse || [], rawName, entry.path);
      // IMAP 操作走 path，不受显示名影响；收件箱在服务器上的名字仍是 INBOX。
      const name = FOLDER_DISPLAY_NAMES[type] || rawName;
      seen.add(entry.path);
      const existing = db.prepare('SELECT id FROM folders WHERE account_id=? AND path=?').get(accountId, entry.path) as { id: number } | undefined;
      if (existing) {
        db.prepare('UPDATE folders SET name=?, type=? WHERE id=?').run(name, type, existing.id);
      } else {
        db.prepare('INSERT INTO folders (account_id, path, name, type) VALUES (?,?,?,?)')
          .run(accountId, entry.path, name, type);
      }
    }
    // Folders deleted on the server disappear locally (with their cache).
    const local = db.prepare('SELECT id, path FROM folders WHERE account_id=?').all(accountId) as { id: number; path: string }[];
    for (const f of local) {
      if (!seen.has(f.path)) {
        // R2: 删文件夹时一并删正文文件——只删 DB 行不删文件时，
        // 已删邮件的全文仍以明文躺在磁盘上。
        const ids = db.prepare('SELECT id FROM messages WHERE folder_id=?').all(f.id) as { id: number }[];
        removeMessagesFtsByFolder(f.id);
        db.prepare('DELETE FROM messages WHERE folder_id=?').run(f.id);
        for (const m of ids) removeBodyFiles(m.id);
        this.skippedDupeUids.delete(f.id);
        db.prepare('DELETE FROM folders WHERE id=?').run(f.id);
      }
    }
    // B23: 记下本次 LIST 的时间，供 refreshAccount 判断是否可复用缓存清单。
    const st = this.states.get(accountId);
    if (st) st.lastFolderListAt = Date.now();
  }

  // ---------- incremental sync ----------
  private async _syncFolder(client: ImapFlow, accountId: number, folder: FolderRow): Promise<void> {
    const db = getDb();
    const mailbox = await client.mailboxOpen(folder.path, { readOnly: true });
    // F2 防御：mailboxOpen 后核对实际选中的邮箱——QQ 的“其他文件夹”等
    // \Noselect 父级命名空间上它不报错、实际仍停留在上一个文件夹，
    // 之后 FETCH 读到的就是错邮箱的信（化石行的根因）。client.mailbox
    // 是已选中的邮箱对象时才核对（假客户端可能不设该属性，跳过）；
    // 路径不等就抛错，让逐文件夹 catch 记下 'sync folder failed'，
    // 绝不再写错文件夹。注意：若本次是首个文件夹、之前没选过任何
    // 邮箱，client.mailbox 为 false 时跳过核对——随后的 FETCH 会报
    // No mailbox selected，同样走失败分支，不会写错文件夹。
    const openedMailbox = client.mailbox;
    if (openedMailbox && typeof openedMailbox === 'object' && openedMailbox.path !== folder.path) {
      throw new Error(`mailbox open mismatch: requested ${folder.path}, got ${openedMailbox.path}`);
    }
    const stored = db.prepare('SELECT * FROM sync_state WHERE folder_id=?').get(folder.id) as
      { uidvalidity: number | null; uidnext: number | null; modseq: number | null } | undefined;
    // uidValidity 取不到时为 NaN（163/QQ 从不返回），入库时用 uidValidityDb
    // （NaN 存 NULL）。B1：NaN 绝不能触发全量重取（见下面的条件）。
    const uidValidityRaw = mailbox.uidValidity;
    const uidValidity = typeof uidValidityRaw === 'number' && Number.isFinite(uidValidityRaw) ? uidValidityRaw : NaN;
    const uidValidityDb = Number.isFinite(uidValidity) ? uidValidity : null;
    // 163 不返回 UIDNEXT（mailbox.uidNext 为 undefined），Number(undefined)=NaN，
    // NaN 与任何数比较都为 false，增量同步的“uidNext > stored.uidnext”恒不成立，
    // 新邮件永远取不回来。uidNext 不可用时改用“服务器 UID 与本地 UID 比对”找新邮件。
    const uidNextRaw = mailbox.uidNext;
    const uidNext = typeof uidNextRaw === 'number' && Number.isFinite(uidNextRaw) ? uidNextRaw : NaN;
    const uidNextDb = Number.isFinite(uidNext) ? uidNext : null;
    const highestModseq = mailbox.highestModseq ? Number(mailbox.highestModseq) : null;

    // B1: UIDVALIDITY 只有真实可用且变化时才全量重取。163/QQ 从不返回
    // UIDVALIDITY（mailbox.uidValidity 为 undefined → 这里是 NaN），旧条件
    // `stored.uidvalidity !== uidValidity` 在 NaN 下恒成立，每次 _syncFolder
    // 都删光整个文件夹再重插、本地 id 全翻新（单封删除两次 404 的根因）。
    // stored 为 null（首同步）仍走全量；服务器某天开始返回真实值、且与
    // 库里不同时，也走全量（值变了说明服务器端 UID 已重置，必须重取）。
    if (!stored || (Number.isFinite(uidValidity) && stored.uidvalidity !== uidValidity)) {
      // UIDVALIDITY changed (or first sync): full re-fetch of envelopes.
      // 先 fetch 再替换（事务内删旧插新）：fetch 失败时本地旧数据还在，
      // 不会留一个空文件夹；重插时不发 new-mail（不是新信，重发会让前端
      // 重复显示、未读角标膨胀）。
      const all = await this._fetchEnvelopes(client, '1:*');
      // D5: 全量重取会删光重插，本地已读状态会被服务器 flags 覆盖——
      // 先记下本地已读的 UID，重插后恢复（本地已读优先，与增量路径一致）。
      const readUids = new Set(
        (db.prepare('SELECT uid FROM messages WHERE folder_id=? AND is_read=1').all(folder.id) as { uid: number }[])
          .map((r) => r.uid),
      );
      // R2: 重插前记下旧行 id，事务成功后删掉它们的正文文件。
      const staleIds = db.prepare('SELECT id FROM messages WHERE folder_id=?').all(folder.id) as { id: number }[];
      const tx = db.transaction(() => {
        removeMessagesFtsByFolder(folder.id);
        db.prepare('DELETE FROM messages WHERE folder_id=?').run(folder.id);
        for (const m of all) {
          try {
            this._upsertEnvelope(accountId, folder, m, true, false);
          } catch (e) {
            logError(`upsert envelope failed account ${accountId} folder ${folder.path} uid ${m.uid}:`, (e as Error)?.message || e);
          }
        }
      });
      tx();
      for (const m of staleIds) removeBodyFiles(m.id);
      // R3: 全量重取后去重记录失效（行已重建），清空。
      this.skippedDupeUids.delete(folder.id);
      if (readUids.size) {
        const placeholders = [...readUids].map(() => '?').join(',');
        db.prepare(`UPDATE messages SET is_read=1 WHERE folder_id=? AND uid IN (${placeholders})`)
          .run(folder.id, ...[...readUids]);
      }
      db.prepare(`INSERT INTO sync_state (folder_id, uidvalidity, uidnext, modseq, last_sync_at)
                  VALUES (?,?,?,?,datetime('now'))
                  ON CONFLICT(folder_id) DO UPDATE SET uidvalidity=excluded.uidvalidity,
                  uidnext=excluded.uidnext, modseq=excluded.modseq, last_sync_at=excluded.last_sync_at`)
        .run(folder.id, uidValidityDb, uidNextDb, highestModseq);
    } else {
      // 新邮件：不依赖 UIDNEXT，取服务器全部 UID 与本地比对，差集即新邮件。
      const serverUids = new Set<number>();
      try {
        const uids = await client.search({ all: true }, { uid: true });
        if (Array.isArray(uids)) for (const u of uids) serverUids.add(Number(u));
      } catch (e) {
        // UID search 失败：记日志、跳过本轮对账（serverUids 为空时下面的
        // 删除对账有守卫，不会误删）。
        logError(`uid search failed account ${accountId} folder ${folder.path}:`, (e as Error)?.message || e);
      }
      const localRows = db.prepare('SELECT id, uid FROM messages WHERE folder_id=?').all(folder.id) as { id: number; uid: number }[];
      const localUids = new Set(localRows.map((r) => r.uid));
      // R3: 去重时被跳过的服务器副本 UID 不再参与“新邮件”判定，
      // 否则每轮同步都重新 FETCH 它一次（只记内存，全量重取时清空）。
      const skipped = this.skippedDupeUids.get(folder.id);
      const newUids = [...serverUids].filter((u) => !localUids.has(u) && !(skipped && skipped.has(u)));
      if (newUids.length) {
        // 从最小的新 UID 取到末尾（中间已知的会被 upsert 覆盖，无害）。
        // range 是 UID，必须传 {uid:true}，否则当序号取、超范围返回空。
        // B8: 大数组不用 Math.min(...newUids) 展开（参数栈溢出风险），改循环取最小值。
        let minNewUid = newUids[0];
        for (const u of newUids) if (u < minNewUid) minNewUid = u;
        const fresh = await this._fetchEnvelopes(client, `${minNewUid}:*`, {}, { uid: true });
        for (const m of fresh) {
          try {
            this._upsertEnvelope(accountId, folder, m, true);
          } catch (e) {
            logError(`upsert envelope failed account ${accountId} folder ${folder.path} uid ${m.uid}:`, (e as Error)?.message || e);
          }
        }
      }
      // Flag changes since last MODSEQ (CONDSTORE).
      if (highestModseq && stored.modseq && highestModseq > stored.modseq) {
        const changed = await this._fetchEnvelopes(client, '1:*', { changedSince: BigInt(stored.modseq) });
        for (const m of changed) {
          try {
            this._upsertEnvelope(accountId, folder, m, false);
          } catch (e) {
            logError(`upsert envelope failed account ${accountId} folder ${folder.path} uid ${m.uid}:`, (e as Error)?.message || e);
          }
        }
      } else if (!highestModseq) {
        // 163/QQ 不支持 CONDSTORE（mailbox.highestModseq 恒为 null，生产库
        // 174 个文件夹的 modseq 全是 NULL）：MODSEQ 路径永远走不到，别处
        // 客户端改的已读状态同步不回来。降级为定期全量比对 flags。
        // B6(b): 不再只做收件箱——全部文件夹都跑（每文件夹 5 分钟节流，
        // 见 _syncFlagsFull），否则非收件箱的已读状态永远同步不回来。
        await this._syncFlagsFull(client, accountId, folder);
      }
      // Deletions: compare server UID set with local UIDs.
      if (serverUids.size || mailbox.exists === 0) {
        for (const row of localRows) {
          if (!serverUids.has(row.uid)) {
            removeMessageFts(row.id);
            db.prepare('DELETE FROM messages WHERE id=?').run(row.id);
            // R2: 对账删行时同样删正文文件（与 deleteMessage 同款）。
            removeBodyFiles(row.id);
            emit('mail-deleted', { messageId: row.id });
          }
        }
      }
      db.prepare('UPDATE sync_state SET uidnext=?, modseq=?, last_sync_at=datetime(\'now\') WHERE folder_id=?')
        .run(uidNextDb, highestModseq, folder.id);
    }
    refreshFolderCounts(folder.id);
    db.prepare('UPDATE folders SET uidvalidity=?, uidnext=?, modseq=? WHERE id=?')
      .run(uidValidityDb, uidNextDb, highestModseq, folder.id);
  }

  // Full flag comparison (CONDSTORE fallback for servers without MODSEQ,
  // i.e. 163/QQ): fetch FLAGS for every message in the folder and apply the
  // server read state, so flag changes made in another client sync back.
  // Runs for ALL folders (B6b), throttled to once per FLAG_SYNC_INTERVAL_MS
  // per folder.
  // Local rows whose read state changed very recently are skipped: 163 flag
  // read-back can lag behind a local mark-read, and overwriting them would
  // flip a just-read message back to unread (guard lives in the UPDATE's
  // `updated_at < datetime('now', '-5 minutes')` condition).
  private async _syncFlagsFull(client: ImapFlow, accountId: number, folder: FolderRow): Promise<void> {
    const now = Date.now();
    const last = this.lastFullFlagSync.get(folder.id) || 0;
    if (now - last < FLAG_SYNC_INTERVAL_MS) return;
    this.lastFullFlagSync.set(folder.id, now);
    const db = getDb();
    const serverRead = new Map<number, boolean>();
    for await (const msg of client.fetch('1:*', { flags: true, uid: true }, { uid: true })) {
      serverRead.set(Number(msg.uid), [...(msg.flags || [])].includes('\\Seen'));
    }
    if (!serverRead.size) return;
    const localRows = db.prepare('SELECT id, uid, is_read FROM messages WHERE folder_id=?').all(folder.id) as { id: number; uid: number; is_read: number }[];
    let changed = 0;
    for (const r of localRows) {
      const srv = serverRead.get(r.uid);
      if (srv === undefined) continue; // gone from server; deletion reconciliation handles it
      const srvRead = srv ? 1 : 0;
      if (srvRead === r.is_read) continue;
      const info = db.prepare(`UPDATE messages SET is_read=?, updated_at=datetime('now')
                                WHERE id=? AND updated_at < datetime('now', '-5 minutes')`)
        .run(srvRead, r.id);
      if (info.changes) {
        changed++;
        emit('mail-updated', { messageId: r.id, accountId, folderId: folder.id, changes: { isRead: !!srvRead } });
      }
    }
    if (changed) refreshFolderCounts(folder.id);
  }

  // Find all UIDs in a folder whose Message-ID matches (server-independent).
  // F3: QQ 的 SEARCH HEADER "Message-ID" 返回 []（不支持按头搜索），
  // 所以反查不依赖服务器端搜索：取文件夹的 UID 清单，在 JS 侧 FETCH
  // envelope 比对 messageId。默认取最近 100 个 UID（刚 APPEND / 刚
  // MOVE 的信一定是目标文件夹里最新的）；删副本清扫时可传 centerUid，
  // 取该 UID 前后各 100 个 UID 的窗口（自动保存的副本与原件 UID 相邻）。
  private async _findUidsByMessageId(
    client: ImapFlow, folderPath: string, messageId: string,
    opts: { centerUid?: number; window?: number } = {},
  ): Promise<number[]> {
    await client.mailboxOpen(folderPath, { readOnly: true });
    const window = opts.window ?? 100;
    let allUids: number[];
    try {
      const all = await client.search({ all: true }, { uid: true });
      if (!Array.isArray(all) || !all.length) return [];
      allUids = all.map((u) => Number(u)).filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
    } catch (e) {
      logError(`uid search for Message-ID lookup failed folder ${folderPath}:`, (e as Error)?.message || e);
      return [];
    }
    let candidates: number[];
    const centerUid = opts.centerUid;
    if (centerUid != null) {
      candidates = allUids.filter((u) => u >= centerUid - window && u <= centerUid + window);
    } else {
      candidates = allUids.slice(-window);
    }
    if (!candidates.length) return [];
    // B8 同款：大数组不用 Math.min(...)/Math.max(...) 展开，改循环。
    let min = candidates[0];
    let max = candidates[0];
    for (const u of candidates) { if (u < min) min = u; if (u > max) max = u; }
    const hits: number[] = [];
    // range 是 UID，必须第 3 参数传 {uid:true}，否则当序号取。
    for await (const msg of client.fetch(`${min}:${max}`, { envelope: true, uid: true }, { uid: true })) {
      if (msg.envelope?.messageId === messageId && typeof msg.uid === 'number') hits.push(Number(msg.uid));
    }
    return hits.sort((a, b) => a - b);
  }

  // Find a message's UID in a folder by its Message-ID header (fallback
  // when the server does not return a UID map for a move/append).
  // B4: 同一 Message-ID 有多个命中时取最大 UID——刚移入/刚 APPEND 的是
  // 最新那封，取最小会指到旧的（可能已被删的）副本上。
  private async _findUidByMessageId(client: ImapFlow, folderPath: string, messageId: string): Promise<number | null> {
    const hits = await this._findUidsByMessageId(client, folderPath, messageId);
    if (!hits.length) return null;
    return hits[hits.length - 1];
  }

  // F1 附带：删掉同文件夹内同一 Message-ID 的其他服务器副本。
  // 163/QQ 发信后会自动再往已发送存一份（与客户端 APPEND 的那份同一
  // Message-ID、不同 UID）；原件移走/删掉后另一份还留在原文件夹，
  // 墓碑又挡着它不再显示、界面里永远删不掉。只删 keepUid 之外的命中；
  // keepUid 为 null 时全部命中都删（彻底删除时清扫已发送文件夹用）。
  // 失败只记日志、不让本次删除失败（主删除已成功）。
  private async _deleteOtherCopiesInFolder(accountId: number, folder: FolderRow, messageId: string, keepUid: number | null): Promise<void> {
    try {
      const others = await this.withClient(accountId, async (client) => {
        return this._findUidsByMessageId(
          client, folder.path, messageId,
          keepUid != null ? { centerUid: keepUid } : {},
        );
      });
      const targets = keepUid != null ? others.filter((u) => u !== keepUid) : others;
      if (!targets.length) return;
      await this.withClient(accountId, async (client) => {
        await client.mailboxOpen(folder.path);
        for (const u of targets) {
          try {
            await client.messageFlagsAdd(String(u), ['\\Deleted'], { uid: true });
            await client.messageDelete(String(u), { uid: true });
          } catch (e) {
            logError(`delete duplicate copy failed account ${accountId} folder ${folder.path} uid ${u}:`, (e as Error)?.message || e);
          }
        }
      });
      log(`deleted ${targets.length} duplicate server ${targets.length > 1 ? 'copies' : 'copy'} of Message-ID ${messageId} in folder ${folder.path}`);
    } catch (e) {
      logError(`delete duplicate copies failed account ${accountId} folder ${folder.path}:`, (e as Error)?.message || e);
    }
  }

  private async _fetchEnvelopes(
    client: ImapFlow,
    range: string,
    extra: { changedSince?: bigint } = {},
    options: { uid?: boolean } = {},
  ): Promise<FetchMessageObject[]> {
    const out: FetchMessageObject[] = [];
    const opts = {
      envelope: true, flags: true, bodyStructure: true, size: true,
      uid: true, internalDate: true,
      bodyParts: [{ key: 'TEXT', start: 0, maxLength: SNIPPET_BYTES }],
      ...extra,
    };
    // 注意：opts 里的 uid:true 只是“让服务器回传 UID”，不改变 range 语义；
    // range 是 UID 时必须第 3 参数传 {uid:true}，否则 imapflow 当序号取，
    // 十亿量级的 UID 超范围就返回空。
    for await (const msg of client.fetch(range, opts, options)) out.push(msg);
    return out;
  }

  private _upsertEnvelope(accountId: number, folder: FolderRow, msg: FetchMessageObject, isNewCandidate: boolean, emitNewMail = true): number {
    const db = getDb();
    const env = msg.envelope || {};
    const from = env.from?.[0] || {};
    const to = (env.to || []).map((a) => a.address).filter(Boolean) as string[];
    const flags = [...(msg.flags || [])];
    const isRead = flags.includes('\\Seen');
    let snippet = '';
    const textPart = msg.bodyParts?.get?.('TEXT');
    if (textPart) {
      // B21: 只按 BODYSTRUCTURE 里 TEXT 部分真实的 Content-Transfer-Encoding
      // 解码（base64 / quoted-printable），不再凭“看起来像 base64”瞎猜。
      snippet = decodeSnippet(textPart, textPartEncoding(msg.bodyStructure));
    }
    const existing = db.prepare(
      'SELECT id, is_read, snippet, flags_json FROM messages WHERE account_id=? AND folder_id=? AND uid=?',
    ).get(accountId, folder.id, msg.uid) as { id: number; is_read: number; snippet: string; flags_json: string } | undefined;
    if (existing) {
      // 已读状态以本地为准：isNewCandidate=true 是“新 UID 范围取回”（可能含已存邮件），
      // 此时不要用服务器 flags 覆盖本地 is_read，否则用户刚标的已读一刷新就变回未读
      // （163 的 flags 回读可能滞后）。只有 MODSEQ 标记变化（isNewCandidate=false）时
      // 才用服务器 flags 更新已读状态。
      const readChanged = !isNewCandidate && existing.is_read !== (isRead ? 1 : 0);
      // B6(a): 写放大——只有内容真正变化（snippet/flags/is_read）时才写库，
      // 否则每次同步都把全文件夹的 updated_at 刷一遍（_syncFlagsFull 的
      // “5 分钟内本地改过”保护也被无意义地续期）。
      const snippetChanged = !!snippet && snippet !== (existing.snippet || '');
      const flagsChanged = JSON.stringify(flags) !== (existing.flags_json || '[]');
      if (!readChanged && !snippetChanged && !flagsChanged) return existing.id;
      if (readChanged) {
        // R7: MODSEQ 分支的已读更新也加 5 分钟守卫，与 _syncFlagsFull 一致——
        // 本地刚改过的已读状态（updated_at 很新）不能被服务器滞后的 flags
        // 翻回去。守卫挡住时只更新 snippet/flags（不碰 updated_at，不续期窗口）。
        const info = db.prepare(
          `UPDATE messages SET is_read=?, snippet=?, flags_json=?,
           updated_at=datetime('now') WHERE id=? AND updated_at < datetime('now', '-5 minutes')`,
        ).run(isRead ? 1 : 0,
          snippetChanged ? snippet : (existing.snippet || ''),
          JSON.stringify(flags), existing.id);
        if (info.changes) {
          // 带上 accountId/folderId：前端收到时若该邮件不在当前列表里，
          // 仍能凭事件里的账号/文件夹把未读角标减掉，避免角标滞后。
          emit('mail-updated', { messageId: existing.id, accountId, folderId: folder.id, changes: { isRead } });
          return existing.id;
        }
        if (snippetChanged || flagsChanged) {
          db.prepare('UPDATE messages SET snippet=?, flags_json=? WHERE id=?')
            .run(snippetChanged ? snippet : (existing.snippet || ''), JSON.stringify(flags), existing.id);
        }
        return existing.id;
      }
      db.prepare(`UPDATE messages SET is_read=?, snippet=?, flags_json=?,
                  updated_at=datetime('now') WHERE id=?`)
        .run(existing.is_read,
          snippetChanged ? snippet : (existing.snippet || ''),
          JSON.stringify(flags), existing.id);
      return existing.id;
    }
    // 防复活：删掉的信不要再被同步加回来。
    // (1) Message-ID 在彻底删除墓碑里 -> 跳过（服务器上还留着也不加回来）。
    // (2) 同一 Message-ID 已在已删除文件夹里、而现在是往非已删除文件夹同步
    //     -> 跳过（这是刚移入已删除的信，服务器上还留在原文件夹时同步会把它
    //     当新信插回原文件夹）。Message-ID 是邮件头全局唯一标识。
    const mid = env.messageId || null;
    if (mid) {
      const tomb = db.prepare('SELECT 1 FROM deleted_messages WHERE account_id=? AND message_id=?')
        .get(accountId, mid) as { '1': number } | undefined;
      if (tomb) return 0;
      if (folder.type !== 'trash') {
        const inTrash = db.prepare(
          `SELECT 1 FROM messages m JOIN folders f ON m.folder_id=f.id
           WHERE m.account_id=? AND m.message_id=? AND f.type='trash' LIMIT 1`,
        ).get(accountId, mid) as { '1': number } | undefined;
        if (inTrash) return 0;
      }
      // F1: 同一文件夹内按 Message-ID 去重——163/QQ 发信后会自动再往
      // 已发送存一份（与客户端 APPEND 的那份同一 Message-ID、不同
      // UID），同步只按 (account, folder, uid) 去重会把服务器那份当
      // 新邮件插成第二行。同一 Message-ID 在同一文件夹里已有行时跳
      // 过插入、返回已有行的 id（该行就是这封信的本地记录，UID 不同
      // 只是服务器上的另一个副本）。Message-ID 是邮件头全局唯一标识。
      const dup = db.prepare(
        'SELECT id FROM messages WHERE account_id=? AND folder_id=? AND message_id=? LIMIT 1',
      ).get(accountId, folder.id, mid) as { id: number } | undefined;
      if (dup) {
        // R3: 记下被跳过的服务器副本 UID——下次同步直接跳过，不再重复
        // FETCH 它（否则该 UID 永远在 serverUids - localUids 里）。
        let skipped = this.skippedDupeUids.get(folder.id);
        if (!skipped) {
          skipped = new Set<number>();
          this.skippedDupeUids.set(folder.id, skipped);
        }
        skipped.add(msg.uid);
        return dup.id;
      }
    }
    const info = db.prepare(
      `INSERT INTO messages (account_id, folder_id, uid, message_id, subject, from_addr,
        from_name, to_json, date, snippet, is_read, has_attachments, size, flags_json)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      accountId, folder.id, msg.uid,
      env.messageId || null,
      env.subject || '',
      from.address || '',
      from.name || '',
      JSON.stringify(to),
      toIsoDate(env.date) ?? toIsoDate(msg.internalDate),
      snippet,
      isRead ? 1 : 0,
      hasAttachments(msg.bodyStructure) ? 1 : 0,
      msg.size || 0,
      JSON.stringify(flags),
    );
    const newId = Number(info.lastInsertRowid);
    // 新信封一到就建 FTS 行（主题+发件人），不等正文拉取，否则没拉过正文的信永远搜不到。
    indexMessageEnvelope(newId, env.subject || '', from.address || '');
    if (isNewCandidate && emitNewMail && folder.type === 'inbox') {
      const row = db.prepare('SELECT * FROM messages WHERE id=?').get(newId) as MessageRow;
      const account = db.prepare('SELECT email FROM accounts WHERE id=?').get(accountId) as { email: string } | undefined;
      emit('new-mail', {
        accountId, folderId: folder.id,
        message: envelopeOf(row, account?.email || ''),
      });
    }
    return newId;
  }

  // ---------- on-demand full fetch (open a message) ----------
  // Concurrent opens of the same message share one in-flight fetch: without
  // this, two callers both see body_path=NULL, both fetch+parse, and both
  // INSERT the same attachment rows (duplicates).
  async fetchFullMessage(accountId: number, messageId: number): Promise<MessageRow> {
    const pending = this.fullFetchInflight.get(messageId);
    if (pending) return pending;
    const p = this._fetchFullMessage(accountId, messageId);
    this.fullFetchInflight.set(messageId, p);
    try {
      return await p;
    } finally {
      if (this.fullFetchInflight.get(messageId) === p) this.fullFetchInflight.delete(messageId);
    }
  }

  private async _fetchFullMessage(accountId: number, messageId: number): Promise<MessageRow> {
    const db = getDb();
    const row = db.prepare('SELECT * FROM messages WHERE id=?').get(messageId) as MessageRow | undefined;
    if (!row) throw new Error('邮件不存在');
    if (row.body_path) return row;
    const folder = db.prepare('SELECT * FROM folders WHERE id=?').get(row.folder_id) as FolderRow | undefined;
    if (!folder) throw new Error('文件夹不存在');
    // Streaming download (contract: 纯流式处理 — never buffer the whole
    // message in memory). The stream is consumed INSIDE withClient, while
    // the IMAP connection is still alive; for very large messages we only
    // spool the stream to a temp file here and parse it in a worker thread
    // afterwards, so the connection is released promptly.
    const outcome = await this.withClient(accountId, async (client) => {
      await client.mailboxOpen(folder.path, { readOnly: true });
      // BODYSTRUCTURE first: attachment part numbers + sizes, so >10 MB
      // attachments can later be streamed live from IMAP by part number.
      let bodyStructure: FetchMessageObject['bodyStructure'] | null = null;
      // range 是 UID，必须第 3 参数传 {uid:true}，否则当序号取、静默返回空，
      // 附件 part 号就记不上，>10MB 附件实时取回会报“未记录 IMAP 位置”。
      for await (const msg of client.fetch(String(row.uid), { bodyStructure: true, uid: true }, { uid: true })) {
        bodyStructure = msg.bodyStructure;
      }
      const partList = collectAttachmentParts(bodyStructure);
      const dl = await client.download(String(row.uid), '', { uid: true });
      if (!dl?.content) throw new Error('服务器上找不到这封邮件（可能已被删除）');
      const sizeHint = dl.meta?.expectedSize || row.size || 0;
      if (sizeHint > LARGE_PARSE_THRESHOLD) {
        const tmp = await spoolToTemp(dl.content, row.id);
        return { tmpFile: tmp, sizeHint, partList, parsed: null as null };
      }
      return { parsed: await streamToParsed(dl.content, sizeHint), partList, tmpFile: null as null, sizeHint };
    });
    let parsed;
    if (outcome.tmpFile) {
      try {
        parsed = await parseInWorker(outcome.tmpFile, outcome.sizeHint);
      } finally {
        fs.rm(outcome.tmpFile, { force: true }, () => {});
      }
    } else {
      parsed = outcome.parsed;
    }
    if (!parsed) throw new Error('邮件解析失败');
    // Attach IMAP part numbers to the parsed attachments (metadata-only:
    // downloads stream live from IMAP by part number, never from disk).
    parsed.attachments = matchAttachmentParts(parsed.attachments, outcome.partList || []);
    // Bodies on disk (contract): sanitized HTML + plain text; SQLite keeps
    // only the path. FTS indexes the searchable text.
    // R6: 先跑 DB 事务、成功后再写正文文件——旧版先写文件后跑事务，
    // 事务失败时正文文件成孤儿。文件写失败时把 body_path 指回 NULL
    // 并删掉已写一半的文件，下次打开重取（附件行先清后插，事务幂等）。
    const bodyPath = `bodies/${row.id}.html`;
    const tx = db.transaction(() => {
      db.prepare('DELETE FROM attachments WHERE message_id=?').run(row.id);
      db.prepare(`UPDATE messages SET body_path=?, snippet=?, subject=?,
                  has_attachments=?, updated_at=datetime('now') WHERE id=?`)
        .run(bodyPath, parsed.snippet, parsed.envelope.subject || row.subject,
          parsed.hasAttachments ? 1 : 0, row.id);
      for (const a of parsed.attachments) {
        db.prepare('INSERT INTO attachments (message_id, filename, content_type, size, path, cached, part) VALUES (?,?,?,?,?,?,?)')
          .run(row.id, a.filename, a.contentType, a.size, a.path, a.cached ? 1 : 0, a.part || null);
      }
      indexMessageFts(row.id, parsed.envelope.subject || row.subject, parsed.envelope.fromAddr, parsed.bodyText);
    });
    tx();
    try {
      fs.writeFileSync(bodyHtmlPath(row.id), parsed.bodyHtml);
      fs.writeFileSync(bodyTextPath(row.id), parsed.bodyText);
    } catch (e) {
      fs.rmSync(bodyHtmlPath(row.id), { force: true });
      fs.rmSync(bodyTextPath(row.id), { force: true });
      db.prepare('UPDATE messages SET body_path=NULL WHERE id=?').run(row.id);
      throw e;
    }
    return db.prepare('SELECT * FROM messages WHERE id=?').get(messageId) as MessageRow;
  }

  // ---------- flag / move / delete ops (via IMAP, then local) ----------
  async setRead(accountId: number, messageId: number, read: boolean): Promise<MessageRow> {
    const db = getDb();
    const row = db.prepare('SELECT * FROM messages WHERE id=?').get(messageId) as MessageRow | undefined;
    if (!row) throw new Error('邮件不存在');
    const folder = db.prepare('SELECT * FROM folders WHERE id=?').get(row.folder_id) as FolderRow | undefined;
    if (!folder) throw new Error('文件夹不存在');
    if (row.is_read === (read ? 1 : 0)) return row;
    await this.withClient(accountId, async (client) => {
      await client.mailboxOpen(folder.path);
      // 必须传 {uid:true}：row.uid 是十亿量级的 UID，imapflow 默认当序号，
      // 不传就是空操作，服务器端已读永远标不上。
      if (read) await client.messageFlagsAdd(String(row.uid), ['\\Seen'], { uid: true });
      else await client.messageFlagsRemove(String(row.uid), ['\\Seen'], { uid: true });
    });
    db.prepare('UPDATE messages SET is_read=?, updated_at=datetime(\'now\') WHERE id=?').run(read ? 1 : 0, messageId);
    if (row.folder_id) refreshFolderCounts(row.folder_id);
    emit('mail-updated', { messageId, accountId: row.account_id, folderId: row.folder_id, changes: { isRead: read } });
    return db.prepare('SELECT * FROM messages WHERE id=?').get(messageId) as MessageRow;
  }

  async moveMessage(accountId: number, messageId: number, targetFolderId: number): Promise<MessageRow> {
    const db = getDb();
    const row = db.prepare('SELECT * FROM messages WHERE id=?').get(messageId) as MessageRow | undefined;
    if (!row) throw new Error('邮件不存在');
    const target = db.prepare('SELECT * FROM folders WHERE id=? AND account_id=?').get(targetFolderId, accountId) as FolderRow | undefined;
    if (!target) throw new Error('目标文件夹不存在');
    const source = db.prepare('SELECT * FROM folders WHERE id=?').get(row.folder_id) as FolderRow | undefined;
    if (!source) throw new Error('源文件夹不存在');
    // messageMove returns a UID map only when the server supports UIDPLUS.
    // Without it, fall back to looking the moved message up in the target
    // folder by Message-ID; if that fails too, throw and leave the local
    // row untouched — writing the old UID would point at the wrong message
    // in the target folder (later deletes/reads would silently hit nothing
    // or the wrong mail, and the server copy would never sync back).
    const newUid = await this.withClient(accountId, async (client) => {
      await client.mailboxOpen(source.path);
      // 必须传 {uid:true}：row.uid 是 UID，默认当序号就是空操作，信就移不过去。
      const result = await client.messageMove(String(row.uid), target.path, { uid: true });
      try {
        const map = result ? result.uidMap : undefined;
        const mapped = map?.get(row.uid);
        if (typeof mapped === 'number' && Number.isFinite(mapped)) return mapped;
      } catch { /* fall through to Message-ID lookup */ }
      if (!row.message_id) return null;
      return this._findUidByMessageId(client, target.path, row.message_id);
    });
    if (newUid == null) {
      throw new Error('移动后无法确认新位置（目标文件夹里找不到这封邮件），本地未更新');
    }
    db.prepare('UPDATE messages SET folder_id=?, uid=?, updated_at=datetime(\'now\') WHERE id=?')
      .run(target.id, newUid, messageId);
    refreshFolderCounts(source.id);
    refreshFolderCounts(target.id);
    // 带上 accountId：前端收到跨文件夹移信事件时能凭账号/文件夹
    // 更新未读角标（只带 folderId 时聚合视图的角标算不对，见审计#2 L3）。
    emit('mail-updated', { messageId, accountId, folderId: target.id, changes: { folderId: target.id } });
    return db.prepare('SELECT * FROM messages WHERE id=?').get(messageId) as MessageRow;
  }

  async deleteMessage(accountId: number, messageId: number): Promise<boolean> {
    const db = getDb();
    const row = db.prepare('SELECT * FROM messages WHERE id=?').get(messageId) as MessageRow | undefined;
    if (!row) throw new Error('邮件不存在');
    const folder = db.prepare('SELECT * FROM folders WHERE id=?').get(row.folder_id) as FolderRow | undefined;
    if (!folder) throw new Error('文件夹不存在');
    // 是否永久删除只看邮件实际所在文件夹：只有已在已删除文件夹里的信才
    // 彻底删除。客户端传的 permanent 不再采信——搜索是全局的，按视图判断
    // 会把非垃圾邮件永久删掉；反过来，已在垃圾邮件里的信也必须永久删，
    // 不能只看客户端说 permanent=false。
    if (folder.type !== 'trash') {
      const trash = db.prepare("SELECT * FROM folders WHERE account_id=? AND type='trash' LIMIT 1").get(accountId) as FolderRow | undefined;
      if (!trash) throw new Error('账号没有已删除文件夹，无法删除这封邮件（请检查垃圾邮件文件夹是否已同步）');
      await this.moveMessage(accountId, messageId, trash.id);
      // F1 附带：从已发送删信时，把同文件夹内同一 Message-ID 的其他
      // 服务器副本一并删掉（163/QQ 自动保存的那份），否则原件移走后
      // 另一份还留在已发送、墓碑又挡着它不再显示、界面里永远删不掉。
      if (folder.type === 'sent' && row.message_id) {
        await this._deleteOtherCopiesInFolder(accountId, folder, row.message_id, row.uid);
      }
      return true;
    }
    await this.withClient(accountId, async (client) => {
      await client.mailboxOpen(folder.path);
      // 必须传 {uid:true}：row.uid 是 UID，默认当序号就是空操作，信删不掉。
      await client.messageFlagsAdd(String(row.uid), ['\\Deleted'], { uid: true });
      await client.messageDelete(String(row.uid), { uid: true });
    });
    // F1 附带：彻底删除时同样清掉同文件夹内同一 Message-ID 的其他
    // 服务器副本（两份副本先后被移进已删除的情形）。
    if (row.message_id) {
      await this._deleteOtherCopiesInFolder(accountId, folder, row.message_id, row.uid);
      // L3: 彻底删除时也清扫同账号已发送文件夹里的同 Message-ID 副本
      // （第一次清扫失败、或副本在已发送里时，墓碑会挡着它永不显示、
      // 界面里永远删不掉，只占服务器空间）。
      const sentFolder = db.prepare("SELECT * FROM folders WHERE account_id=? AND type='sent' LIMIT 1").get(accountId) as FolderRow | undefined;
      if (sentFolder && sentFolder.id !== folder.id) {
        await this._deleteOtherCopiesInFolder(accountId, sentFolder, row.message_id, null);
      }
    }
    const folderId = row.folder_id;
    // 墓碑：记下彻底删除邮件的 Message-ID，同步时跳过它，删掉的信不再复活。
    // message_id 是邮件头的 Message-ID（全局唯一），不是本地行 id。
    if (row.message_id) {
      db.prepare('INSERT OR IGNORE INTO deleted_messages (account_id, message_id) VALUES (?,?)')
        .run(accountId, row.message_id);
    }
    removeMessageFts(messageId);
    db.prepare('DELETE FROM messages WHERE id=?').run(messageId);
    // Remove cached body files.
    fs.rm(bodyHtmlPath(messageId), { force: true }, () => {});
    fs.rm(bodyTextPath(messageId), { force: true }, () => {});
    if (folderId) refreshFolderCounts(folderId);
    emit('mail-deleted', { messageId });
    return true;
  }

  // Stream one attachment live from IMAP to `writable` (attachments are
  // metadata-only — this is the ONLY way down, nothing is written to disk).
  // `att.part` is the BODYSTRUCTURE part number recorded at parse time.
  // The IMAP connection stays open until the pipe finishes.
  async streamAttachment(
    accountId: number,
    messageId: number,
    att: AttachmentRow,
    writable: NodeJS.WritableStream,
  ): Promise<void> {
    const db = getDb();
    const row = db.prepare('SELECT * FROM messages WHERE id=?').get(messageId) as MessageRow | undefined;
    if (!row) throw new Error('邮件不存在');
    if (!att.part) throw new Error('该附件未记录 IMAP 位置，无法实时取回');
    const folder = db.prepare('SELECT * FROM folders WHERE id=?').get(row.folder_id) as FolderRow | undefined;
    if (!folder) throw new Error('文件夹不存在');
    await this.withClient(accountId, async (client) => {
      await client.mailboxOpen(folder.path, { readOnly: true });
      const dl = await client.download(String(row.uid), att.part as string, { uid: true });
      if (!dl?.content) throw new Error('服务器上找不到该附件');
      await pipeline(dl.content, writable);
    });
  }

  // APPEND a copy to Sent and return { ...sentFolder, uid, ok, parts }.
  // ok=false: the APPEND itself failed (mail was sent but no copy stored).
  // uid=null with ok=true: APPEND succeeded but the server returned no UID
  // AND the follow-up Message-ID lookup also failed — the copy IS in Sent,
  // it just cannot be cached locally yet (next sync picks it up).
  // When no UID comes back and we know the Message-ID, look the message up
  // in the Sent folder by Message-ID right away, in the same IMAP session.
  // B11: parts（刚 APPEND 那封信的 BODYSTRUCTURE 附件 part 号）也在同一
  // 次会话里取，调用方不再另开一次 withClient 调 getAttachmentParts。
  // Audit #5b：按 Message-ID 在已发送文件夹里找一封信（崩溃窗口
  // 重认领时用）：先由调用方查本地 messages 表，本地没有再调这里查
  // 服务器。复用 F3 的 _findUidByMessageId（FETCH 最近信封再 JS 比
  // 对），不依赖服务器端 SEARCH HEADER（QQ 返回 []）。
  // 查不到或 IMAP 不通时返回 null（调用方按“未发过”继续发送）；
  // 失败只记日志、不抛错，不让一次重认领检查拖垮发信请求。
  async findSentByMessageId(accountId: number, messageId: string): Promise<{ folderId: number; uid: number } | null> {
    const db = getDb();
    const sent = db.prepare("SELECT * FROM folders WHERE account_id=? AND type='sent' LIMIT 1").get(accountId) as FolderRow | undefined;
    if (!sent) return null;
    try {
      const uid = await this.withClient(accountId, (client) => this._findUidByMessageId(client, sent.path, messageId));
      return uid != null ? { folderId: sent.id, uid } : null;
    } catch (e) {
      logError(`find sent by Message-ID failed account ${accountId}:`, (e as Error)?.message || e);
      return null;
    }
  }

  async appendToSent(accountId: number, raw: Buffer, messageId?: string | null): Promise<(FolderRow & { uid: number | null; ok: boolean; parts: AttachmentPart[] }) | null> {
    const db = getDb();
    const sent = db.prepare("SELECT * FROM folders WHERE account_id=? AND type='sent' LIMIT 1").get(accountId) as FolderRow | undefined;
    if (!sent) return null;
    try {
      let uid: number | null = null;
      let parts: AttachmentPart[] = [];
      await this.withClient(accountId, async (client) => {
        const res = await client.append(sent.path, raw, ['\\Seen']);
        if (res && typeof res.uid === 'number') uid = res.uid;
        if (uid == null && messageId) {
          try {
            uid = await this._findUidByMessageId(client, sent.path, messageId);
          } catch (e) {
            logError(`find uid by Message-ID after append failed account ${accountId}:`, (e as Error)?.message || e);
          }
        }
        if (uid != null) {
          try {
            await client.mailboxOpen(sent.path, { readOnly: true });
            for await (const msg of client.fetch(String(uid), { bodyStructure: true, uid: true }, { uid: true })) {
              parts = collectAttachmentParts(msg.bodyStructure);
            }
          } catch (e) {
            logError(`collect sent attachment parts failed account ${accountId} uid ${uid}:`, (e as Error)?.message || e);
            parts = [];
          }
        }
      });
      return { ...sent, uid, ok: true, parts };
    } catch (e) {
      logError(`append to sent failed account ${accountId}:`, (e as Error)?.message || e);
      return { ...sent, uid: null, ok: false, parts: [] }; // sending already succeeded; don't fail the request
    }
  }

}

function hasAttachments(bodyStructure: FetchMessageObject['bodyStructure']): boolean {
  if (!bodyStructure) return false;
  const walk = (part: typeof bodyStructure): boolean => {
    if (!part) return false;
    if (part.disposition === 'attachment') return true;
    if (part.childNodes) return part.childNodes.some(walk);
    return false;
  };
  return walk(bodyStructure);
}

function decodeSnippet(buf: Buffer, encoding?: string | null): string {
  try {
    const text = Buffer.isBuffer(buf) ? buf.toString('utf8') : String(buf);
    const enc = (encoding || '').toLowerCase();
    let decoded = text;
    // B21: 只对明确声明的编码解码——base64 只在 Content-Transfer-Encoding:
    // base64 时解；quoted-printable 补解码；其他（7bit/8bit/未声明）直接当
    // 明文用。旧的“看起来像 base64 就解”启发式会把正常纯文本误解成乱码。
    if (enc === 'base64') {
      const compact = text.replace(/\s+/g, '');
      if (/^[A-Za-z0-9+/=]+$/.test(compact) && compact.length > 0) {
        const d = Buffer.from(compact, 'base64').toString('utf8');
        if (d && !d.includes('\uFFFD')) decoded = d;
      }
    } else if (enc === 'quoted-printable') {
      decoded = decodeQuotedPrintable(text);
    }
    return decoded.replace(/\s+/g, ' ').trim().slice(0, 200);
  } catch {
    return '';
  }
}

function decodeQuotedPrintable(text: string): string {
  // 软换行（行尾 =）先去掉，再把 =XX 还原成字节、按 UTF-8 解。
  const noSoftBreaks = text.replace(/=\r?\n/g, '');
  const bytes = Buffer.from(
    noSoftBreaks.replace(/=([0-9A-Fa-f]{2})/g, (_m, hex: string) => String.fromCharCode(parseInt(hex, 16))),
    'latin1',
  );
  const out = bytes.toString('utf8');
  return out.includes('\uFFFD') ? text : out;
}

// 从 BODYSTRUCTURE 里找 TEXT 部分的 Content-Transfer-Encoding（B21 用）。
// bodyStructure 是树：叶子节点的 type/subtype 如 text/plain，encoding 如
// base64 / quoted-printable。找不到返回 null（按明文处理）。
function textPartEncoding(bodyStructure: FetchMessageObject['bodyStructure']): string | null {
  const walk = (node: typeof bodyStructure): string | null => {
    if (!node) return null;
    if (node.childNodes) {
      for (const c of node.childNodes) {
        const found = walk(c);
        if (found) return found;
      }
      return null;
    }
    const type = String(node.type || '').toLowerCase();
    if (type === 'text/plain' || type.startsWith('text/')) return node.encoding || null;
    return null;
  };
  return walk(bodyStructure);
}
