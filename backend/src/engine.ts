import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { ImapFlow, FetchMessageObject } from 'imapflow';
import {
  getDb, refreshFolderCounts, indexMessageFts, removeMessageFts,
  removeMessagesFtsByFolder, bodyHtmlPath, bodyTextPath,
} from './db.js';
import type { AccountRow, FolderRow, MessageRow, AttachmentRow } from './db.js';
import { decryptSecret } from './cryptoUtil.js';
import { makeImapClient, accountToImap, logError } from './imapUtil.js';
import {
  detectFolderType, displayNameOf, collectAttachmentParts, matchAttachmentParts,
} from './mailUtil.js';
import type { ListEntry, AttachmentPart } from './mailUtil.js';
import { streamToParsed } from './mailStream.js';
import { spoolToTemp, parseInWorker } from './streamParse.js';
import { emit } from './hub.js';
import { LARGE_PARSE_THRESHOLD, log } from './config.js';

const RECONNECT_BASE_MS = 5000;
const RECONNECT_MAX_MS = 5 * 60 * 1000;
// Fetch only the first bytes of the TEXT part for the list snippet; the full
// source is fetched (and parsed) only when a message is opened.
const SNIPPET_BYTES = 4096;

interface AccountState {
  account: AccountRow;
  client: ImapFlow | null;
  connected: boolean;
  backoffMs: number;
  timer: NodeJS.Timeout | null;
  queue: Promise<unknown>;
  idleInboxPath: string | null;
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

  constructor(masterKey: Buffer) {
    this.key = masterKey;
  }

  // ---------- lifecycle ----------
  startAll(): void {
    const db = getDb();
    const rows = db.prepare('SELECT * FROM accounts WHERE enabled=1').all() as AccountRow[];
    for (const row of rows) this.startAccount(row.id);
  }

  startAccount(accountId: number): void {
    const db = getDb();
    const account = db.prepare('SELECT * FROM accounts WHERE id=?').get(accountId) as AccountRow | undefined;
    if (!account || !account.enabled) return;
    this.stopAccount(accountId, true);
    const state: AccountState = {
      account,
      client: null,
      connected: false,
      backoffMs: RECONNECT_BASE_MS,
      timer: null,
      queue: Promise.resolve(),
      idleInboxPath: null,
    };
    this.states.set(accountId, state);
    void this._connectLoop(accountId);
  }

