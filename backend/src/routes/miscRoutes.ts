import express from 'express';
import type { Request, Response } from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getDb } from '../db.js';
import { ATTACHMENTS_DIR, BODIES_DIR, KEY_FILE, log } from '../config.js';
import { rateLimit } from '../rateLimit.js';

const execFileAsync = promisify(execFile);

// Audit #9 M3 同款：async 路由处理器包一层，抛错记日志、走统一 500
// JSON（Audit #10 L-19：/backup/download 原来是裸 async 路由，
// mkdtempSync 在 try 之外、抛错即未处理 rejection）。
function asyncHandler(fn: (req: Request, res: Response) => Promise<unknown>): (req: Request, res: Response) => void {
  return (req, res) => {
    fn(req, res).catch((e: unknown) => {
      log('misc route failed', req.method, req.path, (e as Error)?.message || e);
      if (!res.headersSent) res.status(500).json({ ok: false, error: '服务器内部错误' });
    });
  };
}

export function miscRoutes(): express.Router {
  const r = express.Router();

  const get = (k: string): string | null =>
    (getDb().prepare('SELECT value FROM settings WHERE key=?').get(k) as { value: string } | undefined)?.value ?? null;

  r.get('/settings', (_req: Request, res: Response) => {
    const defaultAccountId = get('defaultAccountId');
    // Audit #9 L19c：旧数据里若存了字面 'NaN'（见 PUT 校验），读回时按
    // null 处理，不把 NaN 透传给前端。
    const n = defaultAccountId ? Number(defaultAccountId) : NaN;
    res.json({
      ok: true,
      settings: {
        signature: get('signature') || '',
        defaultAccountId: Number.isInteger(n) ? n : null,
      },
    });
  });

  r.put('/settings', (req: Request, res: Response) => {
    const db = getDb();
    const b = (req.body || {}) as Record<string, unknown>;
    const put = (k: string, v: string): void => {
      db.prepare(
        `INSERT INTO settings (key, value) VALUES (?,?)
         ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
      ).run(k, String(v ?? ''));
    };
    // 先校验 defaultAccountId 再写任何字段：校验失败返回 400 时签名
    // 不应已被保存（旧顺序是先写签名、后校验，报错后签名已入库）。
    let defaultAccountIdToPut: string | null = null;
    if (b.defaultAccountId !== undefined) {
      // Audit #9 L19c：defaultAccountId 须为已存在账号的 id——旧版
      // String(Number('abc')) 得字面 'NaN' 存进库；非数字/不存在的 id
      // 一律 400，不再入库。
      if (b.defaultAccountId === null || b.defaultAccountId === '') {
        defaultAccountIdToPut = '';
      } else {
        const n = Number(b.defaultAccountId);
        if (!Number.isInteger(n) || n < 1) {
          return res.status(400).json({ ok: false, error: 'defaultAccountId 须为已存在账号的 id' });
        }
        const exists = db.prepare('SELECT id FROM accounts WHERE id=?').get(n);
        if (!exists) {
          return res.status(400).json({ ok: false, error: 'defaultAccountId 须为已存在账号的 id' });
        }
        defaultAccountIdToPut = String(n);
      }
    }
    if (b.signature !== undefined) {
      // D10: 签名长度上限 10000 字符——旧版无上限（实际风险极低，
      // 1MB JSON 上限兜着），加个明确上限防误操作塞巨量文本。
      if (typeof b.signature === 'string' && b.signature.length > 10000) {
        return res.status(400).json({ ok: false, error: '签名过长（最多 10000 字符）' });
      }
      put('signature', String(b.signature));
    }
    if (defaultAccountIdToPut !== null) put('defaultAccountId', defaultAccountIdToPut);
    const defaultAccountId = get('defaultAccountId');
    const n = defaultAccountId ? Number(defaultAccountId) : NaN;
    res.json({
      ok: true,
      settings: {
        signature: get('signature') || '',
        defaultAccountId: Number.isInteger(n) ? n : null,
      },
    });
  });

  // ---- 备份到本地：把加密密钥 + 全部数据打包成 tar.gz 下载 ----
  // 包内结构与迁移说明一致（.key + data/），解压到新服务器的 /opt/luck-mail 即可恢复。
  // 数据库用 better-sqlite3 在线备份做一致性快照（含 WAL 已提交数据），不直接拷正在用的库文件；
  // 正文与附件缓存是静态文件，直接拷。路由在 /api 下，已有 requireAuth（仅登录用户可下）。
  // S1: 只接受 POST——Cookie 已是 SameSite=Strict（顶层导航 GET 也不带
  // Cookie），POST-only 是第二层纵深防御：即使将来 Cookie 策略放宽，
  // 跨站顶层导航也触发不了这条含主密钥的备份下载。
  // Audit #10 L-7：备份限流——每 IP 每分钟最多 2 次（备份包内含主密钥
  // 与全部账号明文密码，防被盗会话反复拉取）。
  // Audit #10 L-19：包进 asyncHandler（旧版裸 async 路由，mkdtempSync
  // 在 try 之外、抛错即未处理 rejection）。
  // Audit #10 M-18：备份打包与正文写入竞态——旧版 cpSync 直接拷
  // bodies/，正赶上某封信的正文文件正在写入时包里就是半截文件。
  // 现在跳过 1 分钟内有 mtime 的正文文件（正在写入的信下次备份再进包；
  // 正文文件可随时从 IMAP 重取，不影响恢复）；tar 加 120 秒超时。
  r.post('/backup/download', rateLimit(60_000, 2, '备份过于频繁，请稍后再试'), asyncHandler(async (_req: Request, res: Response) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'luck-mail-backup-'));
    try {
      const keyDest = path.join(tmp, '.key');
      fs.copyFileSync(KEY_FILE, keyDest);
      // Audit #9 L15：备份包内的 .key 强制 0600 再打包——旧版 copyFileSync
      // 以默认模式复制（0644），tar 原样打包，包内密钥权限过宽。
      fs.chmodSync(keyDest, 0o600);
      const dataDir = path.join(tmp, 'data');
      fs.mkdirSync(dataDir, { recursive: true });
      await getDb().backup(path.join(dataDir, 'luck-mail.db'));
      // M-18：正文文件逐个拷、跳过 1 分钟内刚写过的（可能正在写入中）；
      // 附件目录是静态文件（下载时才写？附件默认不落盘），直接整拷。
      if (fs.existsSync(BODIES_DIR)) {
        const bodiesDest = path.join(dataDir, 'bodies');
        fs.mkdirSync(bodiesDest, { recursive: true });
        const cutoff = Date.now() - 60 * 1000;
        for (const name of fs.readdirSync(BODIES_DIR)) {
          const src = path.join(BODIES_DIR, name);
          try {
            const st = fs.statSync(src);
            if (!st.isFile()) continue;
            if (st.mtimeMs > cutoff) continue; // 1 分钟内有写入：跳过，下次备份再进包
            fs.copyFileSync(src, path.join(bodiesDest, name));
          } catch { /* 单个文件失败不中断整包 */ }
        }
      }
      if (fs.existsSync(ATTACHMENTS_DIR)) fs.cpSync(ATTACHMENTS_DIR, path.join(dataDir, 'attachments'), { recursive: true });
      const d = new Date();
      const pad = (n: number): string => String(n).padStart(2, '0');
      const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
      const filename = `luck-mail-backup-${stamp}.tar.gz`;
      const tarPath = path.join(tmp, filename);
      await execFileAsync('tar', ['-czf', tarPath, '-C', tmp, '.key', 'data'], { timeout: 120_000 });
      res.download(tarPath, filename, () => {
        fs.rmSync(tmp, { recursive: true, force: true });
      });
    } catch (e) {
      fs.rmSync(tmp, { recursive: true, force: true });
      if (!res.headersSent) res.status(500).json({ ok: false, error: '备份失败，请重试。' });
    }
  }));

  return r;
}
