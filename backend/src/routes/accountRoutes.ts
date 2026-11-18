import express from 'express';
import type { Request, Response } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import ExcelJS from 'exceljs';
import multer from 'multer';
import { getDb, removeMessagesFtsByAccount } from '../db.js';
import type { AccountRow } from '../db.js';
import { encryptSecret, decryptSecret } from '../cryptoUtil.js';
import { allPresets, resolvePreset } from '../presets.js';
import type { Preset } from '../presets.js';
import { testConnectivity, accountToImap } from '../imapUtil.js';
import type { ImapAccount } from '../imapUtil.js';
import { dropTransporter } from '../smtpUtil.js';
import { emit } from '../hub.js';
import { ATTACHMENTS_DIR, BODIES_DIR, log } from '../config.js';
import type { SyncEngine } from '../engine.js';

export interface Ctx {
  engine: SyncEngine;
  masterKey: Buffer;
}

// Audit #8 LOW-6（友好性）：账号测试接口节流——每点一次就是一次 IMAP
// 登录 + 一次 SMTP 验证；同一账号 10 秒内重复测试直接返回上次结果。
// 只记内存（单进程），账号删除时清掉对应项。
const testResultCache = new Map<number, { at: number; result: { imapOk: boolean; smtpOk: boolean; error: string | null } }>();
const TEST_CACHE_MS = 10 * 1000;

// 导出与导入模板共用的 8 列：序号 / 邮箱名 / 授权码 / 接收服务器（IMAP）/
// IMAP 端口 / 发送服务器（SMTP）/ SMTP 端口 / 备注。
const ACCOUNT_EXCEL_COLUMNS = [
  { header: '序号', key: 'no', width: 8 },
  { header: '邮箱名', key: 'email', width: 26 },
  { header: '授权码', key: 'password', width: 22 },
  { header: '接收服务器（IMAP）', key: 'imapHost', width: 20 },
  { header: 'IMAP端口', key: 'imapPort', width: 12 },
  { header: '发送服务器（SMTP）', key: 'smtpHost', width: 20 },
  { header: 'SMTP端口', key: 'smtpPort', width: 12 },
  { header: '备注', key: 'displayName', width: 20 },
];

function publicAccount(row: AccountRow, unreadCount?: number): Record<string, unknown> {
  // Audit #8 LOW-4（数据库）：原来每账号一次 SUM 查未读数（N+1）；
  // 列表接口改为一次 GROUP BY 查全部（见 GET /accounts），这里只在
  // 未传 unreadCount 的单账号调用时才逐行查（导入/新增/更新后回显）。
  const unread = unreadCount ?? (getDb().prepare(
    'SELECT COALESCE(SUM(unread_count),0) c FROM folders WHERE account_id=?',
  ).get(row.id) as { c: number }).c;
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name || '',
    imapHost: row.imap_host,
    imapPort: row.imap_port,
    imapSecure: row.imap_secure,
    smtpHost: row.smtp_host,
    smtpPort: row.smtp_port,
    smtpSecure: row.smtp_secure,
    enabled: !!row.enabled,
    sortOrder: row.sort_order || 0,
    status: row.status || 'offline',
    unreadCount: unread,
    lastSyncAt: row.last_sync_at || null,
    ...(row.error ? { error: row.error } : {}),
  };
}

type ServerFields = {
  imapHost?: unknown;
  imapPort?: unknown;
  imapSecure?: unknown;
  smtpHost?: unknown;
  smtpPort?: unknown;
  smtpSecure?: unknown;
};

function validateServerFields(b: ServerFields): string | null {
  for (const f of ['imapHost', 'smtpHost'] as const) {
    if (b[f] !== undefined && (typeof b[f] !== 'string' || !(b[f] as string).trim())) {
      return `${f} 不能为空`;
    }
  }
  for (const f of ['imapPort', 'smtpPort'] as const) {
    if (b[f] !== undefined && (!Number.isInteger(Number(b[f])) || Number(b[f]) < 1 || Number(b[f]) > 65535)) {
      return `${f} 端口无效`;
    }
  }
  for (const f of ['imapSecure', 'smtpSecure'] as const) {
    if (b[f] !== undefined && !['SSL', 'STARTTLS'].includes(b[f] as string)) return `${f} 只能是 SSL 或 STARTTLS`;
  }
  return null;
}

