// B12 发信幂等键（sent_idempotency 表）——防重复发信。
//
// 状态机（按 (account_id, idempotency_key) 唯一）：
//   占位   INSERT (message_db_id=NULL, message_id=NULL)  → “发送进行中”
//   成功   UPDATE 回填 message_db_id + message_id        → “已发过”
//   失败   DELETE 占位行                                 → 可再重试
//   重复   key 已存在且 message_id 非空 → 直接返回原结果，不再重发
//   并发   key 已存在且 message_id 为空 → 首发进行中，返回 409
//   过期   “发送进行中”的占位超过 10 分钟（F6）→ 删掉重认领
//
// Audit #5b：认领时预生成 Message-ID 存进 planned_message_id——
// 崩溃窗口（SMTP 成功后、回填前进程崩溃）重认领时，复用同一个 ID
// 查已发送文件夹（先本地 messages 表、再服务器已发送文件夹）；查到
// 已发出的直接返回原结果，不再重发。planned_message_id 只在认领时
// 写一次，重认领沿用旧行的值，永不重新生成。
import crypto from 'node:crypto';
import { getDb } from './db.js';
// Audit #8 LOW-7（死代码）：parseSqliteUtc 原来这里与 auth.ts 各有一份；
// 现在共用 auth.ts 的 parseSqliteUtcMs（正则守卫 + 解析不出返回 null），
// 这里只留引用。
import { parseSqliteUtcMs } from './auth.js';

// F6: “发送进行中”占位的最长存活时间——进程在发信中途崩溃/重启后，
// 占位行永远卡在“进行中”，同一 key 重试永远 409。超过此时长视为
// 过期，认领时删掉重建（已完成的记录永不过期，是去重依据）。
export const IDEMPOTENCY_PLACEHOLDER_TTL_MS = 10 * 60 * 1000;

export interface IdempotencyRow {
  account_id: number;
  idempotency_key: string;
  message_db_id: number | null;
  message_id: string | null;
  // Audit #5b：认领时预生成的 Message-ID（重认领时沿用，不重生成）。
  planned_message_id: string | null;
  created_at: string;
}

// 预生成本次发送的 Message-ID——认领时存进行，之后每次重试（包括
// 崩溃后重认领）都复用它，收件方/同步去重才能认出是同一封。
export function newPlannedMessageId(): string {
  return `<${crypto.randomUUID()}@luck-mail.local>`;
}

export function findSendKey(accountId: number, key: string): IdempotencyRow | undefined {
  return getDb().prepare(
    'SELECT * FROM sent_idempotency WHERE account_id=? AND idempotency_key=?',
  ).get(accountId, key) as IdempotencyRow | undefined;
}

export type ClaimResult =
  | { status: 'claimed'; reclaimed: boolean; plannedMessageId: string | null }
  | { status: 'duplicate'; row: IdempotencyRow }
  | { status: 'in-progress'; row: IdempotencyRow };

export function claimSendKey(accountId: number, key: string, plannedMessageId?: string | null): ClaimResult {
  const db = getDb();
  const planned = plannedMessageId || newPlannedMessageId();
  try {
    db.prepare(
      'INSERT INTO sent_idempotency (account_id, idempotency_key, message_db_id, message_id, planned_message_id) VALUES (?,?,NULL,NULL,?)',
    ).run(accountId, key, planned);
    return { status: 'claimed', reclaimed: false, plannedMessageId: planned };
  } catch (e) {
    // 唯一冲突：已有占位行。message_id 非空 = 已发过；为空 = 首发进行中。
    const msg = String((e as Error)?.message || e);
    if (!/UNIQUE constraint/i.test(msg)) throw e;
    const row = findSendKey(accountId, key);
    if (!row) return { status: 'claimed', reclaimed: false, plannedMessageId: planned }; // 占位行在查的瞬间被删了：当作可发
    if (row.message_id) return { status: 'duplicate', row };
    // F6: 占位过期——“发送进行中”超过 10 分钟（进程中途崩溃/重启后
    // 占位永远卡住），删掉重认领；否则同一 key 重试永远 409。
    // 限定 message_id IS NULL 删除，避免删掉并发下刚完成的记录。
    // Audit #5b：重认领沿用旧行的 planned_message_id（没有时用本次
    // 传入的），不重新生成——否则崩溃后重试以新 ID 再发一封。
    const createdMs = parseSqliteUtcMs(row.created_at);
    if (createdMs != null && Date.now() - createdMs > IDEMPOTENCY_PLACEHOLDER_TTL_MS) {
      const keptPlanned = row.planned_message_id || planned;
      db.prepare(
        'DELETE FROM sent_idempotency WHERE account_id=? AND idempotency_key=? AND message_id IS NULL',
      ).run(accountId, key);
      try {
        db.prepare(
          'INSERT INTO sent_idempotency (account_id, idempotency_key, message_db_id, message_id, planned_message_id) VALUES (?,?,NULL,NULL,?)',
        ).run(accountId, key, keptPlanned);
        return { status: 'claimed', reclaimed: true, plannedMessageId: keptPlanned };
      } catch {
        // 并发下另一方先认领了：重读，按最新状态返回。
        const row2 = findSendKey(accountId, key);
        if (!row2) return { status: 'claimed', reclaimed: false, plannedMessageId: keptPlanned };
        return row2.message_id ? { status: 'duplicate', row: row2 } : { status: 'in-progress', row: row2 };
      }
    }
    return { status: 'in-progress', row };
  }
}

export function completeSendKey(accountId: number, key: string, messageDbId: number | null, messageId: string | null): void {
  getDb().prepare(
    'UPDATE sent_idempotency SET message_db_id=?, message_id=? WHERE account_id=? AND idempotency_key=?',
  ).run(messageDbId, messageId, accountId, key);
}

// 只删“进行中”的占位行（message_id 为空）；已完成的记录保留，供重复
// key 直接返回原结果。
export function releaseSendKey(accountId: number, key: string): void {
  getDb().prepare(
    'DELETE FROM sent_idempotency WHERE account_id=? AND idempotency_key=? AND message_id IS NULL',
  ).run(accountId, key);
}
