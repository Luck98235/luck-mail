import { defineStore } from 'pinia'
import { ref, reactive, computed, watch } from 'vue'
import { api } from '../api'
import { createRealtime } from '../realtime'
import type {
  Account, AggregateKind, Folder, FolderType, LocalDraft,
  MessageDetail, MessageEnvelope, RealtimeEvent, Settings, ViewState
} from '../types'

// 视图口径（用户 2026-11-17 00:33 最新定）：
// - 聚合视图：所有收件箱/未读/草稿/已发送/已删除 = 全部邮箱合并，调 view=all-*（不带 accountId）。
// - 单邮箱视图：点邮箱列表里的某个邮箱 = 只看该邮箱，调 view=folder + accountId + 该邮箱收件箱 folderId。
// - 点邮箱行：展开文件夹 + 切单邮箱收件箱；点行首 `>`：只展开/折叠，不切视图。
// - 点文件夹：切到该邮箱该文件夹（view=folder + 对应 folderId）。
// 懒加载（用户 2026-11-17 00:42 定）：导航树初始化只加载一级账号名（GET /api/accounts），
// 点某个邮箱的折叠箭头/邮箱行时才要该账号的文件夹（GET /api/accounts/:id/folders）；
// init() 不预加载任何账号的文件夹。

export interface AggregateDef { kind: AggregateKind; label: string; icon: string }

export const AGGREGATES: AggregateDef[] = [
  { kind: 'all-inbox', label: '所有收件箱', icon: 'fa-solid fa-inbox' },
  { kind: 'all-unread', label: '所有未读', icon: 'fa-regular fa-envelope' },
  { kind: 'all-drafts', label: '所有草稿', icon: 'fa-regular fa-file-lines' },
  { kind: 'all-sent', label: '所有已发送', icon: 'fa-regular fa-paper-plane' },
  { kind: 'all-trash', label: '所有已删除', icon: 'fa-regular fa-trash-can' }
]

const FOLDER_ICONS: Record<FolderType, string> = {
  inbox: 'fa-solid fa-inbox',
  drafts: 'fa-regular fa-file-lines',
  sent: 'fa-regular fa-paper-plane',
  trash: 'fa-regular fa-trash-can',
  spam: 'fa-solid fa-ban',
  other: 'fa-regular fa-folder'
}
export function folderIcon(type: FolderType): string { return FOLDER_ICONS[type] || FOLDER_ICONS.other }

const DRAFT_KEY = 'luck-mail-local-drafts'
const VIEW_KEY = 'luck-mail-active-view' // 刷新后恢复上次选中的导航（聚合视图/单邮箱/文件夹）
const PAGE_SIZE = 50

function loadLocalDrafts(): LocalDraft[] {
  try { return JSON.parse(localStorage.getItem(DRAFT_KEY) || '[]') as LocalDraft[] } catch { return [] }
}