export function accountRoutes(ctx: Ctx): express.Router {
  const { engine, masterKey } = ctx;
  const r = express.Router();

  // ---- presets ----
  r.get('/presets', (_req: Request, res: Response) => {
    res.json({ ok: true, presets: allPresets() });
  });

  r.get('/presets/:domain', (req: Request, res: Response) => {
    const domain = String(req.params.domain || '').toLowerCase();
    const presets = allPresets();
    if (presets[domain]) {
      const { label: _label, ...preset } = presets[domain] as Preset & { label?: string };
      return res.json({ ok: true, preset, note: preset.note || '' });
    }
    const fallback = resolvePreset(`x@${domain}`);
    return res.json({ ok: true, preset: fallback, note: '' });
  });

  // ---- accounts ----
  r.get('/accounts', (_req: Request, res: Response) => {
    const db = getDb();
    const rows = db.prepare('SELECT * FROM accounts ORDER BY sort_order, id').all() as AccountRow[];
    // Audit #8 LOW-4：一次 GROUP BY 查出全部账号的未读数，不再每账号一查。
    const unreadByAccount = new Map<number, number>(
      (db.prepare('SELECT account_id, COALESCE(SUM(unread_count),0) c FROM folders GROUP BY account_id').all() as { account_id: number; c: number }[])
        .map((x) => [x.account_id, x.c]),
    );
    res.json({ ok: true, accounts: rows.map((row) => publicAccount(row, unreadByAccount.get(row.id) ?? 0)) });
  });

  // 取单个邮箱的当前密码（明文）：仅供“邮箱设置”弹窗打开时回填密码框，
  // 让用户点小眼睛查看。须登录；平时不随账号列表下发。
  r.get('/accounts/:id/password', (req: Request, res: Response) => {
    const db = getDb();
    const id = Number(req.params.id);
    const row = db.prepare('SELECT password_enc FROM accounts WHERE id=?').get(id) as { password_enc: string } | undefined;
    if (!row) return res.status(404).json({ ok: false, error: '账号不存在' });
    try {
      res.json({ ok: true, password: decryptSecret(row.password_enc, masterKey) });
    } catch {
      res.status(500).json({ ok: false, error: '密码解密失败' });
    }
  });

  // 导出全部邮箱为 Excel（.xlsx）：字段 序号 / 邮箱名 / 授权码 / 接收服务器（IMAP）/
  // IMAP 端口 / 发送服务器（SMTP）/ SMTP 端口 / 备注，按当前排序导出。授权码为明文，
  // 文件请妥善保存。须登录。
  // S1: 只接受 POST（同 /api/backup/download，防跨站顶层导航 CSRF 下载）。
  r.post('/accounts/export', async (_req: Request, res: Response) => {
    const db = getDb();
    const rows = db.prepare('SELECT * FROM accounts ORDER BY sort_order, id').all() as AccountRow[];
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('邮箱');
    ws.columns = ACCOUNT_EXCEL_COLUMNS;
    ws.getRow(1).font = { bold: true };
    rows.forEach((row, i) => {
      let password = '';
      try { password = decryptSecret(row.password_enc, masterKey); } catch { password = ''; }
      ws.addRow({
        no: i + 1,
        email: row.email,
        password,
        imapHost: row.imap_host,
        imapPort: row.imap_port,
        smtpHost: row.smtp_host,
        smtpPort: row.smtp_port,
        displayName: row.display_name || '',
      });
    });
    const buf = await wb.xlsx.writeBuffer();
    const d = new Date();
    const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}-${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="luck-mail-accounts-${stamp}.xlsx"`);
    res.send(Buffer.from(buf));
  });

  // 导入模板：空的 CSV，只有表头一行（与导出相同的 8 列），供用户填好后导入。
  // 须登录。带 UTF-8 BOM，Excel 打开中文表头不乱码。
  r.get('/accounts/import-template', (_req: Request, res: Response) => {
    const header = '序号,邮箱名,授权码,接收服务器（IMAP）,IMAP端口,发送服务器（SMTP）,SMTP端口,备注';
    const csv = '\uFEFF' + header + '\r\n';
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="luck-mail-import-template.csv"');
    res.send(csv);
  });

  // CSV 解析（轻量自写，不引新依赖）：处理引号字段、字段内逗号、
  // 字段内换行、UTF-8 BOM、CRLF。引号字段内 "" 转义为一个 "。
  // 返回行数组（每行是 string[]）；引号未闭合等不合规处按宽容处理
  // （字段结束），不让一份手填文件整体失败。
  function parseCsv(text: string): string[][] {
    const rows: string[][] = [];
    let row: string[] = [];
    let field = '';
    let inQuotes = false;
    let i = text.charCodeAt(0) === 0xfeff ? 1 : 0; // 去 UTF-8 BOM
    for (; i < text.length; i++) {
      const ch = text[i];
      if (inQuotes) {
        if (ch === '"') {
          if (text[i + 1] === '"') { field += '"'; i++; }
          else inQuotes = false;
        } else field += ch;
      } else if (ch === '"') {
        // 字段开头的引号进入引号模式；字段中间的引号按普通字符处理。
        if (field.length === 0) inQuotes = true;
        else field += ch;
      } else if (ch === ',') {
        row.push(field); field = '';
      } else if (ch === '\n') {
        row.push(field); field = '';
        rows.push(row); row = [];
      } else if (ch === '\r') {
        // CRLF 的 \r：后面是 \n 时跳过（\n 分支会收行）；单独 \r 也当换行。
        if (text[i + 1] === '\n') continue;
        row.push(field); field = '';
        rows.push(row); row = [];
      } else field += ch;
    }
    // 末尾残留字段/行（无结尾换行时）。
    if (field.length > 0 || row.length > 0 || inQuotes) {
      row.push(field);
      rows.push(row);
    }
    return rows;
  }

  // 批量导入邮箱：上传填好的导入模板（.csv），按行读出邮箱信息逐个添加。
  // 同名邮箱（不区分大小写）跳过，不报错；空行跳过；格式不对或服务器信息不全的行
  // 记入 failed，不中断其余行。导入时不做连通测试（批量测太慢），加完后可用管理
  // 列表每行的“测试”按钮逐个测。服务器地址/端口留空时按域名自动取预设，取不到则失败。
  // 须登录；文件限 5MB。exceljs 只留给导出（只写不读），导入不再解析 xlsx。
  const importUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });
  r.post('/accounts/import', importUpload.single('file'), async (req: Request, res: Response) => {
    const db = getDb();
    const f = (req as Request & { file?: Express.Multer.File }).file;
    if (!f || !f.buffer) return res.status(400).json({ ok: false, error: '请选择要导入的 CSV 文件' });
    // 旧模板是 .xlsx（ZIP）：直接报清楚，别让用户对着乱码排查。
    if (f.buffer.length >= 4 && f.buffer[0] === 0x50 && f.buffer[1] === 0x4b && f.buffer[2] === 0x03 && f.buffer[3] === 0x04) {
      return res.status(400).json({ ok: false, error: '请上传 CSV 文件（.csv），不是 Excel（.xlsx）；请用“下载导入模板”拿新模板' });
    }
    const rows = parseCsv(f.buffer.toString('utf8'));
    if (!rows.length) return res.status(400).json({ ok: false, error: 'CSV 文件是空的，请用下载的导入模板填写' });
    const added: string[] = [];
    const skipped: string[] = [];
    const failed: { row: number; email: string; reason: string }[] = [];
    const seenInFile = new Set<string>();
    // Audit #8 LOW-5（数据库）：导入前一次查出全部已有邮箱进 Set，
    // 不再每行一次 SELECT 判重。
    const existingEmails = new Set(
      (db.prepare('SELECT email FROM accounts').all() as { email: string }[])
        .map((x) => x.email.toLowerCase()),
    );
    // 列顺序与导入模板一致：0 序号（忽略），1 邮箱名，2 授权码，3 IMAP 服务器，
    // 4 IMAP 端口，5 SMTP 服务器，6 SMTP 端口，7 备注。第 1 行是表头。
    rows.forEach((cols, idx) => {
      const rnum = idx + 1;
      if (rnum === 1) return;
      const email = String(cols[1] ?? '').trim().toLowerCase();
      const password = String(cols[2] ?? '').trim();
      const imapHost = String(cols[3] ?? '').trim();
      const imapPortRaw = cols[4];
      const smtpHost = String(cols[5] ?? '').trim();
      const smtpPortRaw = cols[6];
      const displayName = String(cols[7] ?? '').trim();
      if (!email) return;
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        failed.push({ row: rnum, email, reason: '邮箱地址格式不正确' });
        return;
      }
      if (seenInFile.has(email) || existingEmails.has(email)) {
        skipped.push(email);
        return;
      }
      seenInFile.add(email);
      if (!password) {
        failed.push({ row: rnum, email, reason: '授权码为空' });
        return;
      }
      const preset = resolvePreset(email);
      const imapH = imapHost || preset?.imapHost || '';
      const imapP = Number(imapPortRaw);
      const imapPort = Number.isInteger(imapP) && imapP > 0 && imapP <= 65535 ? imapP : (preset?.imapPort ?? 0);
      const smtpH = smtpHost || preset?.smtpHost || '';
      const smtpP = Number(smtpPortRaw);
      const smtpPort = Number.isInteger(smtpP) && smtpP > 0 && smtpP <= 65535 ? smtpP : (preset?.smtpPort ?? 0);
      if (!imapH || !imapPort || !smtpH || !smtpPort) {
        failed.push({ row: rnum, email, reason: '服务器地址或端口不完整，且该域名无自动预设' });
        return;
      }
      const sortOrder = (db.prepare('SELECT COALESCE(MAX(sort_order),-1)+1 v FROM accounts').get() as { v: number }).v;
      const info = db.prepare(
        `INSERT INTO accounts (email, display_name, password_enc, imap_host, imap_port,
          imap_secure, smtp_host, smtp_port, smtp_secure, sort_order, status)
         VALUES (?,?,?,?,?,?,?,?,?,?, 'offline')`,
      ).run(email, displayName, encryptSecret(password, masterKey),
        imapH, imapPort, preset?.imapSecure || 'SSL',
        smtpH, smtpPort, preset?.smtpSecure || 'SSL', sortOrder);
      const newRow = db.prepare('SELECT * FROM accounts WHERE id=?').get(Number(info.lastInsertRowid)) as AccountRow;
      engine.startAccount(newRow.id);
      emit('account', { action: 'added', account: publicAccount(newRow) });
      added.push(email);
    });
    res.json({ ok: true, added: added.length, skipped: skipped.length, failed, addedEmails: added, skippedEmails: skipped });
  });

  r.post('/accounts', async (req: Request, res: Response) => {
    const db = getDb();
    const b = (req.body || {}) as Record<string, unknown>;
    const email = String(b.email || '').trim().toLowerCase();
    const password = b.password;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ ok: false, error: '邮箱地址格式不正确' });
    }
    if (!password || typeof password !== 'string') {
      return res.status(400).json({ ok: false, error: '密码/授权码必填' });
    }
    const err = validateServerFields(b as ServerFields);
    if (err) return res.status(400).json({ ok: false, error: err });
    if (db.prepare('SELECT id FROM accounts WHERE email=?').get(email)) {
      return res.status(409).json({ ok: false, error: '该邮箱已添加过' });
    }
    const preset = resolvePreset(email);
    if (!preset) return res.status(400).json({ ok: false, error: '邮箱地址格式不正确' });
    const account: ImapAccount = {
      email,
      imapHost: (b.imapHost as string) || preset.imapHost,
      imapPort: Number(b.imapPort || preset.imapPort),
      imapSecure: (b.imapSecure as string) || preset.imapSecure,
      smtpHost: (b.smtpHost as string) || preset.smtpHost,
      smtpPort: Number(b.smtpPort || preset.smtpPort),
      smtpSecure: (b.smtpSecure as string) || preset.smtpSecure,
    };
    // Connectivity must pass before saving (contract).
    const test = await testConnectivity(account, password as string);
    if (!test.imapOk || !test.smtpOk) {
      return res.status(400).json({ ok: false, error: test.error || '连接测试失败' });
    }
    const sortOrder = (db.prepare('SELECT COALESCE(MAX(sort_order),-1)+1 v FROM accounts').get() as { v: number }).v;
    const info = db.prepare(
      `INSERT INTO accounts (email, display_name, password_enc, imap_host, imap_port,
        imap_secure, smtp_host, smtp_port, smtp_secure, sort_order, status)
       VALUES (?,?,?,?,?,?,?,?,?,?, 'offline')`,
    ).run(email, (b.displayName as string) || '', encryptSecret(password as string, masterKey),
      account.imapHost, account.imapPort, account.imapSecure,
      account.smtpHost, account.smtpPort, account.smtpSecure, sortOrder);
    const row = db.prepare('SELECT * FROM accounts WHERE id=?').get(Number(info.lastInsertRowid)) as AccountRow;
    engine.startAccount(row.id);
    emit('account', { action: 'added', account: publicAccount(row) });
    return res.status(201).json({ ok: true, account: publicAccount(row) });
  });

  r.put('/accounts/:id', async (req: Request, res: Response) => {
    const db = getDb();
    const id = Number(req.params.id);
    const row = db.prepare('SELECT * FROM accounts WHERE id=?').get(id) as AccountRow | undefined;
    if (!row) return res.status(404).json({ ok: false, error: '账号不存在' });
    const b = (req.body || {}) as Record<string, unknown>;
    const err = validateServerFields(b as ServerFields);
    if (err) return res.status(400).json({ ok: false, error: err });
    const merged = {
      email: row.email,
      displayName: b.displayName !== undefined ? (b.displayName as string) : row.display_name,
      imapHost: (b.imapHost as string) || row.imap_host,
      imapPort: Number(b.imapPort || row.imap_port),
      imapSecure: (b.imapSecure as string) || row.imap_secure,
      smtpHost: (b.smtpHost as string) || row.smtp_host,
      smtpPort: Number(b.smtpPort || row.smtp_port),
      smtpSecure: (b.smtpSecure as string) || row.smtp_secure,
    };
    const passwordChanged = typeof b.password === 'string' && (b.password as string).length > 0;
    const serverChanged = merged.imapHost !== row.imap_host || merged.imapPort !== row.imap_port
      || merged.imapSecure !== row.imap_secure || merged.smtpHost !== row.smtp_host
      || merged.smtpPort !== row.smtp_port || merged.smtpSecure !== row.smtp_secure;
    const enabledChanged = b.enabled !== undefined && !!b.enabled !== !!row.enabled;
    const newEnabled = b.enabled !== undefined ? !!b.enabled : !!row.enabled;
    if (passwordChanged || serverChanged) {
      const password = passwordChanged ? (b.password as string) : decryptSecret(row.password_enc, masterKey);
      const test = await testConnectivity(merged, password);
      if (!test.imapOk || !test.smtpOk) {
        return res.status(400).json({ ok: false, error: test.error || '连接测试失败' });
      }
    }
    const tx = db.transaction(() => {
      db.prepare(
        `UPDATE accounts SET display_name=?, password_enc=?, imap_host=?, imap_port=?,
         imap_secure=?, smtp_host=?, smtp_port=?, smtp_secure=?, enabled=?,
         sort_order=?, updated_at=datetime('now'), error=NULL WHERE id=?`,
      ).run(
        merged.displayName,
        passwordChanged ? encryptSecret(b.password as string, masterKey) : row.password_enc,
        merged.imapHost, merged.imapPort, merged.imapSecure,
        merged.smtpHost, merged.smtpPort, merged.smtpSecure,
        newEnabled ? 1 : 0,
        b.sortOrder !== undefined ? Number(b.sortOrder) : row.sort_order,
        id,
      );
    });
    tx();
    if (passwordChanged || serverChanged) dropTransporter(id);
    if (enabledChanged || passwordChanged || serverChanged) {
      engine.stopAccount(id, true);
      if (newEnabled) engine.startAccount(id);
      else db.prepare("UPDATE accounts SET status='offline' WHERE id=?").run(id);
    }
    const updated = db.prepare('SELECT * FROM accounts WHERE id=?').get(id) as AccountRow;
    emit('account', { action: 'updated', account: publicAccount(updated) });
    return res.json({ ok: true, account: publicAccount(updated) });
  });

  r.delete('/accounts/:id', (req: Request, res: Response) => {
    const db = getDb();
    const id = Number(req.params.id);
    const row = db.prepare('SELECT * FROM accounts WHERE id=?').get(id) as AccountRow | undefined;
    if (!row) return res.status(404).json({ ok: false, error: '账号不存在' });
    engine.stopAccount(id, true);
    dropTransporter(id);
    testResultCache.delete(id);
    // Remove cached attachment files + body files for this account's messages.
    const msgIds = db.prepare('SELECT id FROM messages WHERE account_id=?').all(id) as { id: number }[];
    for (const m of msgIds) {
      try { fs.rmSync(path.join(ATTACHMENTS_DIR, String(m.id)), { recursive: true, force: true }); } catch { /* ignore */ }
      try { fs.rmSync(path.join(BODIES_DIR, `${m.id}.html`), { force: true }); } catch { /* ignore */ }
      try { fs.rmSync(path.join(BODIES_DIR, `${m.id}.txt`), { force: true }); } catch { /* ignore */ }
    }
    removeMessagesFtsByAccount(id);
    db.prepare('DELETE FROM accounts WHERE id=?').run(id);
    emit('account', { action: 'removed', account: { id, email: row.email } });
    return res.json({ ok: true });
  });

  r.post('/accounts/:id/test', async (req: Request, res: Response) => {
    const db = getDb();
    const id = Number(req.params.id);
    const row = db.prepare('SELECT * FROM accounts WHERE id=?').get(id) as AccountRow | undefined;
    if (!row) return res.status(404).json({ ok: false, error: '账号不存在' });
    // Audit #8 LOW-6：10 秒内重复测试直接返回上次结果（cached: true），
    // 不再每次新建连接登录一次。返回形状与原来一致（无错误时不带 error 字段）。
    const cached = testResultCache.get(id);
    if (cached && Date.now() - cached.at < TEST_CACHE_MS) {
      return res.json({
        ok: true, imapOk: cached.result.imapOk, smtpOk: cached.result.smtpOk,
        ...(cached.result.error ? { error: cached.result.error } : {}), cached: true,
      });
    }
    const password = decryptSecret(row.password_enc, masterKey);
    const test = await testConnectivity(accountToImap(row), password);
    const result = { imapOk: test.imapOk, smtpOk: test.smtpOk, error: test.error };
    testResultCache.set(id, { at: Date.now(), result });
    return res.json({ ok: true, imapOk: test.imapOk, smtpOk: test.smtpOk, ...(test.error ? { error: test.error } : {}) });
  });

  r.post('/accounts/:id/refresh', (req: Request, res: Response) => {
    const db = getDb();
    const id = Number(req.params.id);
    if (!db.prepare('SELECT id FROM accounts WHERE id=?').get(id)) {
      return res.status(404).json({ ok: false, error: '账号不存在' });
    }
    engine.refreshAccount(id).catch((e: unknown) => log('refresh failed', id, (e as Error)?.message || e));
    return res.json({ ok: true });
  });

  r.post('/refresh-all', (_req: Request, res: Response) => {
    engine.refreshAll().catch((e: unknown) => log('refresh-all failed', (e as Error)?.message || e));
    return res.json({ ok: true });
  });

  // ---- folders (read from DB only, never IMAP) ----
  r.get('/accounts/:id/folders', (req: Request, res: Response) => {
    const db = getDb();
    const id = Number(req.params.id);
    if (!db.prepare('SELECT id FROM accounts WHERE id=?').get(id)) {
      return res.status(404).json({ ok: false, error: '账号不存在' });
    }
    // 文件夹顺序按类型固定（与 163 一致）：收件夹 → 已发送 → 草稿箱 → 垃圾邮件 → 已删除 → 其他；
    // 不按 path 字母排（QQ 的英文路径 Deleted Messages/Drafts/INBOX/Junk/Sent Messages 按字母排会乱），
    // 也不按名字排——以后新加服务商、文件夹名再奇怪，type 判定一到顺序就自动对。
    const folders = db.prepare(
      `SELECT id, account_id AS accountId, path, name, type, unread_count AS unreadCount, total_count AS totalCount FROM folders WHERE account_id=?
       ORDER BY CASE type WHEN 'inbox' THEN 0 WHEN 'sent' THEN 1 WHEN 'drafts' THEN 2 WHEN 'spam' THEN 3 WHEN 'trash' THEN 4 ELSE 5 END, path`,
    ).all(id);
    res.json({ ok: true, folders });
  });

  return r;
}
