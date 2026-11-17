import { simpleParser } from 'mailparser';
import fs from 'node:fs';
import path from 'node:path';
import { ATTACHMENTS_DIR, ATTACHMENT_CACHE_MAX_BYTES } from './config.js';
import { sanitizeBodyHtml } from './sanitize.js';
import type { MessageStructureObject } from 'imapflow';

// ---- Folder type detection (special-use + Chinese/English name heuristics) ----
// Only real server folders are ever listed; this only classifies them.
export function detectFolderType(
  specialUse: string[] | string | undefined,
  displayName: string,
  folderPath: string,
): string {
  // imapflow returns specialUse as a single string (e.g. "\\Sent"), not an
  // array; normalize defensively so a truthy non-array never crashes .map().
  const arr = Array.isArray(specialUse)
    ? specialUse
    : (typeof specialUse === 'string' && specialUse ? [specialUse] : []);
  const su = arr.map((s) => String(s).toLowerCase());
  if (su.includes('\\inbox')) return 'inbox';
  if (su.includes('\\sent')) return 'sent';
  if (su.includes('\\drafts')) return 'drafts';
  if (su.includes('\\trash')) return 'trash';
  if (su.includes('\\junk')) return 'spam';
  const name = `${displayName || ''} ${folderPath || ''}`.toLowerCase();
  if (name.includes('草稿') || /drafts?/i.test(name)) return 'drafts';
  if (name.includes('已发送') || /sent/.test(name)) return 'sent';
  if (name.includes('已删除') || name.includes('删除') || /trash|deleted/.test(name)) return 'trash';
  if (name.includes('垃圾') || /junk|spam/.test(name)) return 'spam';
  if (name.includes('收件箱') || /(^|\/)inbox$/i.test(folderPath || '')) return 'inbox';
  return 'other';
}

export interface ListEntry {
  path: string;
  name?: string;
  delimiter?: string;
  // imapflow 1.x types this as a single string (e.g. "\\Sent").
  specialUse?: string | string[];
  children?: ListEntry[];
}

export function displayNameOf(listEntry: ListEntry): string {
  // imapflow list() already decodes modified UTF-7 names into `name`.
  if (listEntry.name) return listEntry.name;
  const parts = String(listEntry.path || '').split(listEntry.delimiter || '/');
  return parts[parts.length - 1] || listEntry.path || '';
}

export function makeSnippet(text: string, len = 200): string {
  return String(text || '').replace(/\s+/g, ' ').trim().slice(0, len);
}

// ---- IMAP BODYSTRUCTURE attachment parts (for the 10 MB rule) ----
export interface AttachmentPart {
  part: string | null;
  filename: string | null;
  size: number;
  contentType: string;
}

// Walk a bodyStructure tree (imapflow) depth-first (document order) and
// collect attachment parts with their IMAP part numbers ("2", "1.2", ...),
// so a >10 MB attachment can later be streamed live from IMAP by part.
export function collectAttachmentParts(bodyStructure: MessageStructureObject | null | undefined): AttachmentPart[] {
  const out: AttachmentPart[] = [];
  const walk = (node: MessageStructureObject | undefined | null): void => {
    if (!node) return;
    if (node.childNodes) {
      for (const c of node.childNodes) walk(c);
      return;
    }
    const disp = (node.disposition || '').toLowerCase();
    const params = { ...(node.parameters || {}), ...(node.dispositionParameters || {}) } as Record<string, string>;
    const filename = params.filename || params.name || null;
    if (disp === 'attachment' || disp === 'inline' || filename) {
      out.push({
        part: node.part || null,
        filename,
        size: node.size || 0,
        contentType: node.type || 'application/octet-stream',
      });
    }
  };
  walk(bodyStructure);
  return out;
}

export interface ParsedAttachment {
  filename: string;
  contentType: string;
  size: number;
  path: string | null;
  cached: boolean;
  large: boolean;
  part: string | null;
}

