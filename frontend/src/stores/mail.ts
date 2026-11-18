import { defineStore } from 'pinia'
import { ref, reactive, computed, watch } from 'vue'
import { api, ApiError } from '../api'
import { createRealtime } from '../realtime'
import type {
  Account, AggregateKind, Draft, Folder, FolderType,
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

const LEGACY_DRAFT_KEY = 'luck-mail-local-drafts' // 旧本机草稿键：只供一次性迁移读，见 migrateLocalDrafts
const VIEW_KEY = 'luck-mail-active-view' // 刷新后恢复上次选中的导航（聚合视图/单邮箱/文件夹）
const PAGE_SIZE = 50

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
  // 异步批量删除的待收尾信息（F14）：后端只回 taskId 时，deleteChecked 不立即
  // 做本地对账，等轮询确认 running===false 后，用状态接口的 deleted（数字计数）
  // 一次结算 toast（total 由刚拉的列表重算，不再另减）。
  let pendingBatchDelete: { permanent: boolean; draftCount: number; taskId?: string } | null = null
  function stopDeletePolling(): void {
    if (deleteStatusTimer) { clearInterval(deleteStatusTimer); deleteStatusTimer = null }
  }
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
  // F3：连续失败计数，≥3 次停表并清“删除中”状态，避免泄漏后每 1.5 秒
  // 无限请求（登出/会话重置时也由 resetSessionState/disconnectRealtime 停表）。
  let deleteStatusFailures = 0
  async function syncDeleteStatus(): Promise<void> {
    try {
      // 审计 #4：本会话发起的异步任务带上 taskId 轮询，避免两标签页同时
      // 批量删除时轮询到对方的任务；刷新回来恢复的旧任务（pending 为空）
      // 不带 taskId，走后端“返回最近任务”的兼容。
      const st = await api.getDeleteStatus(pendingBatchDelete?.taskId)
      deleteStatusFailures = 0
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
          // 收尾前记下发起删除的视图：用户若已切走，别在新视图自动打开首封（审计 #4 LOW）。
          const deleteViewAtStart = deleteView.value
          deleteView.value = null
          saveDeleteView()
          await loadMessages()
          // 异步批量删除收尾（F14）：本会话发起的任务跑完后，用状态接口的
          // deleted（数字计数）一次结算（total 由刚拉的列表重算，不再另减），
          // 并弹最终 toast；刷新回来恢复的旧任务（pending 为空）不弹。
          if (pendingBatchDelete) {
            const deletedCount = (st.deleted || 0) + pendingBatchDelete.draftCount
            const permanent = pendingBatchDelete.permanent
            pendingBatchDelete = null
            if (selectedId.value !== null && !mailList.value.some((m) => m.id === selectedId.value)) {
              selectedId.value = null
              selectedMessage.value = null
            }
            await autoOpenFirstAfterDelete(deleteViewAtStart ?? undefined)
            showToast(permanent ? `已彻底删除 ${deletedCount} 封` : `已移到已删除 ${deletedCount} 封`)
          }
        }
        stopDeletePolling()
      }
    } catch {
      // 状态查不到就当没在删，不阻塞列表；连续失败 ≥3 次停表并清状态（F3），
      // 避免网络断了还每 1.5 秒请求、删除中提示永远挂着。
      deleteStatusFailures += 1
      if (deleteStatusFailures >= 3) {
        deleteStatusFailures = 0
        pendingBatchDelete = null
        stopDeletePolling()
        batchDeleting.value = false
        deleteRemaining.value = 0
        deleteView.value = null
        saveDeleteView()
        // 停表前重拉一次列表：轮询失败可能是网络抖动，列表未必已是最新；
        // 只拉一次，不再继续轮询（审计 #5 LOW）；同时提示用户，因为
        // 乐观删掉的行可能又回来。
        void loadMessages()
        showToast('删除状态同步失败，列表已刷新')
      }
    }
  }
  const readingLoading = ref<boolean>(false)
  const refreshingAll = ref<boolean>(false)
  const settings = ref<Settings>({ signature: '', defaultAccountId: null })
  // 服务端草稿（2026-11-18 用户定夺：草稿进数据库，不再写 localStorage）；
  // 旧本机草稿由 migrateLocalDrafts() 在 init 时一次性迁过去。
  const drafts = ref<Draft[]>([])
  const composeDraft = ref<Draft | null>(null) // 点草稿时，交给写信弹窗回填
  const toast = ref<string>('')
  // 页内确认框：替代浏览器原生 window.confirm（太难看），由 ConfirmModal 渲染。
  // requestConfirm 返回 Promise，点确定 resolve(true)、点取消 resolve(false)。
  const confirmRequest = ref<{ message: string; danger: boolean; resolve: (ok: boolean) => void } | null>(null)
  function requestConfirm(message: string, danger = false): Promise<boolean> {
    // 覆盖保护：上一个确认框还没点，新的就来了——先把旧的按“取消” resolve，
    // 否则旧调用方永远等不到结果（deleteChecked 会一直卡在 await）。
    if (confirmRequest.value) confirmRequest.value.resolve(false)
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
  // 刷新（如下拉刷新整页重载）时，mview 必须在首屏渲染前就恢复到保存值，
  // 否则先以默认值 'home' 渲染、等 init() 的网络请求回来才切回列表/正文，
  // 首页会闪一下。localStorage 是同步的，在这里直接读。
  const MOBILE_STATE_KEY = 'luck-mail-mobile-state'
  let savedMview: 'home' | 'account' | 'read' = 'home'
  let savedMobileAccountId: number | null = null
  if (window.innerWidth < 1024) {
    try {
      const saved = JSON.parse(localStorage.getItem(MOBILE_STATE_KEY) || 'null') as { mview?: string; mobileAccountId?: number | null; selectedId?: number | string | null } | null
      if (saved && (saved.mview === 'account' || saved.mview === 'read' || saved.mview === 'home')) savedMview = saved.mview
      if (saved && typeof saved.mobileAccountId === 'number') savedMobileAccountId = saved.mobileAccountId
      if (saved && saved.mview === 'read' && saved.selectedId != null) selectedId.value = saved.selectedId
    } catch { /* 读不到就默认回首页 */ }
  }
  const mview = ref<'home' | 'account' | 'read'>(savedMview)
  const mobileAccountId = ref<number | null>(savedMobileAccountId)
  const drawerOpen = ref<boolean>(false)
  // 手机端刷新后回到哪一级也要记住（只记 view 不够：正在读信时刷新，
  // 光恢复 view 会回到列表，而不是正在读的那封信；只在手机/平板上用）。
  function saveMobileState(): void {
    try {
      localStorage.setItem(MOBILE_STATE_KEY, JSON.stringify({ mview: mview.value, mobileAccountId: mobileAccountId.value, selectedId: selectedId.value }))
    } catch { /* 存不下就下次默认回列表 */ }
  }
  watch([mview, mobileAccountId, selectedId], saveMobileState)

  const totalUnread = computed<number>(() => unreadCounts.get('total') || 0)
  const totalPages = computed<number>(() => Math.max(1, Math.ceil(total.value / PAGE_SIZE)))
  const checkedCount = computed<number>(() => checkedIds.value.size)
  const isAllChecked = computed<boolean>(() => mailList.value.length > 0 && mailList.value.every((m) => checkedIds.value.has(m.id)))
  const isSomeChecked = computed<boolean>(() => checkedIds.value.size > 0 && !isAllChecked.value)
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
  // 发信成功后 4 秒内抑制“邮件列表加载失败”这类加载失败 toast（F2）：
  // 发信后切视图会触发 loadMessages，若它恰好失败，失败 toast 会盖掉
  // 刚显示的“发送成功”，用户以为没发出去。只抑制加载失败 toast，
  // 其他 toast（删除/标记失败等）不受影响。
  let suppressLoadFailToastUntil = 0
  function suppressLoadFailToast(ms: number): void {
    suppressLoadFailToastUntil = Date.now() + ms
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
  // 视图切换时统一重置列表状态：清搜索/选中、回第 1 页，手机端进列表级，再拉列表。
  // 先清旧列表再拉新列表：否则加载期间列表里还是上一个文件夹的旧邮件，
  // 标题已是新视图、内容却是旧的（审计 #4 主修）；失败分支本来就会把
  // 列表置空，先清与失败行为一致。
  async function resetListState(): Promise<void> {
    searchQuery.value = ''
    selectedId.value = null
    selectedMessage.value = null
    clearChecked()
    page.value = 1
    mailList.value = []
    total.value = 0
    if (window.innerWidth < 1024) backToMobileAccount()
    await loadMessages()
  }

  async function setAggregate(kind: AggregateKind): Promise<void> {
    const agg = AGGREGATES.find((a) => a.kind === kind) || AGGREGATES[0]
    view.value = { kind: agg.kind, label: agg.label, accountId: null, folderId: null }
    activeAccountId.value = null
    activeFolder.value = null
    await resetListState()
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
    mobileAccountId.value = accountId
    await resetListState()
  }

  // 移动端“未读邮件”页签：只看当前账号的未读（view=all-unread + accountId）
  async function setAccountUnread(accountId: number): Promise<void> {
    view.value = { kind: 'all-unread', label: '未读邮件', accountId, folderId: null }
    activeAccountId.value = accountId
    activeFolder.value = null
    mobileAccountId.value = accountId
    await resetListState()
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
    mobileAccountId.value = accountId
    await resetListState()
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
      // folderId 为 null 是合法值（账号级视图，如该账号当时没有文件夹），
      // 按原样恢复成账号级视图；只有 key 缺失（undefined）才算“没存”，
      // 走下面的收件箱兜底。
      if (saved.folderId === null) { await setFolderView(saved.accountId, null); return }
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

  // 恢复手机端在哪一级：正在读信时回到正在读的那封信（openMessage 会把 mview 切到 read），
  // 正在看某邮箱列表时回到列表；只在手机/平板上跑，桌面端不用。
  // 注意：saved 必须由调用方在 restoreView() 之前读好传进来——restoreView 里
  // setAggregate/setFolderView 会把 mview 改成 'account' 并触发保存，若在这里
  // 再读 localStorage，读到的已是被盖掉的“列表”，正在读信就回不去了。
  async function restoreMobileState(saved: { mview?: string; mobileAccountId?: number | null; selectedId?: number | string | null } | null): Promise<void> {
    if (window.innerWidth >= 1024) return
    if (!saved) return
    if (typeof saved.mobileAccountId === 'number') mobileAccountId.value = saved.mobileAccountId
    if (saved.mview === 'read' && saved.selectedId != null) {
      await openMessage(saved.selectedId)
      return
    }
    if (saved.mview === 'account') { mview.value = 'account'; return }
    if (saved.mview === 'home') { mview.value = 'home'; return }
  }

  function accountLabel(accountId: number | null): string {
    const a = accounts.value.find((x) => x.id === accountId)
    return a ? (a.displayName || a.email) : ''
  }

  // ---- 邮件列表 ----
  function currentFolderType(): FolderType | null {
    if (view.value.kind !== 'folder') return null
    const folders = foldersByAccount.value[view.value.accountId ?? -1] || []
    return folders.find((f) => f.id === view.value.folderId)?.type || null
  }

  function draftEnvelopes(): MessageEnvelope[] {
    // 服务端草稿只出现在草稿视图里（置顶，带“草稿”标记）
    const inDraftsView =
      view.value.kind === 'all-drafts' ||
      (view.value.kind === 'folder' && currentFolderType() === 'drafts')
    if (!inDraftsView) return []
    return drafts.value
      .filter((d) => view.value.kind === 'all-drafts' || d.accountId === view.value.accountId)
      .map((d) => ({
        id: d.id, accountId: d.accountId ?? 0, accountEmail: accountLabel(d.accountId),
        folderId: null, folderPath: '', uid: 0,
        subject: d.subject || '（无主题）', from: accountLabel(d.accountId) || '',
        fromName: '', to: typeof d.to === 'string' ? d.to.split(',').map((s) => s.trim()).filter(Boolean) : [],
        date: d.updatedAt, snippet: (d.text || '').slice(0, 80),
        isRead: true, hasAttachments: false, size: 0, isDraft: true
      }))
  }

  // 请求序号（S1 竞态守卫）：每次 loadMessages 递增；await 返回后序号变了
  // 说明已有更新的请求在跑，旧响应直接丢弃，不覆盖列表、不触发自动打开。
  let loadSeq = 0
  // 分页加载：每页 50 条，后端按 offset/limit 只返回当页，不一次全拉。
  // 切视图/搜索时回到第 1 页；点上一页/下一页时按页拉取并替换列表。
  async function loadMessages({ page: p, autoOpenFirst, keepChecked = false, background = false }: { page?: number; autoOpenFirst?: boolean; keepChecked?: boolean; background?: boolean } = {}): Promise<void> {
    const seq = ++loadSeq
    if (p !== undefined) page.value = Math.max(1, p)
    // 刷新（refreshAll/refreshAccount/同步/重连对账）不清空批量选择；
    // 只在切视图/搜索/翻页时清（默认）。
    if (!keepChecked) checkedIds.value = new Set()
    // 账号级视图（folder 但无 folderId，如该账号当时没有文件夹）：
    // 只显示该账号的服务端草稿（不调 /api/messages）。
    if (view.value.kind === 'folder' && !view.value.folderId) {
      try { await loadDrafts() } catch { /* 草稿拉不到就显示旧列表 */ }
      mailList.value = draftEnvelopes()
      total.value = mailList.value.length
      return
    }
    // 草稿视图（所有草稿 / 某邮箱草稿箱）且没在搜索：读服务端草稿，
    // 不调 /api/messages。搜索时走正常服务端搜索（草稿不进 FTS、
    // 不拼进结果，与旧行为一致）。
    if (!searchQuery.value.trim() && (view.value.kind === 'all-drafts' || (view.value.kind === 'folder' && currentFolderType() === 'drafts'))) {
      loading.value = true
      try {
        await loadDrafts()
        if (seq !== loadSeq) return
        mailList.value = draftEnvelopes()
        total.value = mailList.value.length
        if (!mailList.value.length) {
          selectedId.value = null
          selectedMessage.value = null
        }
      } catch {
        if (seq !== loadSeq) return
        mailList.value = []
        total.value = 0
        selectedId.value = null
        selectedMessage.value = null
        if (Date.now() >= suppressLoadFailToastUntil) showToast('草稿加载失败，请点刷新重试')
      } finally {
        if (seq === loadSeq) loading.value = false
      }
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
      if (seq !== loadSeq) return // 已被更新的请求取代，丢弃旧响应（含自动打开那段）
      // 按 id 去重（审计 #4 LOW 加固）：防后端某次返回同一 id 两次时前端
      // 渲染双行；只挡同一 id 的重复，对“不同 id 的两行”无效。
      // 草稿不在这里拼：草稿视图上面已提前返回，搜索时草稿也不进结果。
      const seenIds = new Set<number | string>()
      mailList.value = [...(data.messages || [])].filter((m) => !seenIds.has(m.id) && (seenIds.add(m.id), true))
      total.value = data.total || 0
      // “所有未读”视图：以后端返回的未读总数为准对齐角标。事件驱动的计数
      // 若有漂移（比如某封信在别的视图被标已读），点进这个视图就自动纠正，
      // 避免角标显示 1 但列表为空。
      if (view.value.kind === 'all-unread' && !view.value.accountId) {
        unreadCounts.set('total', data.total || 0)
      }
      // 当前页已空且不是第 1 页（比如删光了本页最后一封），自动回上一页，避免停在空白页
      if (!mailList.value.length && page.value > 1) {
        await goToPage(page.value - 1)
        return
      }
      // 第 1 页空列表（搜不到结果、文件夹本来就空）时清空选择，避免阅读窗残留旧邮件
      if (!mailList.value.length) {
        selectedId.value = null
        selectedMessage.value = null
      }
      // 自动打开：仅搜索触发的那一次加载（setSearch 传 autoOpenFirst），
      // 或无选中时的桌面端默认选中；翻页/刷新/同步不自动打开；
      // 手机端一律不自动打开，等用户点；草稿不自动打开
      if (mailList.value.length && window.innerWidth >= 1024) {
        if (autoOpenFirst) {
          const first = mailList.value.find((m) => !m.isDraft)
          if (first && first.id !== selectedId.value) await openMessage(first.id)
        } else if (!selectedId.value) {
          const first = mailList.value.find((m) => !m.isDraft)
          if (first) await openMessage(first.id)
        }
      }
    } catch {
      if (seq !== loadSeq) return // 旧请求失败了也不覆盖新请求的列表、不弹错
      if (background) {
        // 后台触发的加载（sync-done 重载、重连对账）失败时保留旧列表、
        // 不清选中、不闪空列表，也不弹 toast（审计 #4 LOW：后台失败静默，
        // 网络抖动时反复弹提示反而扰民；用户可点刷新重试）。
        return
      }
      mailList.value = []; total.value = 0
      if (!mailList.value.length) { selectedId.value = null; selectedMessage.value = null }
      if (Date.now() >= suppressLoadFailToastUntil) showToast('邮件列表加载失败，请点刷新重试')
    } finally {
      // 只有最新请求能清 loading，避免旧请求先跑完把“加载中”提前关掉
      if (seq === loadSeq) loading.value = false
    }
  }

  async function goToPage(p: number): Promise<void> {
    const target = Math.min(Math.max(1, p), totalPages.value)
    if (target === page.value && mailList.value.length) return
    await loadMessages({ page: target })
  }
  // 删信/移信后当前页变空且不是第 1 页时，自动回上一页，避免停在空白页
  async function backIfPageEmpty(): Promise<void> {
    if (!mailList.value.length && page.value > 1) await goToPage(page.value - 1)
  }
  async function nextPage(): Promise<void> { await goToPage(page.value + 1) }
  async function prevPage(): Promise<void> { await goToPage(page.value - 1) }

  function setSearch(q: string): void {
    searchQuery.value = q
    page.value = 1
    void loadMessages({ autoOpenFirst: true })
  }

  // ---- 读信 ----
  async function openMessage(id: number | string): Promise<void> {
    // 删除中锁定列表：只锁发起删除的那个视图，不许打开查看，等删完再说；别的视图不受影响。
    if (isDeletingHere.value) return
    const draft = drafts.value.find((d) => d.id === id)
    if (draft) { composeDraft.value = { ...draft }; return }
    selectedId.value = id
    readingLoading.value = true
    try {
      const data = await api.message(id)
      // S1：返回时若选中已换成别的信（用户快速连点），丢弃这次旧响应，
      // 不覆盖新信的正文，也不切阅读窗。
      if (selectedId.value !== id) return
      selectedMessage.value = data.message
      // 打开即标已读（后端 GET 详情已标已读并推 Socket.io 更新；这里同步本地列表与未读数）
      const row = mailList.value.find((m) => m.id === id)
      if (row && !row.isRead) {
        row.isRead = true
        bumpUnread(row.accountId, row.folderId, -1)
      }
      // 成功才切到阅读窗：失败时不切，留在列表（M18）。
      if (window.innerWidth < 1024) mview.value = 'read'
    } catch {
      // 失败时清掉这次选中，避免阅读窗残留旧信、mview 停在错误的 read。
      if (selectedId.value === id) { selectedId.value = null; selectedMessage.value = null }
      showToast('打开邮件失败')
    } finally {
      readingLoading.value = false
    }
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

  // 删信/移垃圾后：若阅读窗已空（删的正是正在读的那封）且列表非空，
  // 桌面端自动打开当前页第一封，避免阅读窗一直空白；手机端不自动打开。
  // expectedView：删信开始时的视图——完成时若用户已切到别的视图，
  // 别在新视图自动打开首封（审计 #4 LOW）。
  async function autoOpenFirstAfterDelete(expectedView?: { kind: string; accountId: number | null; folderId: number | null }): Promise<void> {
    if (window.innerWidth < 1024) return
    if (selectedId.value !== null) return
    if (expectedView && (view.value.kind !== expectedView.kind || view.value.accountId !== expectedView.accountId || view.value.folderId !== expectedView.folderId)) return
    const first = mailList.value.find((m) => !m.isDraft)
    if (first) await openMessage(first.id)
  }

  async function deleteMessage(id: number | string): Promise<void> {
    // 批量删除进行中：阅读窗的删除按钮已禁用（F4），这里再守一道入口。
    if (isDeletingHere.value) return
    const viewAtStart = { kind: view.value.kind, accountId: view.value.accountId, folderId: view.value.folderId }
    try {
      await api.deleteMessage(id)
      // 状态同步：mailList 与 unreadCounts 一起即时更新，不重新拉全量。
      // 单删接口是同步的，后端删完发 mail-deleted（io.emit，全员含发起方）
      // 才响应，实时事件可能已提前把行拿掉并减过 total：这里只在行还在
      // 列表里时才减，避免与实时事件重复计数。
      const row = mailList.value.find((m) => m.id === id)
      if (row) {
        if (!row.isRead) bumpUnread(row.accountId, row.folderId, -1)
        total.value = Math.max(0, total.value - 1)
      }
      mailList.value = mailList.value.filter((m) => m.id !== id)
      if (selectedId.value === id) { selectedId.value = null; selectedMessage.value = null }
      await backIfPageEmpty()
      await autoOpenFirstAfterDelete(viewAtStart)
      showToast(isTrashView.value ? '已彻底删除' : '已移到已删除')
    } catch (e) {
      // F1：失败先对账再提示——先重拉列表，行已不在说明服务端其实删成了
      //（如 DELETE 404 前行已被实时事件拿掉），不要再报“删除失败”；
      // 行还在才是真失败；404 透传后端原话“邮件不存在”。
      // 对账不清空批量勾选（keepChecked）：失败一次不应把用户已勾的别的邮件全取消。
      await loadMessages({ keepChecked: true })
      if (!mailList.value.some((m) => m.id === id)) {
        if (selectedId.value === id) { selectedId.value = null; selectedMessage.value = null }
        await autoOpenFirstAfterDelete(viewAtStart)
        showToast(isTrashView.value ? '已彻底删除' : '已移到已删除')
      } else {
        showToast(e instanceof ApiError ? e.message : '删除失败，请重试')
      }
    }
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
    // 删信开始时的视图：结算时若用户已切走，别按旧视图的数扣新视图的 total、
    // 别在新视图自动打开首封（审计 #4 LOW）。
    const viewAtStart = { kind: view.value.kind, accountId: view.value.accountId, folderId: view.value.folderId }
    const permanent = isTrashView.value
    const label = permanent ? '彻底删除' : '移到已删除'
    if (!await requestConfirm(`确定${label}选中的 ${ids.length} 封邮件吗？`, true)) return
    // 草稿按 isDraft 字段划分（不用 typeof id：服务端草稿 id 也可能是字符串）。
    const isDraftId = (id: number | string): boolean =>
      mailList.value.some((m) => m.id === id && m.isDraft)
    const draftIds = ids.filter(isDraftId)
    const serverIds = ids.filter((id) => !isDraftId(id))
    batchDeleting.value = true
    // 记下发起删除的视图：删除中提示与列表锁定只属于这个视图，切到别的视图不受影响。
    deleteView.value = { kind: view.value.kind, accountId: view.value.accountId, folderId: view.value.folderId }
    saveDeleteView()
    try {
      // 剩余数先按待删的服务端邮件数显示，再由轮询按后端进度更新（15、14、13…）。
      if (serverIds.length > 0) deleteRemaining.value = serverIds.length
      // 服务端草稿逐条删（DELETE /api/drafts/:id）；删失败的留在列表里并计入失败数。
      const deletedDraftIds: Array<number | string> = []
      let failedDraftCount = 0
      for (const id of draftIds) {
        try { await deleteDraft(id); deletedDraftIds.push(id) } catch { failedDraftCount += 1 }
      }
      let deleted: number[] = []
      let failedCount = 0
      if (serverIds.length) {
        // 把发起删除的视图一并传给后端：刷新后 delete-status 靠它恢复“只在该视图显示删除中”。
        const res = await api.batchDeleteMessages(serverIds, { kind: view.value.kind, accountId: view.value.accountId, folderId: view.value.folderId })
        if (res.taskId) {
          // F14 异步返回：后端只给了 taskId，删除在后台跑。最终结算仍等
          // syncDeleteStatus 确认 running===false 后，用状态接口的
          // deleted（数字计数）一次结算（见 syncDeleteStatus）；但行先乐观
          // 拿掉、total 与未读数即时减掉，列表不用等 5–6 秒才反映
          // （审计 #5 LOW）；任务跑完/失败时轮询都会重拉列表对账，
          // 没删成的行会回来。
          const removedNow = mailList.value.filter((m) => serverIds.includes(m.id))
          removedNow.forEach((row) => { if (!row.isRead) bumpUnread(row.accountId, row.folderId, -1) })
          mailList.value = mailList.value.filter((m) => !serverIds.includes(m.id))
          if (isDeletingHere.value) total.value = Math.max(0, total.value - serverIds.length)
          if (selectedId.value !== null && serverIds.includes(selectedId.value)) {
            selectedId.value = null
            selectedMessage.value = null
          }
          // 草稿已在上面删掉；勾选先清掉，避免用户重复点删除。
          // taskId 存下来供轮询透传（审计 #4）：不存会轮询到“最近任务”，
          // 两标签页同时批量删除时可能串台。
          pendingBatchDelete = { permanent, draftCount: deletedDraftIds.length, taskId: res.taskId }
          checkedIds.value = new Set()
          startDeletePolling()
          return
        }
        deleted = res.deleted || []
        failedCount = (res.failed || []).length
        // POST 已返回、服务端任务已入队，再开始轮询：轮询若抢在入队前看到
        // running=false，会误清“删除中”状态。
        startDeletePolling()
      }
      // 状态同步：从 mailList 移除已删的，未读数即时更新，不重新拉全量。
      // removed 只用来补未读数（行还在列表里才需要补；已被实时事件提前拿掉的，
      // handler 删行时已补过，不会重复）。
      const removed = mailList.value.filter((m) => deleted.includes(m.id as number) || deletedDraftIds.includes(m.id))
      removed.forEach((row) => { if (!row.isRead) bumpUnread(row.accountId, row.folderId, -1) })
      mailList.value = mailList.value.filter((m) => !deleted.includes(m.id as number) && !deletedDraftIds.includes(m.id))
      // total 与 toast 按后端返回的实际删除数计：批量删除接口是同步的，
      // 服务端删完发 mail-deleted（io.emit）才响应，实时事件一定抢在本地
      // 更新之前把行拿掉，列表过滤计数会是 0；但 handler 在本次批量删除
      // 期间不减 total（见 handleRealtime），所以这里按后端数减一次，不重复。
      const deletedCount = deleted.length + deletedDraftIds.length
      // 切视图后 total 已是新视图的数，别按旧视图的删除数扣（审计 #4 LOW）；
      // 等轮询重拉会把新视图的 total 纠回来。
      if (isDeletingHere.value) total.value = Math.max(0, total.value - deletedCount)
      if (selectedId.value !== null && (deleted.includes(selectedId.value as number) || deletedDraftIds.includes(selectedId.value))) {
        selectedId.value = null
        selectedMessage.value = null
      }
      checkedIds.value = new Set()
      await backIfPageEmpty()
      if (!serverIds.length) {
        // 只有草稿：没有服务端任务，直接清状态（不等轮询）。
        batchDeleting.value = false
        deleteRemaining.value = 0
        deleteView.value = null
        saveDeleteView()
      }
      // 有服务端任务时这里不清“删除中”：等 syncDeleteStatus 确认
      // running===false 再清（旧 finally 在这里提前清，提示会闪一下就没了）。
      await autoOpenFirstAfterDelete(viewAtStart)
      const totalFailed = failedCount + failedDraftCount
      showToast(totalFailed > 0 ? `已删除 ${deletedCount} 封，${totalFailed} 封失败` : (permanent ? `已彻底删除 ${deletedCount} 封` : `已移到已删除 ${deletedCount} 封`))
    } catch {
      showToast('批量删除失败，请重试')
      if (serverIds.length) {
        // POST 失败也可能服务端已入队：查一次真实状态再决定，未跑完就继续轮询；
        // 确认没跑才由 syncDeleteStatus 清状态。
        startDeletePolling()
        void syncDeleteStatus()
      } else {
        batchDeleting.value = false
        deleteRemaining.value = 0
        deleteView.value = null
        saveDeleteView()
      }
    }
  }

  async function moveToSpam(id: number | string): Promise<void> {
    // 批量删除进行中：阅读窗的移垃圾按钮已禁用（F4），这里再守一道入口。
    if (isDeletingHere.value) return
    const msg = mailList.value.find((m) => m.id === id) || selectedMessage.value
    if (!msg) return
    const viewAtStart = { kind: view.value.kind, accountId: view.value.accountId, folderId: view.value.folderId }
    const folders = await loadFolders(msg.accountId)
    const spam = folders.find((f) => f.type === 'spam')
    if (!spam) { showToast('该邮箱没有垃圾邮件文件夹'); return }
    try {
      await api.moveMessage(id, spam.id)
      // 移走的若是未读，未读数减一（与 deleteMessage 一致；移动只发
      // mail-updated(folderId)，不发 mail-deleted，不会重复减）。
      if (!msg.isRead) bumpUnread(msg.accountId, msg.folderId, -1)
      mailList.value = mailList.value.filter((m) => m.id !== id)
      total.value = Math.max(0, total.value - 1)
      if (selectedId.value === id) { selectedId.value = null; selectedMessage.value = null }
      await backIfPageEmpty()
      await autoOpenFirstAfterDelete(viewAtStart)
      showToast('已标记为垃圾邮件')
    } catch (e) {
      // F1：与 deleteMessage 同理——先重拉对账，行已不在说明服务端其实移成了。
      // 对账不清空批量勾选（keepChecked），理由同 deleteMessage。
      await loadMessages({ keepChecked: true })
      if (!mailList.value.some((m) => m.id === id)) {
        if (selectedId.value === id) { selectedId.value = null; selectedMessage.value = null }
        await autoOpenFirstAfterDelete(viewAtStart)
        showToast('已标记为垃圾邮件')
      } else {
        showToast(e instanceof ApiError ? e.message : '标记失败，请重试')
      }
    }
  }

  // ---- 服务端草稿（2026-11-18 用户定夺：草稿进数据库，不再写 localStorage）----
  async function loadDrafts(): Promise<void> {
    try {
      const data = await api.listDrafts()
      drafts.value = data.drafts || []
    } catch {
      // 草稿拉不到就保持旧列表（多半是旧后端/断网），不阻塞主列表；
      // 草稿视图里 loadMessages 会按空列表处理。
    }
  }
  function upsertDraft(d: Draft): void {
    const i = drafts.value.findIndex((x) => x.id === d.id)
    if (i >= 0) drafts.value = [...drafts.value.slice(0, i), d, ...drafts.value.slice(i + 1)]
    else drafts.value = [d, ...drafts.value]
  }
  function dropDraft(id: number | string): void {
    // 只清本地状态（发信成功后服务端已按 draftId 删草稿，不再调 DELETE）。
    drafts.value = drafts.value.filter((d) => d.id !== id)
  }
  async function deleteDraft(id: number | string): Promise<void> {
    await api.deleteDraft(id)
    dropDraft(id)
  }
  // 一次性迁移：init 时若 localStorage 里还有旧本机草稿，逐条 POST 到
  // /api/drafts（保留原 idempotencyKey），全成功后清空旧键；有失败的
  // 留在旧键里，下次 init 再试，不丢数据。
  async function migrateLocalDrafts(): Promise<void> {
    let saved: Draft[] = []
    try { saved = JSON.parse(localStorage.getItem(LEGACY_DRAFT_KEY) || '[]') as Draft[] } catch { saved = [] }
    if (!saved.length) return
    const failed: Draft[] = []
    for (const d of saved) {
      try {
        const r = await api.createDraft({ accountId: d.accountId, to: d.to, subject: d.subject, text: d.text, idempotencyKey: d.idempotencyKey })
        if (r?.draft) upsertDraft(r.draft)
      } catch { failed.push(d) }
    }
    try {
      if (failed.length) localStorage.setItem(LEGACY_DRAFT_KEY, JSON.stringify(failed))
      else localStorage.removeItem(LEGACY_DRAFT_KEY)
    } catch { /* 忽略 */ }
  }

  // ---- 刷新 ----
  async function refreshAll(): Promise<void> {
    if (refreshingAll.value) return // 防重入：手机端按钮与桌面端按钮可能被连点
    refreshingAll.value = true
    try {
      // 同步与随后加载分开报错（审计 #5 LOW）：同步接口失败是“同步失败”，
      // 同步成功、随后拉账号/列表失败是“列表加载失败”，别混成一句。
      try {
        await api.refreshAll()
      } catch {
        showToast('同步失败，请重试')
        return
      }
      try {
        await Promise.all([loadAccounts(), loadMessages({ keepChecked: true })])
      } catch {
        showToast('同步完成，但列表加载失败，请点刷新重试')
        return
      }
      showToast('已刷新全部邮箱')
    } finally { refreshingAll.value = false }
  }

  async function refreshAccount(accountId: number): Promise<void> {
    try {
      await api.refreshAccount(accountId)
      await loadMessages({ keepChecked: true })
    } catch { showToast('刷新该邮箱失败') }
  }

  // ---- 手机/平板浏览器历史（2026-11-18 重设计）----
  // 问题：单页应用不写历史，手机系统“从左边缘右滑返回”手势无记录可退，
  // 直接退出到浏览器空白页/首页。解法：mview 每深入一级就 pushState，
  // 系统返回手势/返回键触发 popstate，应用按 state 里的 mview 回退一级，
  // 而不是退出。返回按钮与中部右滑手势也统一走 history.back()，
  // 让历史栈与 mview 始终同步（直接改 mview 会让栈与界面错位，
  // 下一次系统返回要多按一次才生效）。
  // 层级：home（0）→ account（1）→ read（2），只记层级，不改 URL。
  let historyInitialized = false
  let suppressHistoryPush = false
  function historyStateFor(m: 'home' | 'account' | 'read'): { mview: string } {
    return { mview: m }
  }
  function initMobileHistory(): void {
    if (historyInitialized) return
    if (typeof window === 'undefined' || !window.history) return
    // 桌面端不用手机历史：不搭栈、不注册 popstate，也不置位；
    // 窗口缩到 1024 以下时由 resize 监听补调一次（审计 #5 前端轨 S4：
    // 以前先置位再判宽度，桌面端打开后缩窗就永远没历史栈）。
    if (window.innerWidth >= 1024) return
    historyInitialized = true
    // 按恢复到的 mview 把历史栈搭成 home → account → read，
    // 让返回路径正好是 read → account → home。
    const cur = mview.value
    window.history.replaceState(historyStateFor('home'), '')
    if (cur === 'account') window.history.pushState(historyStateFor('account'), '')
    if (cur === 'read') {
      window.history.pushState(historyStateFor('account'), '')
      window.history.pushState(historyStateFor('read'), '')
    }
    window.addEventListener('popstate', onHistoryPop)
  }
  function onHistoryPop(e: PopStateEvent): void {
    const state = (e.state || {}) as { mview?: string }
    const target = state.mview === 'account' || state.mview === 'read' ? state.mview : 'home'
    // popstate 引起的 mview 变化不 push（watch 的方向判断已排除后退，
    // 这里再加一道保险，防浏览器前进按钮导致的前进式 popstate 重复入栈）。
    suppressHistoryPush = true
    drawerOpen.value = false
    mview.value = target
    // watch 是微任务里跑，setTimeout（宏任务）清标志能确保它读到 suppress。
    setTimeout(() => { suppressHistoryPush = false }, 0)
  }
  // mview 深入时（home→account、account→read）入栈；后退时不动历史
  //（后退由 popstate / history.back() 驱动，栈已同步）。
  // init 完成前不入栈（恢复状态时的 mview 变化由 initMobileHistory 一次性搭好）。
  watch(mview, (next, prev) => {
    if (!historyInitialized || suppressHistoryPush) return
    if (typeof window === 'undefined' || !window.history) return
    if (next === prev) return
    if ((prev === 'home' && next === 'account') || (prev === 'account' && next === 'read')) {
      window.history.pushState(historyStateFor(next), '')
    }
  })
  // 移动端返回上一级（2026-11-18 重设计）：抽屉开着先关抽屉；
  // 否则走 history.back()，由 popstate 把 mview 退一级——
  // 这样历史栈与界面同步，系统返回手势也不会多退一级。
  // home 已是顶层，不动（再按返回就是退出应用，交给系统）。
  function goMobileBack(): void {
    if (drawerOpen.value) { drawerOpen.value = false; return }
    if (mview.value === 'read' || mview.value === 'account') {
      if (typeof window !== 'undefined' && window.history) window.history.back()
      return
    }
  }
  // 切视图时回到列表级：若在阅读窗，走 history.back() 让 popstate 驱动回退，
  // 保持历史栈与界面同步（直接改 mview 会让栈顶多一个 read，
  // 下一次系统返回要多按一次才生效）；历史未初始化（init 恢复阶段）时直接改。
  function backToMobileAccount(): void {
    if (window.innerWidth >= 1024) return
    if (mview.value === 'read' && historyInitialized && typeof window !== 'undefined' && window.history) {
      window.history.back()
      return
    }
    mview.value = 'account'
  }
  // 跨断点补初始化（审计 #5 前端轨 S4）：桌面端打开后把窗口缩到 1024 以下时，
  // initMobileHistory 在 init() 里已因宽度跳过（且未置位），靠这次 resize
  // 补搭历史栈；只注册一次，store 是单例、常驻应用生命周期。
  let mobileHistoryResizeBound = false
  function watchMobileBreakpoint(): void {
    if (mobileHistoryResizeBound || typeof window === 'undefined') return
    mobileHistoryResizeBound = true
    window.addEventListener('resize', () => {
      if (!historyInitialized && window.innerWidth < 1024) initMobileHistory()
    })
  }
  // 供 MailView 卸载时注销 popstate（store 是单例常驻，监听需手动清）。
  function destroyMobileHistory(): void {
    if (typeof window !== 'undefined') window.removeEventListener('popstate', onHistoryPop)
    historyInitialized = false
  }
  function enterMobileAccount(accountId: number): void { void selectAccount(accountId) }
  function setMobileAccount(accountId: number | null): void { mobileAccountId.value = accountId }

  // ---- 实时推送：Socket.io 单连接（契约定稿） ----
  // 前端只与 Node 建一个 Socket.io 连接（src/realtime.ts），不直连 IMAP。
  // 事件驱动 unreadCounts：new-mail 未读+1、mail-updated 按 isRead 变化增减，
  // 删信时未读总数即时减少；导航树红色角标绑定 unreadCounts，即时亮起，
  // 不轮询、不整页刷新、不重新拉全量。
  // 同步完成后的重载防抖：多个账号挨个 done 时合并成一次 loadAccounts + loadMessages，
  // 否则 28 个邮箱的 done 事件会把列表反复冲刷 28 次（M3）。
  let syncReloadTimer: ReturnType<typeof setTimeout> | null = null
  function scheduleSyncReload(): void {
    if (syncReloadTimer) clearTimeout(syncReloadTimer)
    syncReloadTimer = setTimeout(() => {
      syncReloadTimer = null
      void loadAccounts()
      // 后台重载（F7）：失败时保留旧列表、不闪空，只弹 toast。
      void loadMessages({ keepChecked: true, background: true })
    }, 1500)
  }
  // 新邮件插到列表顶部时的滚动补偿计数（审计 #5 LOW）：MessageList 监听它，
  // 用户已往下滚时把滚动位置下移一行，保持当前可见内容不动。
  const topInsertCount = ref<number>(0)
  // 该文件夹是否属于当前视图（供跨标签页移信判断）：folder 视图按
  // accountId + folderId 精确匹配；聚合视图按文件夹类型匹配，
  // 文件夹类型未加载出来时保守地认为还在视图里（不误删行）。
  // all-unread 只按已读状态归属，移文件夹不改变归属。
  function rowBelongsToView(accountId: number, folderId: number): boolean {
    if (view.value.kind === 'folder') {
      return view.value.accountId === accountId && view.value.folderId === folderId
    }
    if (view.value.kind === 'all-unread') return true
    const type = (foldersByAccount.value[accountId] || []).find((f) => f.id === folderId)?.type
    if (!type) return true
    if (view.value.kind === 'all-inbox') return type === 'inbox'
    if (view.value.kind === 'all-sent') return type === 'sent'
    if (view.value.kind === 'all-trash') return type === 'trash'
    return true
  }
  let realtime: ReturnType<typeof createRealtime> | null = null
  function handleRealtime(msg: RealtimeEvent): void {
    if (!msg || !msg.type) return
    if (msg.type === 'new-mail') {
      const m = msg.message
      if (!m) return
      // 文件夹类型（懒加载：未点开过的账号可能没有）：供 all-sent/all-trash 判断。
      const folderType = (foldersByAccount.value[m.accountId] || []).find((f) => f.id === m.folderId)?.type
      // 新邮件只在收件箱类文件夹里产生（后端只对收件箱文件夹发 new-mail，
      // 见 engine.ts），所以 all-inbox 不用再校验 folderPath 含不含 INBOX。
      const inView =
        (view.value.kind === 'all-inbox') ||
        (view.value.kind === 'all-unread' && !m.isRead) ||
        (view.value.kind === 'folder' && m.accountId === view.value.accountId && m.folderId === view.value.folderId) ||
        (view.value.kind === 'all-sent' && folderType === 'sent') ||
        (view.value.kind === 'all-trash' && folderType === 'trash')
      // 分页：新邮件只挂在第 1 页顶部；在第 2 页以后时只加总数、不插进当前页
      if (inView && !mailList.value.some((x) => x.id === m.id)) {
        if (page.value === 1) {
          mailList.value.unshift(m)
          topInsertCount.value += 1
        }
        total.value += 1
      } else if (!inView && (view.value.kind === 'all-sent' || view.value.kind === 'all-trash') && !folderType) {
        // 当前在已发送/已删除视图、且该账号文件夹未加载过，无法判断新邮件
        // 是否属于当前视图：防抖重载一次兜底（1.5 秒合并，不会刷屏）。
        // 注：后端目前只对收件箱发 new-mail（engine.ts:786），此分支现为
        // 防御性兜底；若后端以后对已发送/已删除也发事件，这里直接生效。
        scheduleSyncReload()
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
      } else if (!row && msg.changes && msg.changes.isRead === false && msg.accountId) {
        // 反向：在别处被标为未读（读→未读的转变，后端只在转变时发，见
        // engine.setRead 开头的无变化返回与同步路径的 readChanged 判断），
        // 不在当前列表里也加一次未读，避免角标滞后。
        bumpUnread(msg.accountId, msg.folderId ?? null, 1)
      }
      // 跨标签页移信（审计 #5 前端轨 S3）：changes.folderId 变了，说明邮件
      // 被移到了另一个文件夹。若新文件夹不在当前视图的归属里，照
      // mail-deleted 的逻辑把行拿掉并调整 total/未读数，避免列表里滞留
      // 已移走的信；还在当前视图里时才把 changes 合并进本行。
      // 未读数按变化后的已读状态算（changes.isRead 有值时用它，否则用行旧值），
      // 避免 isRead 与 folderId 同事件变化时重复增减。
      if (row && msg.changes && typeof msg.changes.folderId === 'number' && msg.changes.folderId !== row.folderId) {
        if (!rowBelongsToView(msg.accountId ?? row.accountId, msg.changes.folderId)) {
          if (!(msg.changes.isRead ?? row.isRead)) bumpUnread(row.accountId, row.folderId, -1)
          mailList.value = mailList.value.filter((m) => m.id !== msg.messageId)
          if (!(batchDeleting.value && isDeletingHere.value)) {
            total.value = Math.max(0, total.value - 1)
            void backIfPageEmpty()
          }
          if (selectedId.value === msg.messageId) { selectedId.value = null; selectedMessage.value = null }
        } else {
          Object.assign(row, msg.changes || {})
        }
      } else if (row) {
        Object.assign(row, msg.changes || {})
      }
      if (selectedMessage.value?.id === msg.messageId) Object.assign(selectedMessage.value, msg.changes || {})
    } else if (msg.type === 'mail-deleted') {
      const row = mailList.value.find((m) => m.id === msg.messageId)
      if (row) {
        if (!row.isRead) bumpUnread(row.accountId, row.folderId, -1)
        mailList.value = mailList.value.filter((m) => m.id !== msg.messageId)
        // 自己发起的批量删除正在跑（同视图）：total 由 deleteChecked 按后端
        // deleted 计数一次性减，这里只删行、不再减，避免重复计数；
        // 其他来源（别的标签页/设备/同步发现）的删除在这里减 total 并回页。
        if (!(batchDeleting.value && isDeletingHere.value)) {
          total.value = Math.max(0, total.value - 1)
          void backIfPageEmpty()
        }
      }
      if (selectedId.value === msg.messageId) { selectedId.value = null; selectedMessage.value = null }
    } else if (msg.type === 'sync') {
      const acct = accounts.value.find((a) => a.id === msg.accountId)
      if (acct) acct.status = msg.state === 'started' ? 'syncing' : (msg.state === 'error' ? 'error' : 'online')
      if (msg.state === 'done') scheduleSyncReload()
    } else if (msg.type === 'account') {
      void loadAccounts()
    }
  }
  function connectRealtime(): void {
    if (typeof window === 'undefined' || realtime) return
    // M2：Socket 断线重连后对账一次——断线期间可能漏了新邮件/已读/删除事件，
    // 只靠事件驱动会一直对不上；轻量拉一次账号与当前视图即可。
    realtime = createRealtime(handleRealtime, {
      onConnect: () => { void loadAccounts(); void loadMessages({ keepChecked: true, background: true }) }
    })
  }
  function disconnectRealtime(): void {
    if (realtime) { realtime.disconnect(); realtime = null }
    // 断开实时连接时也停掉删除状态轮询（F3）：登出后不再每 1.5 秒请求。
    stopDeletePolling()
    deleteStatusFailures = 0
  }

  // 退出后重进（或刷新后重进）：先清掉上一次会话残留的选择/搜索/页码/列表，
  // 再由 restoreView/restoreMobileState 按 localStorage 恢复导航与阅读状态。
  // MailView 的 logout 会调它（与 disconnectRealtime 一起），退出时清干净，
  // 下次 init 重进时再统一清一次。
  function resetSessionState(): void {
    // 会话重置时停掉删除状态轮询（F3）：登出后不再每 1.5 秒请求 delete-status。
    stopDeletePolling()
    deleteStatusFailures = 0
    pendingBatchDelete = null
    batchDeleting.value = false
    deleteRemaining.value = 0
    deleteView.value = null
    selectedId.value = null
    selectedMessage.value = null
    searchQuery.value = ''
    page.value = 1
    mailList.value = []
    total.value = 0
    checkedIds.value = new Set()
  }

  async function init(): Promise<void> {
    resetSessionState()
    // 懒加载：初始化只加载一级账号名，不预加载任何账号的文件夹；
    // 文件夹在点邮箱行 / 折叠箭头时才按需加载。
    await Promise.all([loadAccounts(), loadSettings()])
    // 旧本机草稿一次性迁移（见 migrateLocalDrafts）：要在恢复导航前做，
    // 落在草稿视图时迁移完的草稿能直接显示。
    await migrateLocalDrafts()
    // 手机端状态先读出来存着，再恢复导航——restoreView 会改 mview 并触发保存，
    // 若恢复完再读 localStorage，正在读信的状态已被“列表”盖掉，回不到正文。
    let savedMobile: { mview?: string; mobileAccountId?: number | null; selectedId?: number | string | null } | null = null
    if (window.innerWidth < 1024) {
      try { savedMobile = JSON.parse(localStorage.getItem(MOBILE_STATE_KEY) || 'null') } catch { savedMobile = null }
    }
    // 恢复上次选中的导航（无记录/记录失效时默认所有收件箱）。
    await restoreView()
    // 手机/平板再恢复在哪一级（列表/正在读的信），桌面端这步直接跳过。
    await restoreMobileState(savedMobile)
    // 跨断点补初始化（见 watchMobileBreakpoint）：桌面端打开后缩窗时补搭历史栈。
    watchMobileBreakpoint()
    // 手机/平板浏览器历史：按恢复到的 mview 搭好 home → account → read，
    // 让系统返回手势/返回键先退应用内一级，而不是直接退出到浏览器空白页。
    initMobileHistory()
    // 刷新回来后，若后端批量删除任务还在跑，继续显示“删除中…”并轮询到完成。
    void syncDeleteStatus()
    connectRealtime()
  }

  return {
    accounts, foldersByAccount, expanded, view, mailList, total, loading, page, totalPages,
    activeAccountId, activeFolder,
    searchQuery, selectedId, selectedMessage, checkedIds, checkedCount, isAllChecked, isSomeChecked, batchDeleting, deleteRemaining, isDeletingHere,
    readingLoading, refreshingAll,
    settings, drafts, composeDraft, toast, confirmRequest, requestConfirm, resolveConfirm, suppressLoadFailToast, unreadCounts, unreadOfAccount, unreadOfFolder, topInsertCount,
    mview, mobileAccountId, drawerOpen,
    totalUnread, mobileAccount, isTrashView,
    showToast, loadAccounts, loadFolders, inboxFolderId,
    setAggregate, setFolderView, setAccountUnread, selectAccount, toggleAccountExpand,
    loadMessages, goToPage, nextPage, prevPage, setSearch, openMessage, setRead, deleteMessage, moveToSpam,
    toggleCheck, toggleCheckAll, clearChecked, deleteChecked,
    loadDrafts, upsertDraft, dropDraft, deleteDraft, refreshAll, refreshAccount,
    goMobileBack, enterMobileAccount, setMobileAccount,
    disconnectRealtime, resetSessionState, destroyMobileHistory, init
  }
})