  stopAccount(accountId: number, silent = false): void {
    const state = this.states.get(accountId);
    if (!state) return;
    this.states.delete(accountId);
    if (state.timer) clearTimeout(state.timer);
    const client = state.client;
    state.client = null;
    state.connected = false;
    if (client) {
      client.removeAllListeners();
      client.logout().catch(() => {});
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
      const password = decryptSecret(state.account.password_enc, this.key);
      const client = makeImapClient(accountToImap(state.account), password, { disableAutoIdle: false });
      state.client = client;
      client.on('exists', () => this._onExists(accountId));
      client.on('expunge', () => this._onExists(accountId));
      client.on('close', () => {
        state.connected = false;
        if (this.states.get(accountId) === state) {
          this.setAccountStatus(accountId, 'offline');
          this._scheduleReconnect(accountId);
        }
      });
      client.on('error', (err: Error) => logError(`imap account ${accountId} error:`, err?.message || err));
      await client.connect();
      state.connected = true;
      state.backoffMs = RECONNECT_BASE_MS;
      this.setAccountStatus(accountId, 'online');
      log(`imap connected: account ${accountId} (${state.account.email})`);
      // Initial: LIST folders + bookmark catch-up sync, then IDLE on INBOX.
      await this._runOp(accountId, async (c) => {
        await this._syncFolders(c, accountId);
        for (const f of this._dbFolders(accountId)) {
          await this._syncFolder(c, accountId, f);
        }
      });
      await this._runOp(accountId, async (c) => { await this._openInbox(c, accountId); });
      // From here imapflow auto-IDLEs on INBOX (disableAutoIdle:false).
      getDb().prepare("UPDATE accounts SET last_sync_at=datetime('now') WHERE id=?").run(accountId);
    } catch (e) {
      state.connected = false;
      const msg = String((e as Error)?.message || e);
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
    if (!state || state.timer) return;
    const delay = state.backoffMs;
    state.backoffMs = Math.min(state.backoffMs * 2, RECONNECT_MAX_MS);
    log(`imap account ${accountId}: reconnect in ${Math.round(delay / 1000)}s`);
    state.timer = setTimeout(() => {
      state.timer = null;
      void this._connectLoop(accountId);
    }, delay);
  }

  private _onExists(accountId: number): void {
    // New mail arrived in INBOX (IDLE event) — incremental sync of INBOX only.
    const state = this.states.get(accountId);
    if (!state) return;
    this._runOp(accountId, async (c) => {
      const inbox = getDb().prepare(
        "SELECT * FROM folders WHERE account_id=? AND type='inbox' LIMIT 1",
      ).get(accountId) as FolderRow | undefined;
      if (inbox) {
        await this._syncFolder(c, accountId, inbox);
        await this._openInbox(c, accountId);
      }
    }).catch((e: unknown) => logError(`inbox sync on exists failed account ${accountId}:`, (e as Error)?.message || e));
  }

  private async _openInbox(client: ImapFlow, accountId: number): Promise<void> {
    const state = this.states.get(accountId);
    const inbox = getDb().prepare(
      "SELECT * FROM folders WHERE account_id=? AND type='inbox' LIMIT 1",
    ).get(accountId) as FolderRow | undefined;
    if (!inbox) return;
    if (state) state.idleInboxPath = inbox.path;
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
      return fn(state.client);
    }) as Promise<T>;
    // Keep the chain alive after a failure so later ops still run.
    state.queue = run.catch(() => {});
    return run;
  }

  // Run an IMAP op, connecting a short-lived client if the account has no
  // live connection (used by on-demand actions: open/read/move/delete/send).
  async withClient<T>(accountId: number, fn: (client: ImapFlow) => Promise<T>): Promise<T> {
    const state = this.states.get(accountId);
    if (state?.client?.usable) return this._runOp(accountId, fn);
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
  async refreshAccount(accountId: number): Promise<void> {
    const state = this.states.get(accountId);
    if (!state) {
      // Account is disabled or not started: start it (it will sync on connect).
      this.startAccount(accountId);
      return;
    }
    emit('sync', { accountId, state: 'started' });
    try {
      await this._runOp(accountId, async (c) => {
        await this._syncFolders(c, accountId);
        for (const f of this._dbFolders(accountId)) await this._syncFolder(c, accountId, f);
        await this._openInbox(c, accountId);
      });
      getDb().prepare("UPDATE accounts SET status='online', last_sync_at=datetime('now'), error=NULL WHERE id=?").run(accountId);
      emit('sync', { accountId, state: 'done' });
    } catch (e) {
      const msg = String((e as Error)?.message || e);
      this.setAccountStatus(accountId, 'error', msg.slice(0, 500));
      emit('sync', { accountId, state: 'error', error: msg.slice(0, 500) });
      throw e;
    }
  }

  async refreshAll(): Promise<void> {
    const db = getDb();
    const ids = (db.prepare('SELECT id FROM accounts WHERE enabled=1').all() as { id: number }[]).map((r) => r.id);
    if (!ids.length) emit('sync', { accountId: null, state: 'done' });
    await Promise.allSettled(ids.map((id) => this.refreshAccount(id)));
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
      const rawName = displayNameOf(entry);
      const type = detectFolderType(entry.specialUse || [], rawName, entry.path);
      // 标准文件夹前台统一显示中文名（QQ 等服务器返回英文名，163 返回中文名，
      // 映射后两边一致；服务器英文名只做分类依据，不直接显示）。
      // 自定义文件夹（type=other，如 QQ邮件订阅、个人邮件）保留服务器原名。
      // IMAP 操作走 path，不受显示名影响；收件箱在服务器上的名字仍是 INBOX。
      const FOLDER_DISPLAY_NAMES: Record<string, string> = {
        inbox: '收件夹',
        drafts: '草稿箱',
        sent: '已发送',
        trash: '已删除',
        spam: '垃圾邮件'
      };
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
        removeMessagesFtsByFolder(f.id);
        db.prepare('DELETE FROM messages WHERE folder_id=?').run(f.id);
        db.prepare('DELETE FROM folders WHERE id=?').run(f.id);
      }
    }
  }

  // ---------- incremental sync ----------
  private async _syncFolder(client: ImapFlow, accountId: number, folder: FolderRow): Promise<void> {
    const db = getDb();
    const mailbox = await client.mailboxOpen(folder.path, { readOnly: true });
    const stored = db.prepare('SELECT * FROM sync_state WHERE folder_id=?').get(folder.id) as
      { uidvalidity: number | null; uidnext: number | null; modseq: number | null } | undefined;
    const uidValidity = Number(mailbox.uidValidity);
    // 163 不返回 UIDNEXT（mailbox.uidNext 为 undefined），Number(undefined)=NaN，
    // NaN 与任何数比较都为 false，增量同步的“uidNext > stored.uidnext”恒不成立，
    // 新邮件永远取不回来。uidNext 不可用时改用“服务器 UID 与本地 UID 比对”找新邮件。
    const uidNextRaw = mailbox.uidNext;
    const uidNext = typeof uidNextRaw === 'number' && Number.isFinite(uidNextRaw) ? uidNextRaw : NaN;
    const uidNextDb = Number.isFinite(uidNext) ? uidNext : null;
    const highestModseq = mailbox.highestModseq ? Number(mailbox.highestModseq) : null;

    if (!stored || stored.uidvalidity !== uidValidity) {
      // UIDVALIDITY changed (or first sync): full re-fetch of envelopes.
      removeMessagesFtsByFolder(folder.id);
      db.prepare('DELETE FROM messages WHERE folder_id=?').run(folder.id);
      const all = await this._fetchEnvelopes(client, '1:*');
      for (const m of all) this._upsertEnvelope(accountId, folder, m, true);
      db.prepare(`INSERT INTO sync_state (folder_id, uidvalidity, uidnext, modseq, last_sync_at)
                  VALUES (?,?,?,?,datetime('now'))
                  ON CONFLICT(folder_id) DO UPDATE SET uidvalidity=excluded.uidvalidity,
                  uidnext=excluded.uidnext, modseq=excluded.modseq, last_sync_at=excluded.last_sync_at`)
        .run(folder.id, uidValidity, uidNextDb, highestModseq);
    } else {
      // 新邮件：不依赖 UIDNEXT，取服务器全部 UID 与本地比对，差集即新邮件。
      const serverUids = new Set<number>();
      try {
        const uids = await client.search({ all: true }, { uid: true });
        if (Array.isArray(uids)) for (const u of uids) serverUids.add(Number(u));
      } catch { /* search failure: skip this round */ }
      const localRows = db.prepare('SELECT id, uid FROM messages WHERE folder_id=?').all(folder.id) as { id: number; uid: number }[];
      const localUids = new Set(localRows.map((r) => r.uid));
      const newUids = [...serverUids].filter((u) => !localUids.has(u));
      if (newUids.length) {
        // 从最小的新 UID 取到末尾（中间已知的会被 upsert 覆盖，无害）。
        // range 是 UID，必须传 {uid:true}，否则当序号取、超范围返回空。
        const fresh = await this._fetchEnvelopes(client, `${Math.min(...newUids)}:*`, {}, { uid: true });
        for (const m of fresh) this._upsertEnvelope(accountId, folder, m, true);
      }
      // Flag changes since last MODSEQ.
      if (highestModseq && stored.modseq && highestModseq > stored.modseq) {
        const changed = await this._fetchEnvelopes(client, '1:*', { changedSince: BigInt(stored.modseq) });
        for (const m of changed) this._upsertEnvelope(accountId, folder, m, false);
      }
      // Deletions: compare server UID set with local UIDs.
      if (serverUids.size || mailbox.exists === 0) {
        for (const row of localRows) {
          if (!serverUids.has(row.uid)) {
            removeMessageFts(row.id);
            db.prepare('DELETE FROM messages WHERE id=?').run(row.id);
            emit('mail-deleted', { messageId: row.id });
          }
        }
      }
      db.prepare('UPDATE sync_state SET uidnext=?, modseq=?, last_sync_at=datetime(\'now\') WHERE folder_id=?')
        .run(uidNextDb, highestModseq, folder.id);
    }
    refreshFolderCounts(folder.id);
    db.prepare('UPDATE folders SET uidvalidity=?, uidnext=?, modseq=? WHERE id=?')
      .run(uidValidity, uidNextDb, highestModseq, folder.id);
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

  private _upsertEnvelope(accountId: number, folder: FolderRow, msg: FetchMessageObject, isNewCandidate: boolean): number {
    const db = getDb();
    const env = msg.envelope || {};
    const from = env.from?.[0] || {};
    const to = (env.to || []).map((a) => a.address).filter(Boolean) as string[];
    const flags = [...(msg.flags || [])];
    const isRead = flags.includes('\\Seen');
    let snippet = '';
    const textPart = msg.bodyParts?.get?.('TEXT');
    if (textPart) {
      // TEXT part is still transfer-encoded; decode best-effort for snippet.
      snippet = decodeSnippet(textPart);
    }
    const existing = db.prepare(
      'SELECT id, is_read FROM messages WHERE account_id=? AND folder_id=? AND uid=?',
    ).get(accountId, folder.id, msg.uid) as { id: number; is_read: number } | undefined;
    if (existing) {
      // 已读状态以本地为准：isNewCandidate=true 是“新 UID 范围取回”（可能含已存邮件），
      // 此时不要用服务器 flags 覆盖本地 is_read，否则用户刚标的已读一刷新就变回未读
      // （163 的 flags 回读可能滞后）。只有 MODSEQ 标记变化（isNewCandidate=false）时
      // 才用服务器 flags 更新已读状态。
      const readChanged = !isNewCandidate && existing.is_read !== (isRead ? 1 : 0);
      if (readChanged || snippet) {
        if (readChanged) {
          db.prepare(`UPDATE messages SET is_read=?, snippet=COALESCE(NULLIF(?,''), snippet),
                      flags_json=?, updated_at=datetime('now') WHERE id=?`)
            .run(isRead ? 1 : 0, snippet, JSON.stringify(flags), existing.id);
          // 带上 accountId/folderId：前端收到时若该邮件不在当前列表里，
          // 仍能凭事件里的账号/文件夹把未读角标减掉，避免角标滞后。
          emit('mail-updated', { messageId: existing.id, accountId, folderId: folder.id, changes: { isRead } });
        } else {
          db.prepare(`UPDATE messages SET snippet=COALESCE(NULLIF(?,''), snippet),
                      flags_json=?, updated_at=datetime('now') WHERE id=?`)
            .run(snippet, JSON.stringify(flags), existing.id);
        }
      }
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
      env.date ? new Date(env.date).toISOString() : (msg.internalDate ? new Date(msg.internalDate).toISOString() : null),
      snippet,
      isRead ? 1 : 0,
      hasAttachments(msg.bodyStructure) ? 1 : 0,
      msg.size || 0,
      JSON.stringify(flags),
    );
    const newId = Number(info.lastInsertRowid);
    if (isNewCandidate && folder.type === 'inbox') {
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
  async fetchFullMessage(accountId: number, messageId: number): Promise<MessageRow> {
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
      return { parsed: await streamToParsed(dl.content, row.id, sizeHint), partList, tmpFile: null as null, sizeHint };
    });
    let parsed;
    if (outcome.tmpFile) {
      try {
        parsed = await parseInWorker(outcome.tmpFile, row.id, outcome.sizeHint);
      } finally {
        fs.rm(outcome.tmpFile, { force: true }, () => {});
      }
    } else {
      parsed = outcome.parsed;
    }
    if (!parsed) throw new Error('邮件解析失败');
    // Attach IMAP part numbers to the parsed attachments (10 MB rule).
    parsed.attachments = matchAttachmentParts(parsed.attachments, outcome.partList || []);
    // Bodies on disk (contract): sanitized HTML + plain text; SQLite keeps
    // only the path. FTS indexes the searchable text.
    const bodyPath = `bodies/${row.id}.html`;
    fs.writeFileSync(bodyHtmlPath(row.id), parsed.bodyHtml);
    fs.writeFileSync(bodyTextPath(row.id), parsed.bodyText);
    const tx = db.transaction(() => {
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
    const result = await this.withClient(accountId, async (client) => {
      await client.mailboxOpen(source.path);
      // 必须传 {uid:true}：row.uid 是 UID，默认当序号就是空操作，信就移不过去。
      return client.messageMove(String(row.uid), target.path, { uid: true });
    });
    // messageMove returns a UID map when the server supports UIDPLUS.
    let newUid = row.uid;
    try {
      const map = result ? result.uidMap : undefined;
      if (map) newUid = map.get(row.uid) ?? row.uid;
    } catch { /* keep old uid; next sync reconciles */ }
    db.prepare('UPDATE messages SET folder_id=?, uid=?, updated_at=datetime(\'now\') WHERE id=?')
      .run(target.id, Number(newUid) || row.uid, messageId);
    refreshFolderCounts(source.id);
    refreshFolderCounts(target.id);
    emit('mail-updated', { messageId, changes: { folderId: target.id } });
    return db.prepare('SELECT * FROM messages WHERE id=?').get(messageId) as MessageRow;
  }

  async deleteMessage(accountId: number, messageId: number, permanent: boolean): Promise<boolean> {
    const db = getDb();
    const row = db.prepare('SELECT * FROM messages WHERE id=?').get(messageId) as MessageRow | undefined;
    if (!row) throw new Error('邮件不存在');
    const folder = db.prepare('SELECT * FROM folders WHERE id=?').get(row.folder_id) as FolderRow | undefined;
    if (!folder) throw new Error('文件夹不存在');
    const trash = db.prepare("SELECT * FROM folders WHERE account_id=? AND type='trash' LIMIT 1").get(accountId) as FolderRow | undefined;
    if (!permanent && folder.type !== 'trash' && trash) {
      await this.moveMessage(accountId, messageId, trash.id);
      return true;
    }
    await this.withClient(accountId, async (client) => {
      await client.mailboxOpen(folder.path);
      // 必须传 {uid:true}：row.uid 是 UID，默认当序号就是空操作，信删不掉。
      await client.messageFlagsAdd(String(row.uid), ['\\Deleted'], { uid: true });
      await client.messageDelete(String(row.uid), { uid: true });
    });
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

  // Stream one attachment live from IMAP to `writable` (10 MB rule: for
  // >10 MB attachments this is the ONLY way down — nothing is written to
  // disk). `att.part` is the BODYSTRUCTURE part number recorded at parse
  // time. The IMAP connection stays open until the pipe finishes.
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

  async appendToSent(accountId: number, raw: Buffer): Promise<(FolderRow & { uid: number | null }) | null> {
    const db = getDb();
    const sent = db.prepare("SELECT * FROM folders WHERE account_id=? AND type='sent' LIMIT 1").get(accountId) as FolderRow | undefined;
    if (!sent) return null;
    try {
      let uid: number | null = null;
      await this.withClient(accountId, async (client) => {
        const res = await client.append(sent.path, raw, ['\\Seen']);
        if (res && typeof res.uid === 'number') uid = res.uid;
      });
      return { ...sent, uid };
    } catch (e) {
      logError(`append to sent failed account ${accountId}:`, (e as Error)?.message || e);
      return { ...sent, uid: null }; // sending already succeeded; don't fail the request
    }
  }

  // 取某封信的附件 part 列表（按 BODYSTRUCTURE）：发信时本地只记已发附件的
  // 元信息、不落盘，下载要凭 part 号从 IMAP 实时取，所以 APPEND 进已发送后
  // 要来取一次 part 号。取不到返回空数组（调用方记 NULL，下载时再报错）。
  async getAttachmentParts(accountId: number, folderPath: string, uid: number): Promise<AttachmentPart[]> {
    let partList: AttachmentPart[] = [];
    try {
      await this.withClient(accountId, async (client) => {
        await client.mailboxOpen(folderPath, { readOnly: true });
        for await (const msg of client.fetch(String(uid), { bodyStructure: true, uid: true }, { uid: true })) {
          partList = collectAttachmentParts(msg.bodyStructure);
        }
      });
    } catch (e) {
      logError(`getAttachmentParts failed account ${accountId} uid ${uid}:`, (e as Error)?.message || e);
    }
    return partList;
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

function decodeSnippet(buf: Buffer): string {
  try {
    const text = Buffer.isBuffer(buf) ? buf.toString('utf8') : String(buf);
    // The TEXT part may be base64/quoted-printable; a cheap heuristic: if it
    // looks like base64, decode it. Full decoding happens in streamToParsed
    // when the message is opened; the snippet only needs to be readable.
    const compact = text.replace(/\s+/g, '');
    if (/^[A-Za-z0-9+/=]+$/.test(compact) && compact.length > 40) {
      const decoded = Buffer.from(compact, 'base64').toString('utf8');
      if (decoded && !decoded.includes('\uFFFD')) return decoded.replace(/\s+/g, ' ').trim().slice(0, 200);
    }
    return text.replace(/\s+/g, ' ').trim().slice(0, 200);
  } catch {
    return '';
  }
}
