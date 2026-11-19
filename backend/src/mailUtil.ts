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
  // imapflow LIST 返回的 flags 是 Set<string>（含 \Noselect /
  // \NonExistent 等）；防御性地也接受 string[]（假客户端/旧数据）。
  flags?: Set<string> | string[];
  children?: ListEntry[];
}

// F2: LIST 项是否不可选（\Noselect / \NonExistent）——父级命名空间等
// 不能存邮件的文件夹（如 QQ 的“其他文件夹”）。imapflow 对它
// mailboxOpen 不报错、实际仍停留在上一个文件夹，同步会读错邮箱。
// 注意：QQ 服务器实测返回的是 \NoSelect（大写 S），不是 RFC 标准的
// \Noselect（2026-11-18 线上复核：\NoSelect 拼写致跳过失效，化石行
// 重启后又被插回）。为防各服务商的大小写/拼写变体，按去反斜杠后
// 小写比对。
export function isNonSelectable(entry: ListEntry): boolean {
  const flags = entry.flags;
  if (!flags) return false;
  const norm = (f: string): string => String(f).replace(/^\\/, '').toLowerCase();
  const list: string[] = typeof (flags as Set<string>).has === 'function'
    ? [...(flags as Set<string>)]
    : (Array.isArray(flags) ? (flags as string[]) : [String(flags)]);
  return list.some((f) => norm(f) === 'noselect' || norm(f) === 'nonexistent');
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

// Date 头 -> ISO 字符串，缺失/非法时返回 null（与 engine.ts 的信封路径
// 同款守卫）。mailparser 对非法 Date 头会 fallback 成“现在”，
// 不加守卫时打开的信日期会被写成今天、与信封路径存 null 不一致（R5）。
export function toIsoDate(v: Date | string | undefined | null): string | null {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

// ---- IMAP BODYSTRUCTURE attachment parts (metadata-only downloads) ----
export interface AttachmentPart {
  part: string | null;
  filename: string | null;
  size: number;
  contentType: string;
}

// Walk a bodyStructure tree (imapflow) depth-first (document order) and
// collect attachment parts with their IMAP part numbers ("2", "1.2", ...),
// so a >10 MB attachment can later be streamed live from IMAP by part.
//
// 收集口径必须与 mailparser 的 isAttachment 完全一致（mailparser
// lib/mail-parser.js createNode）：textTypes = ['text/plain',
// 'text/html', 'message/delivery-status']；isAttachment = 类型不在
// textTypes 里，或 disposition（归一化后）不是 'inline'——其中无
// disposition 的非文本部件归一化成 'attachment'，未知 disposition
// 值也归一化成 'attachment'，无 disposition 的文本部件归一化成
// 'inline'。旧版只收 disposition attachment/inline 或带文件名的叶部
// 件，mailparser 却对任何非文本部件都发 attachment 事件——一封带
// Content-Type: application/octet-stream（无 disposition、无 name）
// 部件的信，解析侧附件数组里有它、BODYSTRUCTURE 侧没有它，
// matchAttachmentParts 纯按索引配对，后续附件的 part 号整体错位一位
// （Audit #16 LOW-2）。按 mailparser 同款口径：非文本叶部件全收
// （无文件名时记 null），文本叶部件只在 disposition 为 attachment
// （或未知值）时收；disposition inline 的文本部件是正文，不收。
const MAILPARSER_TEXT_TYPES = new Set(['text/plain', 'text/html', 'message/delivery-status']);
export function collectAttachmentParts(bodyStructure: MessageStructureObject | null | undefined): AttachmentPart[] {
  const out: AttachmentPart[] = [];
  const walk = (node: MessageStructureObject | undefined | null, isRoot = false): void => {
    if (!node) return;
    if (node.childNodes) {
      for (const c of node.childNodes) walk(c);
      return;
    }
    const type = (node.type || '').toLowerCase();
    const rawDisp = (node.disposition || '').toLowerCase();
    // mailparser 同款归一化：未知 disposition 值 → 'attachment'。
    const disp = rawDisp && rawDisp !== 'attachment' && rawDisp !== 'inline' ? 'attachment' : rawDisp;
    const params = { ...(node.parameters || {}), ...(node.dispositionParameters || {}) } as Record<string, string>;
    const filename = params.filename || params.name || null;
    if (!MAILPARSER_TEXT_TYPES.has(type) || disp === 'attachment') {
      out.push({
        // Audit #17 LOW-2：单部件邮件的 BODYSTRUCTURE 根节点没有 part 号；
        // RFC 3501 里单部件正文即 part 1，根节点记 '1' 而不是 null，
        // 否则附件列得出、下载时 !att.part 直接 404。
        part: node.part || (isRoot ? '1' : null),
        filename,
        size: node.size || 0,
        contentType: node.type || 'application/octet-stream',
      });
    }
  };
  walk(bodyStructure, true);
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
// Index-only (same rule as the send path): part[i] belongs to attachment
// [i]. Audit #9 L13：去掉按名回退——byName 找第一个同名 part，会把
// 同名附件 collapse 到同一个 part；缺失时记 part=NULL，调用方在返回里提示。
export function matchAttachmentParts(
  parsedAttachments: ParsedAttachment[],
  parts: AttachmentPart[],
): ParsedAttachment[] {
  return (parsedAttachments || []).map((att, i) => {
    const byIndex = parts?.[i] || null;
    return { ...att, part: byIndex?.part || null };
  });
}

export interface ParsedMessage {
  envelope: {
    messageId: string | null;
    // Audit #10 threading：原信 References 头（mailparser 的
    // parsed.references 可能是 string | string[]），正文拉取时解析后
    // 存 messages.references，GET /api/messages/:id 返回给前端做
    // 回复/转发 threading 用。
    references: string | null;
    // Audit #11 threading：原信 Reply-To 头（单个地址字符串，无则 null），
    // 与 references 同款：解析后存 messages.reply_to，详情接口返回，
    // 前端回复时优先发往 Reply-To。
    replyTo: string | null;
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
