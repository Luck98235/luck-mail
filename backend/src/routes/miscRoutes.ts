import express from 'express';
import type { Request, Response } from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getDb } from '../db.js';
import { ATTACHMENTS_DIR, BODIES_DIR, KEY_FILE } from '../config.js';

const execFileAsync = promisify(execFile);

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
  r.post('/backup/download', async (_req: Request, res: Response) => {
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
      if (fs.existsSync(BODIES_DIR)) fs.cpSync(BODIES_DIR, path.join(dataDir, 'bodies'), { recursive: true });
      if (fs.existsSync(ATTACHMENTS_DIR)) fs.cpSync(ATTACHMENTS_DIR, path.join(dataDir, 'attachments'), { recursive: true });
      const d = new Date();
      const pad = (n: number): string => String(n).padStart(2, '0');
      const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
      const filename = `luck-mail-backup-${stamp}.tar.gz`;
      const tarPath = path.join(tmp, filename);
      await execFileAsync('tar', ['-czf', tarPath, '-C', tmp, '.key', 'data']);
      res.download(tarPath, filename, () => {
        fs.rmSync(tmp, { recursive: true, force: true });
      });
    } catch (e) {
      fs.rmSync(tmp, { recursive: true, force: true });
      if (!res.headersSent) res.status(500).json({ ok: false, error: '备份失败，请重试。' });
    }
  });

  return r;
}
