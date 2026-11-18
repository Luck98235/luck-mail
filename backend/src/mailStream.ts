import { MailParser } from 'mailparser';
import { pipeline } from 'node:stream/promises';
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

  const endPromise = new Promise<void>((resolve, reject) => {
    parser.once('end', resolve);
    parser.once('error', reject);
  });
  await pipeline(readable, parser);
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

  return {
    envelope: {
      messageId,
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
