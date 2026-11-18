import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';
import { Worker } from 'node:worker_threads';
import type { ParsedMessage } from './mailUtil.js';

// Spool a download stream to a temp file (streaming, bounded memory).
// Returns the temp path; the caller deletes it.
export async function spoolToTemp(readable: Readable, messageDbId: number | null): Promise<string> {
  const tmp = path.join(
    os.tmpdir(),
    `luck-mail-parse-${process.pid}-${Date.now()}-${messageDbId || 'x'}.eml`,
  );
  await pipeline(readable, fs.createWriteStream(tmp));
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