export const useMailStore = defineStore('mail', () => {
  // accounts：多邮箱基本信息与连接状态
  const accounts = ref<Account[]>([])
  const foldersByAccount = ref<Record<number, Folder[]>>({}) // 懒加载：只有点开过的账号才有
  const expanded = ref<Set<number>>(new Set()) // 展开文件夹的账号 id
  const view = ref<ViewState>({ kind: 'all-inbox', label: '所有收件箱', accountId: null, folderId: null })
  // 导航持久化（用户 2026-11-17 11:15 要求：刷新后选中的导航不变）：每次切视图就把
  // kind/accountId/folderId 存 localStorage，init() 时再读出来恢复；label 不用存，
  // 恢复时按 kind/accountId/folderId 重新算。
  function saveView(): void {
    try {
      localStorage.setItem(VIEW_KEY, JSON.stringify({ kind: view.value.kind, accountId: view.value.accountId, folderId: view.value.folderId }))
    } catch { /* 存不下就下次默认回所有收件箱 */ }
  }
  watch(view, saveView)
  // activeAccountId / activeFolder：当前点的左栏邮箱与文件夹（与 view 同步；聚合视图时为 null）
  const activeAccountId = ref<number | null>(null)
  const activeFolder = ref<Folder | null>(null)
  // mailList：缓存当前列表中的邮件，避免频繁向 Node 发起请求
  const mailList = ref<MessageEnvelope[]>([])
  const total = ref<number>(0)
  const loading = ref<boolean>(false)
  const page = ref<number>(1) // 当前页（1 起）；每页 50 条，后端按页拉取，不一次全拉
  const searchQuery = ref<string>('')
  const selectedId = ref<number | string | null>(null)
  const selectedMessage = ref<MessageDetail | null>(null)
  const checkedIds = ref<Set<number | string>>(new Set()) // 批量选择：已勾选的邮件 id（复选框）
  const batchDeleting = ref<boolean>(false)
  const deleteRemaining = ref<number>(0) // 批量删除剩余待删数（后端 total - deleted，按钮上显示“删除中（N）”）
  // 删除中提示只属于“发起删除的那个视图”（用户 2026-11-17 11:21 要求：在已删除里删，
  // 切到收件箱就不应再显示删除中、列表也不锁）。deleteView 记下发起时的视图，
  // 存 localStorage 供刷新后恢复；切到别的视图时 isDeletingHere 为 false。
  const DELETE_VIEW_KEY = 'luck-mail-delete-view'
  const deleteView = ref<{ kind: string; accountId: number | null; folderId: number | null } | null>(null)
  // deleteView 已知时只在发起删除的视图显示；deleteView 为空（刷新后恢复失败）时退回
  // 全局 batchDeleting——导航恢复会把用户带回删除时的视图，提示不应因此丢失。
  const isDeletingHere = computed(() => {
    if (!batchDeleting.value) return false
    if (deleteView.value === null) return true
    return view.value.kind === deleteView.value.kind
      && view.value.accountId === deleteView.value.accountId
      && view.value.folderId === deleteView.value.folderId
  })
  function saveDeleteView(): void {
    try {
      if (deleteView.value) localStorage.setItem(DELETE_VIEW_KEY, JSON.stringify(deleteView.value))
      else localStorage.removeItem(DELETE_VIEW_KEY)
    } catch { /* 存不下就当没记，刷新后按全局 batchDeleting 显示 */ }
  }
  function loadDeleteView(): void {
    if (deleteView.value) return
    try {
      const saved = JSON.parse(localStorage.getItem(DELETE_VIEW_KEY) || 'null')
      if (saved && typeof saved.kind === 'string') deleteView.value = saved
    } catch { /* 读不到就当没记 */ }
  }
  let deleteStatusTimer: ReturnType<typeof setInterval> | null = null
  // 启动删除状态轮询（1.5 秒一次）：deleteChecked 里删除开始时调一次，
  // init 里刷新回来时由 syncDeleteStatus 调一次；跑完由 syncDeleteStatus 停掉。
  function startDeletePolling(): void {
    if (!deleteStatusTimer) {
      deleteStatusTimer = setInterval(() => { void syncDeleteStatus() }, 1500)
    }
  }
  // 查后端批量删除任务状态：刷新/切页回来后，任务未完成时继续显示“删除中…”。
  // 任务还在跑就每 1.5 秒轮询一次，跑完停掉轮询并刷新列表。
  // deleteView 刷新后从 localStorage 恢复：只在发起删除的视图显示删除中。
  async function syncDeleteStatus(): Promise<void> {
    try {
      const st = await api.getDeleteStatus()
      if (st.running) {
        batchDeleting.value = true
        // 恢复发起删除的视图：以后端 delete-status 里记的 view 为准（刷新后也准），
        // 后端没记时再用 localStorage 里的 deleteView 兜底。
        if (st.view && typeof st.view.kind === 'string') {
          deleteView.value = { kind: st.view.kind, accountId: st.view.accountId ?? null, folderId: st.view.folderId ?? null }
          saveDeleteView()
        } else {
          loadDeleteView()
        }
        deleteRemaining.value = Math.max(0, (st.total || 0) - (st.deleted || 0))
        startDeletePolling()
      } else {
        if (batchDeleting.value) {
          batchDeleting.value = false
          deleteRemaining.value = 0
          deleteView.value = null
          saveDeleteView()
          await loadMessages()
        }
        if (deleteStatusTimer) { clearInterval(deleteStatusTimer); deleteStatusTimer = null }
      }
    } catch { /* 状态查不到就当没在删，不阻塞列表 */ }
  }
  const readingLoading = ref<boolean>(false)
  const refreshingAll = ref<boolean>(false)
  const refreshingAccounts = ref<Set<number>>(new Set())
  const settings = ref<Settings>({ signature: '', defaultAccountId: null })
  const localDrafts = ref<LocalDraft[]>(loadLocalDrafts())
  const composeDraft = ref<LocalDraft | null>(null) // 点本地草稿时，交给写信弹窗回填
  const toast = ref<string>('')
  // 页内确认框：替代浏览器原生 window.confirm（太难看），由 ConfirmModal 渲染。
  // requestConfirm 返回 Promise，点确定 resolve(true)、点取消 resolve(false)。
  const confirmRequest = ref<{ message: string; danger: boolean; resolve: (ok: boolean) => void } | null>(null)
  function requestConfirm(message: string, danger = false): Promise<boolean> {
    return new Promise<boolean>((resolve) => { confirmRequest.value = { message, danger, resolve } })
  }
  function resolveConfirm(ok: boolean): void {
    const req = confirmRequest.value
    confirmRequest.value = null
    req?.resolve(ok)
  }

  // unreadCounts：响应式 Map，实时统计各账号未读角标。
  // 键：'total' | `account:${id}` | `folder:${accountId}:${folderId}`。
  // 由 Socket.io 事件与本地操作（删信/标已读/未读/收新邮件）驱动更新；
  // 导航树红色角标直接绑定它。不轮询、不整页刷新、不重新拉全量。
  const unreadCounts = reactive(new Map<string, number>())

  function rebuildUnreadCounts(): void {
    unreadCounts.clear()
    let total = 0
    for (const a of accounts.value) {
      unreadCounts.set(`account:${a.id}`, a.unreadCount || 0)
      total += a.unreadCount || 0
    }
    for (const [accountId, folders] of Object.entries(foldersByAccount.value)) {
      for (const f of folders) unreadCounts.set(`folder:${accountId}:${f.id}`, f.unreadCount || 0)
    }
    unreadCounts.set('total', total)
  }

  // 单条未读数增减（读信/删信/新邮件时调用），同步回 accounts[] 保持一致
  function bumpUnread(accountId: number | null | undefined, folderId: number | null | undefined, delta: number): void {
    if (!accountId || !delta) return
    const set = (key: string, d: number): void => { unreadCounts.set(key, Math.max(0, (unreadCounts.get(key) || 0) + d)) }
    set('total', delta)
    set(`account:${accountId}`, delta)
    if (folderId != null) set(`folder:${accountId}:${folderId}`, delta)
    const acct = accounts.value.find((a) => a.id === accountId)
    if (acct) acct.unreadCount = unreadCounts.get(`account:${accountId}`) || 0
  }

  function unreadOfAccount(accountId: number): number { return unreadCounts.get(`account:${accountId}`) || 0 }
  function unreadOfFolder(accountId: number, folderId: number): number { return unreadCounts.get(`folder:${accountId}:${folderId}`) || 0 }

  // 手机/平板 QQ 式三级视图：home（账号总览）/ account（邮箱内列表）/ read（阅读窗）
  const mview = ref<'home' | 'account' | 'read'>('home')
  const mobileAccountId = ref<number | null>(null)
  const drawerOpen = ref<boolean>(false)

  const totalUnread = computed<number>(() => unreadCounts.get('total') || 0)
  const totalPages = computed<number>(() => Math.max(1, Math.ceil(total.value / PAGE_SIZE)))
  const checkedCount = computed<number>(() => checkedIds.value.size)
  const isAllChecked = computed<boolean>(() => mailList.value.length > 0 && mailList.value.every((m) => checkedIds.value.has(m.id)))
  const isSomeChecked = computed<boolean>(() => checkedIds.value.size > 0 && !isAllChecked.value)
  const currentAccount = computed<Account | null>(() => accounts.value.find((a) => a.id === view.value.accountId) || null)
  const mobileAccount = computed<Account | null>(() => accounts.value.find((a) => a.id === mobileAccountId.value) || null)
  const isTrashView = computed<boolean>(() => {
    if (view.value.kind === 'all-trash') return true
    if (view.value.kind !== 'folder') return false
    const folders = foldersByAccount.value[view.value.accountId ?? -1] || []
    return folders.find((f) => f.id === view.value.folderId)?.type === 'trash'
  })

  let toastTimer: ReturnType<typeof setTimeout> | null = null
  function showToast(msg: string, ms = 2500): void {
    toast.value = msg
    if (toastTimer) clearTimeout(toastTimer)
    toastTimer = setTimeout(() => { toast.value = '' }, ms)
  }

  function persistLocalDrafts(): void {
    try { localStorage.setItem(DRAFT_KEY, JSON.stringify(localDrafts.value)) } catch { /* 忽略 */ }
  }

  async function loadAccounts(): Promise<void> {
    try {
      const data = await api.accounts()
      accounts.value = data.accounts || []
      rebuildUnreadCounts()
    } catch { /* 列表为空时静默失败，由界面空态提示 */ }
  }

  async function loadSettings(): Promise<void> {
    try {
      const data = await api.settings()
      settings.value = { ...settings.value, ...(data.settings || {}) }
    } catch { /* 忽略 */ }
  }

  async function loadFolders(accountId: number, force = false): Promise<Folder[]> {
    if (!force && foldersByAccount.value[accountId]) return foldersByAccount.value[accountId]
    try {
      const data = await api.folders(accountId)
      foldersByAccount.value = { ...foldersByAccount.value, [accountId]: data.folders || [] }
      // 只更新该账号的文件夹级未读数；账号级/总数不动，避免用旧快照冲掉
      // Socket.io 事件刚加上的未读增量（账号级计数以 loadAccounts 的全量快照为准）。
      // 取 max 兜底：服务端计数若比本地事件驱动值落后一拍，不把角标冲回去。
      for (const f of foldersByAccount.value[accountId]) {
        const key = `folder:${accountId}:${f.id}`
        unreadCounts.set(key, Math.max(unreadCounts.get(key) || 0, f.unreadCount || 0))
      }
      return foldersByAccount.value[accountId]
    } catch {
      return foldersByAccount.value[accountId] || []
    }
  }

  function inboxFolderId(accountId: number): number | null {
    const folders = foldersByAccount.value[accountId] || []
    return folders.find((f) => f.type === 'inbox')?.id ?? folders[0]?.id ?? null
  }

  // ---- 视图切换 ----
  async function setAggregate(kind: AggregateKind): Promise<void> {
    const agg = AGGREGATES.find((a) => a.kind === kind) || AGGREGATES[0]
    view.value = { kind: agg.kind, label: agg.label, accountId: null, folderId: null }
    activeAccountId.value = null
    activeFolder.value = null
    searchQuery.value = ''
    selectedId.value = null
    selectedMessage.value = null
    page.value = 1
    if (window.innerWidth < 1024) mview.value = 'account'
    await loadMessages()
  }

  async function setFolderView(accountId: number, folder: Folder | null): Promise<void> {
    view.value = {
      kind: 'folder',
      label: folder ? `${accountLabel(accountId)} - ${folder.name}` : accountLabel(accountId),
      accountId,
      folderId: folder ? folder.id : null
    }
    activeAccountId.value = accountId
    activeFolder.value = folder || null
    searchQuery.value = ''
    selectedId.value = null
    selectedMessage.value = null
    mobileAccountId.value = accountId
    page.value = 1
    if (window.innerWidth < 1024) mview.value = 'account'
    await loadMessages()
  }

  // 移动端“未读邮件”页签：只看当前账号的未读（view=all-unread + accountId）
  async function setAccountUnread(accountId: number): Promise<void> {
    view.value = { kind: 'all-unread', label: '未读邮件', accountId, folderId: null }
    activeAccountId.value = accountId
    activeFolder.value = null
    searchQuery.value = ''
    selectedId.value = null
    selectedMessage.value = null
    mobileAccountId.value = accountId
    if (window.innerWidth < 1024) mview.value = 'account'
    await loadMessages()
  }

  // 点邮箱行：未展开时展开文件夹 + 切单邮箱收件箱视图；已展开时再点则折叠（不切视图、不重载）
  async function selectAccount(accountId: number): Promise<void> {
    if (expanded.value.has(accountId)) {
      const next = new Set(expanded.value)
      next.delete(accountId)
      expanded.value = next
      return
    }
    expanded.value = new Set(expanded.value).add(accountId)
    await loadFolders(accountId)
    const fid = inboxFolderId(accountId)
    const inbox = (foldersByAccount.value[accountId] || []).find((f) => f.id === fid) || null
    // 顶部标题带上文件夹名（与点文件夹时一致），否则只显示邮箱、看不出是收件夹。
    view.value = { kind: 'folder', label: inbox ? `${accountLabel(accountId)} - ${inbox.name}` : accountLabel(accountId), accountId, folderId: fid }
    activeAccountId.value = accountId
    activeFolder.value = inbox
    searchQuery.value = ''
    selectedId.value = null
    selectedMessage.value = null
    mobileAccountId.value = accountId
    if (window.innerWidth < 1024) mview.value = 'account'
    await loadMessages()
  }

  // 点行首 `>`：只展开/折叠，不切视图（懒加载：展开时才要文件夹）
  async function toggleAccountExpand(accountId: number): Promise<void> {
    const next = new Set(expanded.value)
    if (next.has(accountId)) next.delete(accountId)
    else {
      next.add(accountId)
      await loadFolders(accountId)
    }
    expanded.value = next
  }

  // 刷新后恢复上次选中的导航：聚合视图直接切；单邮箱/文件夹视图先按需加载该账号
  // 文件夹再切，并把该账号在左栏展开；存的账号/文件夹已不存在时回落到所有收件箱。
  async function restoreView(): Promise<void> {
    let saved: { kind?: string; accountId?: number | null; folderId?: number | null } | null = null
    try { saved = JSON.parse(localStorage.getItem(VIEW_KEY) || 'null') } catch { saved = null }
    if (!saved || typeof saved.kind !== 'string') { await loadMessages(); return }
    const kind = saved.kind
    if (kind === 'folder' && typeof saved.accountId === 'number') {
      const acct = accounts.value.find((a) => a.id === saved.accountId)
      if (!acct) { await setAggregate('all-inbox'); return }
      await loadFolders(saved.accountId)
      expanded.value = new Set(expanded.value).add(saved.accountId)
      const folders = foldersByAccount.value[saved.accountId] || []
      const folder = (typeof saved.folderId === 'number' ? folders.find((f) => f.id === saved.folderId) : null)
        || folders.find((f) => f.type === 'inbox') || folders[0] || null
      if (!folder) { await setAggregate('all-inbox'); return }
      await setFolderView(saved.accountId, folder)
      return
    }
    if (kind === 'all-unread' && typeof saved.accountId === 'number') {
      const acct = accounts.value.find((a) => a.id === saved.accountId)
      if (!acct) { await setAggregate('all-inbox'); return }
      await setAccountUnread(saved.accountId)
      return
    }
    if (AGGREGATES.some((a) => a.kind === kind)) {
      await setAggregate(kind as AggregateKind)
      return
    }
    await loadMessages()
  }

  function accountLabel(accountId: number | null): string {
    const a = accounts.value.find((x) => x.id === accountId)
    return a ? (a.displayName || a.email) : ''
  }

  function folderLabel(folder: Folder | null): string { return folder ? folder.name : '' }

  // ---- 邮件列表 ----
  function currentFolderType(): FolderType | null {
    if (view.value.kind !== 'folder') return null
    const folders = foldersByAccount.value[view.value.accountId ?? -1] || []
    return folders.find((f) => f.id === view.value.folderId)?.type || null
  }

  function localDraftEnvelopes(): MessageEnvelope[] {
    // 本地草稿只出现在草稿视图里（置顶，带“本地草稿”标记）
    const inDraftsView =
      view.value.kind === 'all-drafts' ||
      (view.value.kind === 'folder' && currentFolderType() === 'drafts')
    if (!inDraftsView) return []
    return localDrafts.value
      .filter((d) => view.value.kind === 'all-drafts' || d.accountId === view.value.accountId)
      .map((d) => ({
        id: d.id, accountId: d.accountId ?? 0, accountEmail: accountLabel(d.accountId),
        folderId: null, folderPath: '', uid: 0,
        subject: d.subject || '（无主题）', from: accountLabel(d.accountId) || '',
        fromName: '', to: d.to ? d.to.split(',').map((s) => s.trim()).filter(Boolean) : [],
        date: d.updatedAt, snippet: (d.text || '').slice(0, 80),
        isRead: true, hasAttachments: false, size: 0, isLocalDraft: true
      }))
  }

  // 分页加载：每页 50 条，后端按 offset/limit 只返回当页，不一次全拉。
  // 切视图/搜索时回到第 1 页；点上一页/下一页时按页拉取并替换列表。
  async function loadMessages({ page: p }: { page?: number } = {}): Promise<void> {
    if (p !== undefined) page.value = Math.max(1, p)
    checkedIds.value = new Set() // 切视图/搜索/翻页时清空批量选择
    // 草稿视图且无后端数据时也允许只显示本地草稿
    if (view.value.kind === 'folder' && !view.value.folderId) {
      mailList.value = localDraftEnvelopes()
      total.value = mailList.value.length
      return
    }
    loading.value = true
    try {
      const params: { view: string; accountId?: number | null; folderId?: number | null; q?: string; limit: number; offset: number } = {
        view: view.value.kind,
        accountId: view.value.accountId,
        folderId: view.value.folderId,
        q: searchQuery.value.trim() || undefined,
        limit: PAGE_SIZE,
        offset: (page.value - 1) * PAGE_SIZE
      }
      // 聚合视图默认不带 accountId/folderId（后端返回全部邮箱合并结果）；
      // 但移动端“某账号的未读”页签会带 accountId（view=all-unread + accountId），
      // folderId 只在 view=folder 时带。
      if (view.value.kind !== 'folder') params.folderId = undefined
      const data = await api.messages(params)
      // 本地草稿只挂在第 1 页顶部；翻到后面几页不带草稿
      const drafts = page.value === 1 ? localDraftEnvelopes() : []
      mailList.value = [...drafts, ...(data.messages || [])]
      total.value = (data.total || 0) + drafts.length
      // “所有未读”视图：以后端返回的未读总数为准对齐角标。事件驱动的计数
      // 若有漂移（比如某封信在别的视图被标已读），点进这个视图就自动纠正，
      // 避免角标显示 1 但列表为空。
      if (view.value.kind === 'all-unread' && !view.value.accountId) {
        unreadCounts.set('total', data.total || 0)
      }
      if (mailList.value.length && !selectedId.value) {
        // 桌面端默认选中第一封；手机端不自动打开，等用户点
        if (window.innerWidth >= 1024) await openMessage(mailList.value[0].id)
      }
    } catch {
      mailList.value = localDraftEnvelopes(); total.value = mailList.value.length
      showToast('邮件列表加载失败，请点刷新重试')
    } finally {
      loading.value = false
    }
  }

  async function goToPage(p: number): Promise<void> {
    const target = Math.min(Math.max(1, p), totalPages.value)
    if (target === page.value && mailList.value.length) return
    await loadMessages({ page: target })
  }
  async function nextPage(): Promise<void> { await goToPage(page.value + 1) }
  async function prevPage(): Promise<void> { await goToPage(page.value - 1) }

  function setSearch(q: string): void {
    searchQuery.value = q
    page.value = 1
    void loadMessages()
  }

  // ---- 读信 ----
  async function openMessage(id: number | string): Promise<void> {
    // 删除中锁定列表：只锁发起删除的那个视图，不许打开查看，等删完再说；别的视图不受影响。
    if (isDeletingHere.value) return
    const local = localDrafts.value.find((d) => d.id === id)
    if (local) { composeDraft.value = { ...local }; return }
    selectedId.value = id
    readingLoading.value = true
    try {
      const data = await api.message(id)
      selectedMessage.value = data.message
      // 打开即标已读（后端 GET 详情已标已读并推 Socket.io 更新；这里同步本地列表与未读数）
      const row = mailList.value.find((m) => m.id === id)
      if (row && !row.isRead) {
        row.isRead = true
        bumpUnread(row.accountId, row.folderId, -1)
      }
    } catch {
      showToast('打开邮件失败')
    } finally {
      readingLoading.value = false
    }
    if (window.innerWidth < 1024) mview.value = 'read'
  }

  async function setRead(id: number | string, read: boolean): Promise<void> {
    try {
      await api.setRead(id, read)
      const row = mailList.value.find((m) => m.id === id)
      if (row && row.isRead !== read) {
        bumpUnread(row.accountId, row.folderId, read ? -1 : 1)
        row.isRead = read
      }
      if (selectedMessage.value?.id === id) selectedMessage.value.isRead = read
    } catch { showToast('标记失败，请重试') }
  }

  async function deleteMessage(id: number | string): Promise<void> {
    try {
      await api.deleteMessage(id, isTrashView.value)
      // 状态同步：mailList 与 unreadCounts 一起即时更新，不重新拉全量
      const row = mailList.value.find((m) => m.id === id)
      if (row && !row.isRead) bumpUnread(row.accountId, row.folderId, -1)
      mailList.value = mailList.value.filter((m) => m.id !== id)
      total.value = Math.max(0, total.value - 1)
      if (selectedId.value === id) { selectedId.value = null; selectedMessage.value = null }
      showToast(isTrashView.value ? '已彻底删除' : '已移到已删除')
    } catch { showToast('删除失败，请重试') }
  }

  // ---- 批量选择与批量删除（复选框 + 全选） ----
  function toggleCheck(id: number | string): void {
    // 删除中锁定列表：只锁发起删除的那个视图，不许勾选；别的视图不受影响。
    if (isDeletingHere.value) return
    const next = new Set(checkedIds.value)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    checkedIds.value = next
  }

  function toggleCheckAll(): void {
    // 删除中锁定列表：只锁发起删除的那个视图，不许全选；别的视图不受影响。
    if (isDeletingHere.value) return
    if (isAllChecked.value) checkedIds.value = new Set()
    else checkedIds.value = new Set(mailList.value.map((m) => m.id))
  }

  function clearChecked(): void { checkedIds.value = new Set() }

  async function deleteChecked(): Promise<void> {
    const ids = [...checkedIds.value]
    if (!ids.length || batchDeleting.value) return
    const permanent = isTrashView.value
    const label = permanent ? '彻底删除' : '移到已删除'
    if (!await requestConfirm(`确定${label}选中的 ${ids.length} 封邮件吗？`, true)) return
    batchDeleting.value = true
    // 记下发起删除的视图：删除中提示与列表锁定只属于这个视图，切到别的视图不受影响。
    deleteView.value = { kind: view.value.kind, accountId: view.value.accountId, folderId: view.value.folderId }
    saveDeleteView()
    try {
      // 本地草稿（id 为 local- 开头的字符串）直接从本地删，不走服务器
      const draftIds = ids.filter((id) => typeof id === 'string')
      const serverIds = ids.filter((id) => typeof id === 'number')
      // 剩余数先按待删的服务端邮件数显示，再由轮询按后端进度更新（15、14、13…）。
      if (serverIds.length > 0) {
        deleteRemaining.value = serverIds.length
        startDeletePolling()
      }
      draftIds.forEach((id) => deleteLocalDraft(id as string))
      let deleted: number[] = []
      let failedCount = 0
      if (serverIds.length) {
        // 把发起删除的视图一并传给后端：刷新后 delete-status 靠它恢复“只在该视图显示删除中”。
        const res = await api.batchDeleteMessages(serverIds, permanent, { kind: view.value.kind, accountId: view.value.accountId, folderId: view.value.folderId })
        deleted = res.deleted || []
        failedCount = (res.failed || []).length
      }
      // 状态同步：从 mailList 移除已删的，未读数即时更新，不重新拉全量
      const removed = mailList.value.filter((m) => deleted.includes(m.id as number) || draftIds.includes(m.id))
      removed.forEach((row) => { if (!row.isRead) bumpUnread(row.accountId, row.folderId, -1) })
      mailList.value = mailList.value.filter((m) => !deleted.includes(m.id as number) && !draftIds.includes(m.id))
      total.value = Math.max(0, total.value - removed.length)
      if (selectedId.value !== null && (deleted.includes(selectedId.value as number) || draftIds.includes(selectedId.value))) {
        selectedId.value = null
        selectedMessage.value = null
      }
      checkedIds.value = new Set()
      const okCount = removed.length
      showToast(failedCount > 0 ? `已删除 ${okCount} 封，${failedCount} 封失败` : (permanent ? `已彻底删除 ${okCount} 封` : `已移到已删除 ${okCount} 封`))
    } catch {
      showToast('批量删除失败，请重试')
    } finally {
      batchDeleting.value = false
      deleteRemaining.value = 0
      deleteView.value = null
      saveDeleteView()
    }
  }

  async function moveToSpam(id: number | string): Promise<void> {
    const msg = mailList.value.find((m) => m.id === id) || selectedMessage.value
    if (!msg) return
    const folders = await loadFolders(msg.accountId)
    const spam = folders.find((f) => f.type === 'spam')
    if (!spam) { showToast('该邮箱没有垃圾邮件文件夹'); return }
    try {
      await api.moveMessage(id, spam.id)
      mailList.value = mailList.value.filter((m) => m.id !== id)
      if (selectedId.value === id) { selectedId.value = null; selectedMessage.value = null }
      showToast('已标记为垃圾邮件')
    } catch { showToast('标记失败，请重试') }
  }

  // ---- 发信 / 草稿 ----
  // 契约里没有“存草稿到服务器”的接口，草稿先存浏览器本地（localStorage），
  // 待后端补 POST /api/drafts 之类接口后改成走服务器。
  function saveLocalDraft({ accountId, to, subject, text, id }: {
    accountId: number | null; to: string; subject: string; text: string; id?: string
  }): void {
    const now = new Date().toISOString()
    if (id) {
      const d = localDrafts.value.find((x) => x.id === id)
      if (d) Object.assign(d, { accountId, to, subject, text, updatedAt: now })
    } else {
      localDrafts.value.unshift({ id: `local-${Date.now()}`, accountId, to, subject, text, updatedAt: now })
    }
    persistLocalDrafts()
    showToast('已存草稿（本地）')
  }

  function deleteLocalDraft(id: string): void {
    localDrafts.value = localDrafts.value.filter((d) => d.id !== id)
    persistLocalDrafts()
  }

  // ---- 刷新 ----
  async function refreshAll(): Promise<void> {
    refreshingAll.value = true
    try {
      await api.refreshAll()
      await Promise.all([loadAccounts(), loadMessages()])
      showToast('已刷新全部邮箱')
    } catch { showToast('刷新失败，请重试') }
    finally { refreshingAll.value = false }
  }

  async function refreshAccount(accountId: number): Promise<void> {
    refreshingAccounts.value = new Set(refreshingAccounts.value).add(accountId)
    try {
      await api.refreshAccount(accountId)
      await loadMessages()
    } catch { showToast('刷新该邮箱失败') }
    finally {
      const next = new Set(refreshingAccounts.value)
      next.delete(accountId)
      refreshingAccounts.value = next
    }
  }

  // ---- 移动端导航 ----
  function goMobileHome(): void { mview.value = 'home'; drawerOpen.value = false }
  function enterMobileAccount(accountId: number): void { void selectAccount(accountId) }
  function setMobileAccount(accountId: number | null): void { mobileAccountId.value = accountId }

  // ---- 实时推送：Socket.io 单连接（契约定稿） ----
  // 前端只与 Node 建一个 Socket.io 连接（src/realtime.ts），不直连 IMAP。
  // 事件驱动 unreadCounts：new-mail 未读+1、mail-updated 按 isRead 变化增减，
  // 删信时未读总数即时减少；导航树红色角标绑定 unreadCounts，即时亮起，
  // 不轮询、不整页刷新、不重新拉全量。
  let realtime: ReturnType<typeof createRealtime> | null = null
  function handleRealtime(msg: RealtimeEvent): void {
    if (!msg || !msg.type) return
    if (msg.type === 'new-mail') {
      const m = msg.message
      if (!m) return
      const inView =
        (view.value.kind === 'all-inbox' && m.folderPath?.includes('INBOX')) ||
        (view.value.kind === 'all-unread' && !m.isRead) ||
        (view.value.kind === 'folder' && m.accountId === view.value.accountId && m.folderId === view.value.folderId)
      // 分页：新邮件只挂在第 1 页顶部；在第 2 页以后时只加总数、不插进当前页
      if (inView && !mailList.value.some((x) => x.id === m.id)) {
        if (page.value === 1) mailList.value.unshift(m)
        total.value += 1
      }
      if (!m.isRead) bumpUnread(msg.accountId, msg.folderId, 1)
    } else if (msg.type === 'mail-updated') {
      const row = mailList.value.find((m) => m.id === msg.messageId)
      if (row && msg.changes && typeof msg.changes.isRead === 'boolean' && row.isRead !== msg.changes.isRead) {
        bumpUnread(row.accountId, row.folderId, msg.changes.isRead ? -1 : 1)
      } else if (!row && msg.changes && msg.changes.isRead === true && msg.accountId) {
        // 该邮件不在当前列表里（比如在别的视图、别的标签页被标为已读，
        // 或同步时 IMAP 已读标记变了），但后端只在“未读→已读”的转变时才发
        // 这个事件，所以直接减一次，避免角标滞后、与“所有未读”列表对不上。
        bumpUnread(msg.accountId, msg.folderId ?? null, -1)
      }
      if (row) Object.assign(row, msg.changes || {})
      if (selectedMessage.value?.id === msg.messageId) Object.assign(selectedMessage.value, msg.changes || {})
    } else if (msg.type === 'mail-deleted') {
      const row = mailList.value.find((m) => m.id === msg.messageId)
      if (row && !row.isRead) bumpUnread(row.accountId, row.folderId, -1)
      mailList.value = mailList.value.filter((m) => m.id !== msg.messageId)
      if (selectedId.value === msg.messageId) { selectedId.value = null; selectedMessage.value = null }
    } else if (msg.type === 'sync') {
      const acct = accounts.value.find((a) => a.id === msg.accountId)
      if (acct) acct.status = msg.state === 'started' ? 'syncing' : (msg.state === 'error' ? 'error' : 'online')
      if (msg.state === 'done') { void loadAccounts(); void loadMessages() }
    } else if (msg.type === 'account') {
      void loadAccounts()
    }
  }
  function connectRealtime(): void {
    if (typeof window === 'undefined' || realtime) return
    realtime = createRealtime(handleRealtime)
  }
  function disconnectRealtime(): void {
    if (realtime) { realtime.disconnect(); realtime = null }
  }

  async function init(): Promise<void> {
    // 懒加载：初始化只加载一级账号名，不预加载任何账号的文件夹；
    // 文件夹在点邮箱行 / 折叠箭头时才按需加载。
    await Promise.all([loadAccounts(), loadSettings()])
    // 恢复上次选中的导航（无记录/记录失效时默认所有收件箱）。
    await restoreView()
    // 刷新回来后，若后端批量删除任务还在跑，继续显示“删除中…”并轮询到完成。
    void syncDeleteStatus()
    connectRealtime()
  }

  return {
    accounts, foldersByAccount, expanded, view, mailList, total, loading, page, totalPages,
    activeAccountId, activeFolder,
    searchQuery, selectedId, selectedMessage, checkedIds, checkedCount, isAllChecked, isSomeChecked, batchDeleting, deleteRemaining, isDeletingHere,
    readingLoading, refreshingAll, refreshingAccounts,
    settings, localDrafts, composeDraft, toast, confirmRequest, resolveConfirm, unreadCounts, unreadOfAccount, unreadOfFolder,
    mview, mobileAccountId, drawerOpen,
    totalUnread, currentAccount, mobileAccount, isTrashView,
    showToast, loadAccounts, loadSettings, loadFolders, inboxFolderId, accountLabel, folderLabel,
    setAggregate, setFolderView, setAccountUnread, selectAccount, toggleAccountExpand,
    loadMessages, goToPage, nextPage, prevPage, setSearch, openMessage, setRead, deleteMessage, moveToSpam,
    toggleCheck, toggleCheckAll, clearChecked, deleteChecked,
    saveLocalDraft, deleteLocalDraft, refreshAll, refreshAccount,
    goMobileHome, enterMobileAccount, setMobileAccount,
    connectRealtime, disconnectRealtime, handleRealtime, init
  }
})
