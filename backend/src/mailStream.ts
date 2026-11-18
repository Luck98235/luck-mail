import { MailParser } from 'mailparser';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import type { Readable } from 'node:stream';
import { sanitizeBodyHtml } from './sanitize.js';
import { makeSnippet, toIsoDate } from './mailUtil.js';
import type { ParsedMessage } from './mailUtil.js';

// Core streaming parser (shared by the main thread and the parse worker).
// Input is a Readable of the raw RFC822 bytes; mailparser's MailParser
// consumes it chunk by chunk — the whole message is NEVER buffered in
// memory. Attachments are NEVER downloaded by default: only metadata
// (filename, type, exact size) is kept; the content stream is drained
// and discarded. Download later streams live from IMAP by part number.
//
// Returns a ParsedMessage (see mailUtil.ts).
type ParserDataEvent =
  | { type: 'text'; text?: string; html?: string }
  | {
      type: 'attachment';
      filename?: string;
      contentType?: string;
      content: Readable;
      release: () => void;
    };

interface MailParserLike {
  on(event: 'headers', fn: (h: Map<string, unknown>) => void): void;
  on(event: 'data', fn: (d: ParserDataEvent) => void): void;
  once(event: 'end', fn: () => void): void;
  once(event: 'error', fn: (e: Error) => void): void;
}

export async function streamToParsed(
  readable: Readable,
  sizeHint = 0,
  // Audit #10 M-15：硬上限（默认 100MB）——旧版 spool/解析无上限，
  // 一封超大邮件即可把整台服务器内存/磁盘打满。sizeHint 是服务器
  // 上报值、不可信（可能为 0 或谎报），这里按实际流入字节计数、
  // 超限即中断解析（错误向上传，调用方按失败处理、不写库）。
  maxBytes = 100 * 1024 * 1024,
): Promise<ParsedMessage> {
  const parser = new MailParser() as unknown as MailParserLike & NodeJS.WritableStream;
  let headers: Map<string, unknown> | null = null;
  let bodyText = '';
  let bodyHtml = '';
  const attachments: ParsedMessage['attachments'] = [];
  const pending: Promise<void>[] = [];

  parser.on('headers', (h) => { headers = h; });
  parser.on('data', (data) => {
    if (data.type === 'text') {
      bodyText = data.text || '';
      bodyHtml = data.html || '';
      return;
    }
    if (data.type === 'attachment') {
      const idx = attachments.length;
      const rawName = String(data.filename || `attachment-${idx + 1}`);
      // 附件默认不下载：只记元信息（文件名、类型、精确大小），内容流直接丢弃、
      // 不落盘。下载时凭 part 号从 IMAP 实时取、流式传给浏览器。
      // part 号由 engine 的 matchAttachmentParts 按 BODYSTRUCTURE 补上。
      const rec: ParsedMessage['attachments'][number] = {
        filename: rawName,
        contentType: data.contentType || 'application/octet-stream',
        size: 0,
        path: null,
        cached: false,
        large: false,
        part: null,
      };
      attachments.push(rec);
      const done = new Promise<void>((resolve) => {
        let finished = false;
        const finish = (): void => { if (!finished) { finished = true; resolve(); } };
        data.content.on('data', (chunk: Buffer) => { rec.size += chunk.length; });
        data.content.on('end', finish);
        data.content.on('error', finish);
      });
      pending.push(done);
      data.content.resume();
      data.release();
      return;
    }
  });

  // Audit #10 L-20：endPromise 的双重 rejection——parser 出错时
  // pipeline() 与 endPromise 各自 reject 一次；旧版 await pipeline
  // 先抛，endPromise 的那次就成了未处理的 rejection（日志噪音，
  // 极端下可触发 unhandledRejection 兜底）。先挂一个空 catch 认领。
  const endPromise = new Promise<void>((resolve, reject) => {
    parser.once('end', resolve);
    parser.once('error', reject);
  });
  endPromise.catch(() => { /* pipeline() 会抛同一份错误，这里只认领 */ });
  // Audit #10 M-15：按实际流入字节计数，超硬上限即中断。
  let bytesSeen = 0;
  const counter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      bytesSeen += chunk.length;
      if (bytesSeen > maxBytes) {
        cb(new Error(`邮件过大（超过 ${Math.round(maxBytes / 1024 / 1024)}MB），已停止解析`));
      } else {
        cb(null, chunk);
      }
    },
  });
  await pipeline(readable, counter, parser);
  await endPromise;
  await Promise.all(pending);

  const getHeader = (name: string): unknown => headers?.get?.(name);
  const getAddr = (headerName: string): { address: string; name: string } => {
    const h = getHeader(headerName) as { value?: { address?: string; name?: string }[] } | undefined;
    const v = h?.value?.[0];
    return v ? { address: v.address || '', name: v.name || '' } : { address: '', name: '' };
  };
  const addrList = (headerName: string): string[] => {
    const h = getHeader(headerName) as { value?: { address?: string }[] } | undefined;
    return (h?.value || []).map((a) => a.address).filter(Boolean) as string[];
  };
  const from = getAddr('from');
  const dateVal = getHeader('date');
  // R5: 非法 Date 头记 null（复用 toIsoDate 守卫）——mailparser 会把
  // 非法日期 fallback 成“现在”，不加守卫打开的信日期就变成今天，
  // 与信封路径（toIsoDate 存 null）不一致，排序/显示错位。
  const date = dateVal instanceof Date
    ? toIsoDate(dateVal)
    : (dateVal ? toIsoDate(String(dateVal)) : null);
  const subject = String(getHeader('subject') || '');
  const messageId = (getHeader('message-id') as string | undefined) || null;
  // Audit #10 threading：取 References 头（mailparser 的解析形态不一：
  // string / string[] / { value } / { text }，按顺序兜底），存
  // messages.references、供 GET /api/messages/:id 返回。
  const normalizeReferences = (v: unknown): string | null => {
    if (!v) return null;
    if (typeof v === 'string') return v.trim() || null;
    if (Array.isArray(v)) return v.map(String).join(' ').trim().slice(0, 4000) || null;
    const obj = v as { value?: unknown; text?: unknown };
    if (typeof obj.value === 'string') return obj.value.trim().slice(0, 4000) || null;
    if (Array.isArray(obj.value)) return obj.value.map(String).join(' ').trim().slice(0, 4000) || null;
    if (typeof obj.text === 'string') return obj.text.trim().slice(0, 4000) || null;
    return null;
  };
  const references = normalizeReferences(getHeader('references'));

  return {
    envelope: {
      messageId,
      references,
      subject,
      fromAddr: from.address,
      fromName: from.name,
      to: addrList('to'),
      toDisplay: (getHeader('to') as { text?: string } | undefined)?.text || '',
      cc: addrList('cc'),
      date,
      size: sizeHint || 0,
    },
    bodyText,
    bodyHtml: sanitizeBodyHtml(bodyHtml),
    snippet: makeSnippet(bodyText),
    hasAttachments: attachments.length > 0,
    attachments,
  };
}
