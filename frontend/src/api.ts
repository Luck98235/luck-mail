// API 层：按 API_CONTRACT.md 封装。默认同源（Node 后端 serve dist + /api/*）。
// 本地开发可用 VITE_API_BASE_URL 指向后端（见 vite.config.ts 的 dev proxy）。
import type { Account, Draft, Folder, MessageDetail, MessageEnvelope, Preset, Settings } from './types'

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
  isForm?: boolean
  // 单次请求超时（毫秒），不传默认 30000；refresh-all 等后端要等
  // 全量同步的接口按调用方传更宽的值（见 refreshAll）。
  timeoutMs?: number
  // 超时报错文案：不传用默认“请求超时，请重试”；发信超时要提示
  // “可能已发出”，由调用方传（见 sendMessage/sendMessageJson）。
  timeoutMessage?: string
}

// 401 跳登录去重：多个请求同时 401 时只跳一次（以前并发 replace('/login')
// 会触发两次导航，vue-router 报重复导航；无害但 noisy）。
let loginRedirect: Promise<unknown> | null = null
async function handleUnauthorized(): Promise<void> {
  try {
    const [{ useAuthStore }, routerModule] = await Promise.all([import('./stores/auth'), import('./router')])
    const auth = useAuthStore()
    auth.loggedIn = false
    const router = routerModule.default
    if (router.currentRoute.value.path !== '/login') {
      if (!loginRedirect) loginRedirect = router.replace('/login').finally(() => { loginRedirect = null })
      await loginRedirect
    }
  } catch { /* 跳转失败也不影响本次请求的报错 */ }
}

async function request<T>(path: string, { method = 'GET', body, isForm = false, timeoutMs = 30000, timeoutMessage }: RequestOptions = {}): Promise<T> {
  // 超时：挂起的请求不再无限等，超时按“请重试”报错。
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const opts: RequestInit = { method, credentials: 'include', headers: {}, signal: controller.signal }
  if (body !== undefined) {
    if (isForm) opts.body = body as FormData // FormData：让浏览器自己设 Content-Type（含 boundary）
    else { (opts.headers as Record<string, string>)['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body) }
  }
  try {
    const res = await fetch(BASE + path, opts)
    if (res.status === 401) await handleUnauthorized()
    const text = await res.text()
    let data: unknown = null
    try { data = text ? JSON.parse(text) as unknown : null } catch { data = null }
    const ok = (data as { ok?: boolean } | null)?.ok
    if (!res.ok || ok === false) {
      const err = (data as { error?: string } | null)?.error
      throw new ApiError(res.status, err || `请求失败（HTTP ${res.status}）`, data)
    }
    return (data ?? {}) as T
  } catch (e) {
    if (e instanceof Error && e.name === 'AbortError') throw new ApiError(0, timeoutMessage || '请求超时，请重试', null)
    throw e
  } finally {
    clearTimeout(timer)
  }
}

// 三个文件下载共用：30 秒超时 + 统一的报错与文件名解析。
// method：备份与导出走 POST（防跨站顶层导航 CSRF 触发下载，后端只接受 POST）；
// 导入模板仍走 GET。
async function downloadBlobFile(path: string, failLabel: string, defaultFilename: string, method: 'GET' | 'POST' = 'GET'): Promise<{ blob: Blob; filename: string }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 30000)
  try {
    const res = await fetch(BASE + path, { method, credentials: 'include', signal: controller.signal })
    // 401 也跳登录（审计 #9 L4）：与 request() 一致，会话过期时点导出/备份
    // 回到登录页，而不是只报“导出失败（HTTP 401）”。
    if (res.status === 401) await handleUnauthorized()
    if (!res.ok) {
      let msg = `${failLabel}失败（HTTP ${res.status}）`
      try { const data = await res.json() as { error?: string }; if (data?.error) msg = data.error } catch { /* 非 JSON 报错就用默认文案 */ }
      throw new ApiError(res.status, msg, null)
    }
    const blob = await res.blob()
    const cd = res.headers.get('content-disposition') || ''
    const m = /filename="?([^";]+)"?/.exec(cd)
    return { blob, filename: m ? m[1] : defaultFilename }
  } catch (e) {
    if (e instanceof Error && e.name === 'AbortError') throw new ApiError(0, `${failLabel}超时，请重试`, null)
    throw e
  } finally {
    clearTimeout(timer)
  }
}

