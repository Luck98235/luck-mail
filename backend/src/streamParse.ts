import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import type { Readable } from 'node:stream';
import { Worker } from 'node:worker_threads';
import type { ParsedMessage } from './mailUtil.js';

// Spool a download stream to a temp file (streaming, bounded memory).
// Returns the temp path; the caller deletes it.
// Audit #10 M-15：硬上限 100MB——旧版 spool 无上限，一封超大邮件即可
// 把 /tmp 打满；同时 streamToParsed（主线程小正文路径）也按实际流入
// 字节计数（见 mailStream.ts），两边上限一致。
export const MAX_PARSE_BYTES = 100 * 1024 * 1024;
export async function spoolToTemp(readable: Readable, messageDbId: number | null): Promise<string> {
  const tmp = path.join(
    os.tmpdir(),
    `luck-mail-parse-${process.pid}-${Date.now()}-${messageDbId || 'x'}.eml`,
  );
  let bytesSeen = 0;
  const counter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      bytesSeen += chunk.length;
      if (bytesSeen > MAX_PARSE_BYTES) {
        cb(new Error(`邮件过大（超过 ${Math.round(MAX_PARSE_BYTES / 1024 / 1024)}MB），已停止下载`));
      } else {
        cb(null, chunk);
      }
    },
  });
  await pipeline(readable, counter, fs.createWriteStream(tmp));
  return tmp;
}

// Parse a spooled temp file in a worker thread. Resolves with the same
// shape as streamToParsed().
// B22: 60 秒超时——worker 卡住（坏文件/解析死循环）时 terminate 并报错，
// 不让调用方无限等下去（之前无超时，卡住就一直挂着连接）。
export function parseInWorker(filePath: string, sizeHint = 0): Promise<ParsedMessage> {
  return new Promise<ParsedMessage>((resolve, reject) => {
    let settled = false;
    const ok = (v: ParsedMessage): void => { if (!settled) { settled = true; resolve(v); } };
    const fail = (e: unknown): void => { if (!settled) { settled = true; reject(e); } };
    const worker = new Worker(new URL('./parseWorker.js', import.meta.url), {
      workerData: { filePath, sizeHint },
    });
    const timer = setTimeout(() => {
      worker.terminate().catch(() => {});
      fail(new Error('parse worker timed out after 60s'));
    }, 60_000);
    timer.unref();
    const done = (): void => clearTimeout(timer);
    worker.on('message', (msg: { ok: boolean; result?: ParsedMessage; error?: string }) => {
      done();
      worker.terminate().catch(() => {});
      if (msg.ok && msg.result) ok(msg.result);
      else fail(new Error(msg.error || 'worker parse failed'));
    });
    worker.on('error', (e) => { done(); fail(e); });
    worker.on('exit', (code) => {
      done();
      if (code !== 0) fail(new Error(`parse worker exited with code ${code}`));
    });
  });
}
