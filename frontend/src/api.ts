// API 层：按 API_CONTRACT.md 封装。默认同源（Node 后端 serve dist + /api/*）。
// 本地开发可用 VITE_API_BASE_URL 指向后端（见 vite.config.ts 的 dev proxy）。
import type { Account, Attachment, Folder, MessageDetail, MessageEnvelope, Preset, Settings } from './types'

const BASE: string = import.meta.env.VITE_API_BASE_URL || ''

export class ApiError extends Error {
  status: number
  body: unknown
  constructor(status: number, message: string, body: unknown) {
    super(message)
    this.status = status
    this.body = body
  }
}

interface RequestOptions {
  method?: string
  body?: unknown
  headers?: Record<string, string>
  isForm?: boolean
}

async function request<T>(path: string, { method = 'GET', body, headers = {}, isForm = false }: RequestOptions = {}): Promise<T> {
  const opts: RequestInit = { method, credentials: 'include', headers: { ...headers } }
  if (body !== undefined) {
    if (isForm) opts.body = body as FormData // FormData：让浏览器自己设 Content-Type（含 boundary）
    else { (opts.headers as Record<string, string>)['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body) }
  }
  const res = await fetch(BASE + path, opts)
  const text = await res.text()
  let data: unknown = null
  try { data = text ? JSON.parse(text) as unknown : null } catch { data = null }
  const ok = (data as { ok?: boolean } | null)?.ok
  if (!res.ok || ok === false) {
    const err = (data as { error?: string } | null)?.error
    throw new ApiError(res.status, err || `请求失败（HTTP ${res.status}）`, data)
  }
  return (data ?? {}) as T
}

export interface AuthStatus { ok: boolean; setupRequired: boolean; loggedIn: boolean; username?: string }
export interface MessagesResponse { ok: boolean; messages: MessageEnvelope[]; total: number }

export const api = {
  // 认证
  authStatus: () => request<AuthStatus>('/api/auth/status'),
  setup: (username: string, password: string, confirm: string) =>
    request<{ ok: boolean }>('/api/auth/setup', { method: 'POST', body: { username, password, confirm } }),
  login: (username: string, password: string) =>
    request<{ ok: boolean; username: string }>('/api/auth/login', { method: 'POST', body: { username, password } }),
  logout: () => request<{ ok: boolean }>('/api/auth/logout', { method: 'POST' }),
  changePassword: (current: string, next: string) =>
    request<{ ok: boolean }>('/api/auth/change-password', { method: 'POST', body: { current, next } }),
  changeUsername: (username: string) =>
    request<{ ok: boolean; username: string }>('/api/auth/change-username', { method: 'POST', body: { username } }),

  // 预设
  presets: () => request<{ ok: boolean; presets: Record<string, Preset> }>('/api/presets'),
  preset: (domain: string) =>
    request<{ ok: boolean; preset: Preset | null; note?: string; imapHost?: string; imapPort?: number; imapSecure?: string; smtpHost?: string; smtpPort?: number; smtpSecure?: string }>(
      `/api/presets/${encodeURIComponent(domain)}`
    ),

  // 账号
  accounts: () => request<{ ok: boolean; accounts: Account[] }>('/api/accounts'),
  createAccount: (payload: Record<string, unknown>) =>
    request<{ ok: boolean; account: Account }>('/api/accounts', { method: 'POST', body: payload }),
  updateAccount: (id: number, payload: Record<string, unknown>) =>
    request<{ ok: boolean }>(`/api/accounts/${id}`, { method: 'PUT', body: payload }),
  // 取单个邮箱的当前密码（明文）：仅供“邮箱设置”弹窗回填密码框，点小眼睛查看。
  getAccountPassword: (id: number) =>
    request<{ ok: boolean; password: string }>(`/api/accounts/${id}/password`),
  deleteAccount: (id: number) => request<{ ok: boolean }>(`/api/accounts/${id}`, { method: 'DELETE' }),
  testAccount: (id: number) =>
    request<{ ok: boolean; imapOk: boolean; smtpOk: boolean; error?: string }>(`/api/accounts/${id}/test`, { method: 'POST' }),
  refreshAccount: (id: number) => request<{ ok: boolean }>(`/api/accounts/${id}/refresh`, { method: 'POST' }),
  refreshAll: () => request<{ ok: boolean }>('/api/refresh-all', { method: 'POST' }),

  // 文件夹
  folders: (accountId: number) => request<{ ok: boolean; folders: Folder[] }>(`/api/accounts/${accountId}/folders`),

  // 邮件
  messages: ({ view, accountId, folderId, q, limit = 50, offset = 0 }: {
    view?: string; accountId?: number | null; folderId?: number | null; q?: string; limit?: number; offset?: number
  } = {}) => {
    const p = new URLSearchParams()
    if (view) p.set('view', view)
    if (accountId) p.set('accountId', String(accountId))
    if (folderId) p.set('folderId', String(folderId))
    if (q) p.set('q', q)
    p.set('limit', String(limit))
    p.set('offset', String(offset))
    return request<MessagesResponse>(`/api/messages?${p.toString()}`)
  },
  message: (id: number | string) => request<{ ok: boolean; message: MessageDetail }>(`/api/messages/${id}`),
  setRead: (id: number | string, read: boolean) =>
    request<{ ok: boolean }>(`/api/messages/${id}/read`, { method: 'POST', body: { read } }),
  moveMessage: (id: number | string, folderId: number) =>
    request<{ ok: boolean }>(`/api/messages/${id}/move`, { method: 'POST', body: { folderId } }),
  deleteMessage: (id: number | string, permanent = false) =>
    request<{ ok: boolean }>(`/api/messages/${id}${permanent ? '?permanent=true' : ''}`, { method: 'DELETE' }),
  batchDeleteMessages: (ids: Array<number | string>, permanent = false, view?: { kind: string; accountId: number | null; folderId: number | null }) =>
    request<{ ok: boolean; deleted: number[]; failed: Array<{ id: number; error: string }> }>('/api/messages/batch-delete', { method: 'POST', body: { ids, permanent, view } }),
  // 批量删除任务状态：刷新/切页回来后查它，任务未完成时继续显示“删除中…”。
  // view 是发起删除的视图（后端记的），刷新后靠它只在该视图显示删除中。
  getDeleteStatus: () =>
    request<{ ok: boolean; running: boolean; total: number; deleted: number; startedAt: number; view: { kind: string; accountId: number | null; folderId: number | null } | null }>('/api/messages/delete-status'),
  // 正文翻译：英文 → 中文（后端调免费翻译接口），返回译文纯文本。
  translateMessage: (id: number | string) =>
    request<{ ok: boolean; translated: string; alreadyChinese: boolean }>(`/api/messages/${id}/translate`, { method: 'POST' }),
  sendMessage: (formData: FormData) =>
    request<{ ok: boolean; id: number; messageId: string }>('/api/messages/send', { method: 'POST', body: formData, isForm: true }),
  sendMessageJson: (payload: Record<string, unknown>) =>
    request<{ ok: boolean; id: number; messageId: string }>('/api/messages/send', { method: 'POST', body: payload }),
  search: ({ q, limit = 50, offset = 0 }: { q: string; limit?: number; offset?: number }) => {
    const p = new URLSearchParams({ q, limit: String(limit), offset: String(offset) })
    return request<MessagesResponse>(`/api/search?${p.toString()}`)
  },

  // 状态 / 设置
  status: () => request<{ ok: boolean; accounts: Array<{ id: number; email: string; status: string; lastSyncAt?: string; error?: string }>; serverTime: string }>('/api/status'),
  settings: () => request<{ ok: boolean; settings: Settings }>('/api/settings'),
  updateSettings: (payload: Settings) => request<{ ok: boolean }>('/api/settings', { method: 'PUT', body: payload }),

  // 备份到本地：下载 tar.gz（.key + data/），文件名从 Content-Disposition 取。
  // 文件下载走 blob，不走 request()（那是 JSON 的）。
  downloadBackup: async (): Promise<{ blob: Blob; filename: string }> => {
    const res = await fetch(BASE + '/api/backup/download', { credentials: 'include' })
    if (!res.ok) {
      let msg = `备份失败（HTTP ${res.status}）`
      try { const data = await res.json() as { error?: string }; if (data?.error) msg = data.error } catch { /* 非 JSON 报错就用默认文案 */ }
      throw new ApiError(res.status, msg, null)
    }
    const blob = await res.blob()
    const cd = res.headers.get('content-disposition') || ''
    const m = /filename="?([^";]+)"?/.exec(cd)
    return { blob, filename: m ? m[1] : 'luck-mail-backup.tar.gz' }
  },
  // 导出全部邮箱为 Excel（.xlsx）：文件名从 Content-Disposition 取。
  exportAccounts: async (): Promise<{ blob: Blob; filename: string }> => {
    const res = await fetch(BASE + '/api/accounts/export', { credentials: 'include' })
    if (!res.ok) {
      let msg = `导出失败（HTTP ${res.status}）`
      try { const data = await res.json() as { error?: string }; if (data?.error) msg = data.error } catch { /* 非 JSON 报错就用默认文案 */ }
      throw new ApiError(res.status, msg, null)
    }
    const blob = await res.blob()
    const cd = res.headers.get('content-disposition') || ''
    const m = /filename="?([^";]+)"?/.exec(cd)
    return { blob, filename: m ? m[1] : 'luck-mail-accounts.xlsx' }
  },
  // 下载导入模板：空的 .xlsx，只有表头一行。
  downloadImportTemplate: async (): Promise<{ blob: Blob; filename: string }> => {
    const res = await fetch(BASE + '/api/accounts/import-template', { credentials: 'include' })
    if (!res.ok) {
      let msg = `下载失败（HTTP ${res.status}）`
      try { const data = await res.json() as { error?: string }; if (data?.error) msg = data.error } catch { /* 非 JSON 报错就用默认文案 */ }
      throw new ApiError(res.status, msg, null)
    }
    const blob = await res.blob()
    const cd = res.headers.get('content-disposition') || ''
    const m = /filename="?([^";]+)"?/.exec(cd)
    return { blob, filename: m ? m[1] : 'luck-mail-import-template.xlsx' }
  },
  // 批量导入邮箱：上传填好的导入模板（.xlsx）。同名邮箱跳过。
  importAccounts: async (file: File): Promise<{ added: number; skipped: number; failed: { row: number; email: string; reason: string }[]; addedEmails: string[]; skippedEmails: string[] }> => {
    const fd = new FormData()
    fd.append('file', file)
    const res = await fetch(BASE + '/api/accounts/import', { method: 'POST', body: fd, credentials: 'include' })
    const data = await res.json() as { ok?: boolean; error?: string; added?: number; skipped?: number; failed?: { row: number; email: string; reason: string }[]; addedEmails?: string[]; skippedEmails?: string[] }
    if (!res.ok || !data.ok) throw new ApiError(res.status, data?.error || `导入失败（HTTP ${res.status}）`, null)
    return { added: data.added || 0, skipped: data.skipped || 0, failed: data.failed || [], addedEmails: data.addedEmails || [], skippedEmails: data.skippedEmails || [] }
  },
}

export type { Attachment }
