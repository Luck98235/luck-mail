import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';
import { Worker } from 'node:worker_threads';
import { LARGE_PARSE_THRESHOLD } from './config.js';
import { streamToParsed } from './mailStream.js';
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
export function parseInWorker(filePath: string, messageDbId: number | null, sizeHint = 0): Promise<ParsedMessage> {
  return new Promise<ParsedMessage>((resolve, reject) => {
    let settled = false;
    const ok = (v: ParsedMessage): void => { if (!settled) { settled = true; resolve(v); } };
    const fail = (e: unknown): void => { if (!settled) { settled = true; reject(e); } };
    const worker = new Worker(new URL('./parseWorker.js', import.meta.url), {
      workerData: { filePath, messageDbId, sizeHint },
    });
    worker.on('message', (msg: { ok: boolean; result?: ParsedMessage; error?: string }) => {
      worker.terminate().catch(() => {});
      if (msg.ok && msg.result) ok(msg.result);
      else fail(new Error(msg.error || 'worker parse failed'));
    });
    worker.on('error', fail);
    worker.on('exit', (code) => {
      if (code !== 0) fail(new Error(`parse worker exited with code ${code}`));
    });
  });
}

// Convenience entry: route a download stream to the right path.
// Small/medium -> stream-parse on the main thread; large -> spool + worker.
export async function parseDownloadStream(
  stream: Readable,
  sizeHint: number,
  messageDbId: number | null,
): Promise<ParsedMessage> {
  if (sizeHint && sizeHint > LARGE_PARSE_THRESHOLD) {
    const tmp = await spoolToTemp(stream, messageDbId);
    try {
      return await parseInWorker(tmp, messageDbId, sizeHint);
    } finally {
      fs.rm(tmp, { force: true }, () => {});
    }
  }
  return streamToParsed(stream, messageDbId, sizeHint);
}