// Match streamed-parse attachments (document order) to BODYSTRUCTURE parts.
// Prefer a filename match, fall back to the same index.
export function matchAttachmentParts(
  parsedAttachments: ParsedAttachment[],
  parts: AttachmentPart[],
): ParsedAttachment[] {
  return (parsedAttachments || []).map((att, i) => {
    const byName = (parts || []).find((p) => p.filename && att.filename && p.filename === att.filename);
    const m = byName || parts?.[i] || null;
    return { ...att, part: m?.part || null };
  });
}

export interface ParsedMessage {
  envelope: {
    messageId: string | null;
    subject: string;
    fromAddr: string;
    fromName: string;
    to: string[];
    toDisplay: string;
    cc: string[];
    date: string | null;
    size: number;
  };
  bodyText: string;
  bodyHtml: string;
  snippet: string;
  hasAttachments: boolean;
  attachments: ParsedAttachment[];
}

interface AddressValue {
  name?: string;
  address?: string;
  text?: string;
}

// mailparser types ParsedMail.from/to/cc as AddressObject | AddressObject[].
function headerAddresses(v: unknown): AddressValue[] {
  const o = v as { value?: AddressValue[] } | { value?: AddressValue[] }[] | undefined;
  if (!o) return [];
  if (Array.isArray(o)) return o.flatMap((x) => x.value || []);
  return o.value || [];
}

function addressList(v: unknown): { name: string; address: string }[] {
  return headerAddresses(v).filter(Boolean).map((a) => ({
    name: a.name || '',
    address: a.address || a.text || '',
  }));
}

function addrString(list: { name: string; address: string }[]): string {
  return list.map((a) => (a.name ? `${a.name} <${a.address}>` : a.address)).filter(Boolean).join(', ');
}

// ---- Parse a raw RFC822 message (Buffer) — test/utility path only ----
// The production path is streaming (mailStream.streamToParsed). This helper
// is kept for the verification script and small ad-hoc parsing.
export async function parseRawMessage(source: Buffer, messageDbId: number | null): Promise<ParsedMessage> {
  const parsed = await simpleParser(source);
  const from = headerAddresses(parsed.from)[0];
  const toList = addressList(parsed.to);
  const ccList = addressList(parsed.cc);
  const bodyText = parsed.text || '';
  const bodyHtml = sanitizeBodyHtml(parsed.html || '');
  const attachments: ParsedAttachment[] = [];
  if (messageDbId && parsed.attachments?.length) {
    const dir = path.join(ATTACHMENTS_DIR, String(messageDbId));
    fs.mkdirSync(dir, { recursive: true });
    parsed.attachments.forEach((att, i) => {
      const safeName = String(att.filename || `attachment-${i + 1}`).replace(/[\\/:*?"<>|]/g, '_');
      const fileName = `${i + 1}-${safeName}`;
      const filePath = path.join(dir, fileName);
      const size = att.content?.length || 0;
      if (size > ATTACHMENT_CACHE_MAX_BYTES) {
        // 10 MB rule also applies here: metadata only, no file on disk.
        attachments.push({
          filename: att.filename || safeName,
          contentType: att.contentType || 'application/octet-stream',
          size,
          path: null,
          cached: false,
          large: true,
          part: null,
        });
        return;
      }
      fs.writeFileSync(filePath, att.content);
      attachments.push({
        filename: att.filename || safeName,
        contentType: att.contentType || 'application/octet-stream',
        size,
        path: path.relative(ATTACHMENTS_DIR, filePath),
        cached: true,
        large: false,
        part: null,
      });
    });
  }
  return {
    envelope: {
      messageId: parsed.messageId || null,
      subject: parsed.subject || '',
      fromAddr: from?.address || '',
      fromName: from?.name || '',
      to: toList.map((a) => a.address),
      toDisplay: addrString(toList),
      cc: ccList.map((a) => a.address),
      date: parsed.date ? parsed.date.toISOString() : null,
      size: source.length,
    },
    bodyText,
    bodyHtml,
    snippet: makeSnippet(bodyText),
    hasAttachments: (parsed.attachments?.length || 0) > 0,
    attachments,
  };
}
