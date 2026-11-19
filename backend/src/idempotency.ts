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
  // Audit #14 LOW-1：row 可为 null——占位行在 INSERT 冲突后两次都
  // 读不到（并发删除的微秒级窗口）时 fail closed 返回 in-progress，
  // 调用方按 409 拒绝，不再谎报 claimed 让本次发送失去幂等保护。
  | { status: 'in-progress'; row: IdempotencyRow | null };

export function claimSendKey(
  accountId: number,
  key: string,
  plannedMessageId?: string | null,
  // 仅测试用：覆盖默认的行查找 findSendKey——并发删除造成的“INSERT
  // 冲突后读不到行”是微秒级窗口，单线程/双线程模拟都测不到（双 worker
  // 紧循环抢同一 WAL 写锁时，单条语句的 busy 等待把测试拖到分钟级）。
  // 注入一个恒返回 undefined 的查找，即可确定性地覆盖该分支；
  // 生产调用不传本参数，行为与直接调 findSendKey 完全一致。
  findRow: (accountId: number, key: string) => IdempotencyRow | undefined = findSendKey,
): ClaimResult {
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
    const row = findRow(accountId, key);
    if (!row) {
      // Audit #11 L3：占位行在查的瞬间被删了（另一路失败释放）——旧版
      // 直接返回 claimed，但库里并没有占位行，调用方照常发信、
      // completeSendKey 的 UPDATE 命中 0 行，这次发送等于没有任何
      // 幂等保护。改为重试一次 INSERT：成功则认领；仍冲突则按最新
      // 行返回 duplicate/in-progress。
      try {
        db.prepare(
          'INSERT INTO sent_idempotency (account_id, idempotency_key, message_db_id, message_id, planned_message_id) VALUES (?,?,NULL,NULL,?)',
        ).run(accountId, key, planned);
        return { status: 'claimed', reclaimed: false, plannedMessageId: planned };
      } catch (e2) {
        if (!/UNIQUE constraint/i.test(String((e2 as Error)?.message || e2))) throw e2;
        const row2 = findRow(accountId, key);
        // Audit #14 LOW-1：重插又冲突、再读仍无行——占位行在两次读之间
        // 又被并发删除，库里根本没有占位行；旧版谎报 claimed，调用方
        // 照常发信且 completeSendKey 的 UPDATE 命中 0 行，本次发送等于
        // 没有任何幂等保护。改为 fail closed：返回 in-progress（调用方
        // 按 409 拒绝），并发下另一路在途是唯一合理解释。
        if (!row2) return { status: 'in-progress', row: null };
        if (row2.message_id) return { status: 'duplicate', row: row2 };
        return { status: 'in-progress', row: row2 };
      }
    }
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
      } catch (e3) {
        // Audit #15 L1：与上面 :100-107 的重试分支同款——非 UNIQUE
        // 错误重新抛出。旧版是裸 catch：重插失败不是 UNIQUE 冲突时
        // （例如 SQLITE_BUSY 超过 busy_timeout、磁盘满），错误被静默
        // 吞掉，调用方按重读结果返回 in-progress（409），持续的数据库
        // 问题被伪装成“发送进行中”且无任何日志。UNIQUE 冲突才说明
        // 并发下另一方先认领了，重读按最新状态返回。
        if (!/UNIQUE constraint/i.test(String((e3 as Error)?.message || e3))) throw e3;
        // 并发下另一方先认领了：重读，按最新状态返回。重读仍无行时与
        // 上面同款（Audit #14 LOW-1）：fail closed 返回 in-progress，
        // 不谎报 claimed。
        const row2 = findRow(accountId, key);
        if (!row2) return { status: 'in-progress', row: null };
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
