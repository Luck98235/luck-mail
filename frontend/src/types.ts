// 与 API_CONTRACT.md 对齐的共享类型（前端/后端契约形状）

export type SecureKind = 'SSL' | 'STARTTLS'
export type AccountStatus = 'online' | 'offline' | 'error' | 'syncing'
export type FolderType = 'inbox' | 'sent' | 'drafts' | 'trash' | 'spam' | 'other'

export interface Account {
  id: number
  email: string
  displayName: string
  imapHost: string
  imapPort: number
  imapSecure: SecureKind
  smtpHost: string
  smtpPort: number
  smtpSecure: SecureKind
  enabled: boolean
  sortOrder: number
  status: AccountStatus
  unreadCount: number
  lastSyncAt?: string
  error?: string
}

export interface Folder {
  id: number
  accountId: number
  path: string
  name: string
  type: FolderType
  unreadCount: number
  totalCount: number
}

export interface Attachment {
  id: number | string
  filename: string
  size: number
  contentType: string
  /** 恒为 false（历史字段，仅兼容） */
  large?: boolean
}

export interface MessageEnvelope {
  id: number | string
  accountId: number
  accountEmail: string
  folderId: number | null
  folderPath: string
  uid: number
  subject: string
  from: string
  fromName: string
  to: string[]
  date: string
  snippet: string
  isRead: boolean
  hasAttachments: boolean
  size: number
  /** 服务端草稿行（GET /api/drafts 来的，不是服务端邮件） */
  isDraft?: boolean
}

export interface MessageDetail extends MessageEnvelope {
  cc: string[]
  bodyText: string
  bodyHtml: string
  attachments: Attachment[]
}

export interface Preset {
  imapHost: string
  imapPort: number
  imapSecure: SecureKind
  smtpHost: string
  smtpPort: number
  smtpSecure: SecureKind
  note?: string
}

export interface Settings {
  signature?: string
  defaultAccountId?: number | null
}

export type AggregateKind = 'all-inbox' | 'all-unread' | 'all-drafts' | 'all-sent' | 'all-trash'
export type ViewKind = AggregateKind | 'folder'

export interface ViewState {
  kind: ViewKind
  label: string
  accountId: number | null
  folderId: number | null
}

/** 服务端草稿（GET /api/drafts；2026-11-18 用户定夺：草稿进数据库） */
export interface Draft {
  id: number | string
  accountId: number | null
  to: string
  subject: string
  text: string
  updatedAt: string
  /** 发信幂等键：创建时传或服务端生成；PUT 不改它 */
  idempotencyKey?: string
}

/** Socket.io 服务端 → 客户端事件（契约） */
export type RealtimeEvent =
  | { type: 'new-mail'; accountId: number; folderId: number; message: MessageEnvelope }
  | { type: 'mail-updated'; messageId: number | string; accountId?: number; folderId?: number; changes: { isRead?: boolean; folderId?: number } }
  | { type: 'mail-deleted'; messageId: number | string }
  | { type: 'sync'; accountId: number; folderId?: number; state: 'started' | 'done' | 'error'; error?: string; authFailed?: boolean }
  | { type: 'account'; action: 'added' | 'removed' | 'updated'; account: Account }
  | { type: 'ping' }
