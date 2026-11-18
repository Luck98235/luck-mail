// Parse worker: runs mailparser off the main thread for very large messages.
// The main thread spools the IMAP download stream to a temp file first, then
// hands only the FILE PATH to this worker — no big buffers cross threads.
// The worker streams the file through MailParser and returns only the parsed
// metadata + text (attachments are metadata-only, never written to disk).
import { parentPort, workerData } from 'node:worker_threads';
import fs from 'node:fs';
import { streamToParsed } from './mailStream.js';

const { filePath, sizeHint } = workerData as {
  filePath: string;
  sizeHint: number;
};

try {
  const result = await streamToParsed(fs.createReadStream(filePath), sizeHint);
  parentPort?.postMessage({ ok: true, result });
} catch (e) {
  parentPort?.postMessage({ ok: false, error: String((e as Error)?.message || e) });
}