export interface AuthStatus { ok: boolean; setupRequired: boolean; loggedIn: boolean; username?: string }
export interface MessagesResponse { ok: boolean; messages: MessageEnvelope[]; total: number }

export const api = {
  // 认证
  authStatus: () => request<AuthStatus>('/api/auth/status'),
  setup: (username: string, password: string, confirm: string) =>
    request<{ ok: boolean }>('/api/auth/setup', { method: 'POST', body: { username, password, confirm } }),
  login: (username: string, password: string, rememberMe?: boolean) =>
    request<{ ok: boolean; username: string }>('/api/auth/login', { method: 'POST', body: { username, password, rememberMe } }),
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
  // refresh-all：后端要等全部账号全量同步完才返回（27 个账号），
  // 30 秒不够，超时放宽到 120 秒（F8）。
  refreshAll: () => request<{ ok: boolean }>('/api/refresh-all', { method: 'POST', timeoutMs: 120000 }),

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
  // 单封删除：彻底删除与否以后端实际文件夹为准（folder.type==='trash'），
  // 客户端 permanent 查询参数已废弃（后端已忽略），不再发（F12c）。
  // 删信幂等键（审计 #6）：每次删除动作生成一个 key 传给后端（body 的
  // idempotencyKey，后端 query/body 都认）；响应丢失后重试同一动作时复用
  // 同一个 key，后端直接返回第一次的结果，不再执行第二次删除——否则一次
  // “移到已删除”重试后会变成永久删除。key 由调用方（store）生成并保管，
  // 这里只负责透传。
  deleteMessage: (id: number | string, idempotencyKey?: string) =>
    request<{ ok: boolean; duplicate?: boolean }>(`/api/messages/${id}`, { method: 'DELETE', body: idempotencyKey ? { idempotencyKey } : undefined }),
  // 批量删除：首次提交异步返回 { ok, taskId, status:'running' }；同一 key 重复提交
  // 返回第一次任务的已有状态（running/finished/unknown，见 messageRoutes 幂等注释），
  // 进度走 getDeleteStatus；请求体不带 permanent（彻底与否以后端实际
  // 文件夹为准，后端忽略该字段）。同步返回分支仅作防御兼容。
  // 删信幂等键（审计 #6）：与单删同一字段、同一语义——同一 key 重复提交时
  // 后端直接返回第一次的 taskId，不另起任务、不重复删。
  batchDeleteMessages: (ids: Array<number | string>, view?: { kind: string; accountId: number | null; folderId: number | null }, idempotencyKey?: string) =>
    request<{ ok: boolean; deleted?: number[]; failed?: Array<{ id: number; error: string }>; taskId?: string; status?: string; duplicate?: boolean }>('/api/messages/batch-delete', { method: 'POST', body: { ids, view, ...(idempotencyKey ? { idempotencyKey } : {}) } }),
  // 批量删除任务状态：刷新/切页回来后查它，任务未完成时继续显示“删除中…”。
  // view 是发起删除的视图（后端记的），刷新后靠它只在该视图显示删除中。
  // taskId（可选）：本会话发起的异步任务传自己的 taskId，避免两标签页
  // 同时批量删除时轮询到对方的任务；不传时后端返回最近一个任务（兼容）。
  // deleted 为数字计数（已删封数）；failed 为失败明细；finishedAt 为完成时间。
  getDeleteStatus: (taskId?: string) =>
    request<{ ok: boolean; running: boolean; total: number; deleted: number; startedAt: number; view: { kind: string; accountId: number | null; folderId: number | null } | null; taskId?: string; failed?: Array<{ id: number; error: string }>; finishedAt?: string }>(taskId ? `/api/messages/delete-status?taskId=${encodeURIComponent(taskId)}` : '/api/messages/delete-status'),
  // 正文翻译：英文 → 中文（后端调免费翻译接口），返回译文纯文本。
  translateMessage: (id: number | string) =>
    request<{ ok: boolean; translated: string; alreadyChinese: boolean }>(`/api/messages/${id}/translate`, { method: 'POST' }),
  // 发信返回：id 是本地已发送记录 id（有则前端据此打开）；
  // rejected 是被收件方服务器拒收的收件人；warning 表示已发出但未存入已发送文件夹。
  // 超时 120 秒：后端一次发信可能耗时 50 秒以上（SMTP 超时 15+15+30 秒 +
  // 4xx 重试 5 秒 + APPEND），30 秒会误报失败；超时文案提示“可能已发出”，
  // 让用户先去已发送核对再重发，避免重复发信（审计 #5）。
  sendMessage: (formData: FormData) =>
    request<{ ok: boolean; id: number; messageId: string; rejected?: string[]; warning?: string }>('/api/messages/send', { method: 'POST', body: formData, isForm: true, timeoutMs: 120000, timeoutMessage: '发送超时，邮件可能已发出，请先到已发送查看再重发' }),
  sendMessageJson: (payload: Record<string, unknown>) =>
    request<{ ok: boolean; id: number; messageId: string; rejected?: string[]; warning?: string }>('/api/messages/send', { method: 'POST', body: payload, timeoutMs: 120000, timeoutMessage: '发送超时，邮件可能已发出，请先到已发送查看再重发' }),
  // 草稿（服务端，2026-11-18 用户定夺：草稿进数据库，不再写 localStorage）
  listDrafts: () => request<{ ok: boolean; drafts: Draft[] }>('/api/drafts'),
  createDraft: (payload: { accountId: number | null; to: string; subject: string; text: string; idempotencyKey?: string }) =>
    request<{ ok: boolean; draft: Draft }>('/api/drafts', { method: 'POST', body: payload }),
  updateDraft: (id: number | string, payload: { accountId?: number | null; to?: string; subject?: string; text?: string }) =>
    request<{ ok: boolean; draft: Draft }>(`/api/drafts/${encodeURIComponent(String(id))}`, { method: 'PUT', body: payload }),
  deleteDraft: (id: number | string) =>
    request<{ ok: boolean }>(`/api/drafts/${encodeURIComponent(String(id))}`, { method: 'DELETE' }),

  // 设置
  settings: () => request<{ ok: boolean; settings: Settings }>('/api/settings'),
  updateSettings: (payload: Settings) => request<{ ok: boolean }>('/api/settings', { method: 'PUT', body: payload }),

  // 备份到本地：下载 tar.gz（.key + data/），文件名从 Content-Disposition 取。
  // 文件下载走 blob，不走 request()（那是 JSON 的）。
  // POST：后端只接受 POST（防跨站顶层导航 CSRF 触发下载，审计 #5 安全轨 S1）。
  downloadBackup: () => downloadBlobFile('/api/backup/download', '备份', 'luck-mail-backup.tar.gz', 'POST'),
  // 导出全部邮箱为 Excel（.xlsx）：文件名从 Content-Disposition 取。
  // POST：与备份同理，后端只接受 POST。
  exportAccounts: () => downloadBlobFile('/api/accounts/export', '导出', 'luck-mail-accounts.xlsx', 'POST'),
  // 下载导入模板：空的 .csv，只有表头一行。
  downloadImportTemplate: () => downloadBlobFile('/api/accounts/import-template', '下载', 'luck-mail-import-template.csv'),
  // 批量导入邮箱：走统一 request()（5 分钟 AbortController 超时 + 401 处理），
  // 后端逐行先测连通再建账号，一行约 1-4 秒，行数多时 30 秒默认超时不够用；
  // 超时后已导入的邮箱已保存，重复的行下次会跳过。
  importAccounts: async (file: File): Promise<{ added: number; skipped: number; failed: { row: number; email: string; reason: string }[]; addedEmails: string[]; skippedEmails: string[] }> => {
    const fd = new FormData()
    fd.append('file', file)
    const data = await request<{ ok: boolean; added?: number; skipped?: number; failed?: { row: number; email: string; reason: string }[]; addedEmails?: string[]; skippedEmails?: string[] }>('/api/accounts/import', { method: 'POST', body: fd, isForm: true, timeoutMs: 5 * 60 * 1000, timeoutMessage: '导入超时，请重试（已导入的邮箱已保存，重复的行下次会跳过）' })
    return { added: data.added || 0, skipped: data.skipped || 0, failed: data.failed || [], addedEmails: data.addedEmails || [], skippedEmails: data.skippedEmails || [] }
  },
}
