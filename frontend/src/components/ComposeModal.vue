<template>
  <div v-if="open" class="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4">
    <div class="bg-white rounded-lg shadow-xl w-[560px] max-w-full flex flex-col overflow-hidden max-h-[92vh]">
      <div class="flex items-center justify-between px-5 py-3 border-b border-blue-100">
        <span class="font-bold text-slate-700">{{ isEdit ? '编辑草稿' : '写信' }}</span>
        <button class="text-slate-400 hover:text-slate-600 disabled:opacity-40 disabled:pointer-events-none" aria-label="关闭" :disabled="busy" @click="close()"><i class="fa-solid fa-xmark"></i></button>
      </div>
      <div class="flex-1 min-h-0 p-5 space-y-3 overflow-y-auto">
        <div class="flex items-center gap-2">
          <label class="w-12 text-xs text-slate-500 shrink-0">发件人</label>
          <select v-model="accountId" class="flex-1 border border-slate-200 rounded-md px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-blue-400 focus:border-blue-400 bg-white">
            <option v-for="(a, i) in mail.accounts" :key="a.id" :value="a.id">【{{ String(i + 1).padStart(2, '0') }}】{{ a.displayName || a.email }}</option>
          </select>
        </div>
        <div class="flex items-center gap-2">
          <label class="w-12 text-xs text-slate-500 shrink-0">收件人</label>
          <input v-model="to" type="text" placeholder="收件人邮箱，多个用逗号分隔" class="flex-1 border border-slate-200 rounded-md px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-blue-400 focus:border-blue-400">
        </div>
        <div class="flex items-center gap-2">
          <label class="w-12 text-xs text-slate-500 shrink-0">抄送</label>
          <input v-model="cc" type="text" placeholder="抄送（选填）" class="flex-1 border border-slate-200 rounded-md px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-blue-400 focus:border-blue-400">
        </div>
        <div class="flex items-center gap-2">
          <label class="w-12 text-xs text-slate-500 shrink-0">主题 <span class="text-red-500">*</span></label>
          <input v-model="subject" type="text" placeholder="主题（必填）" class="flex-1 border border-slate-200 rounded-md px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-blue-400 focus:border-blue-400">
        </div>
        <textarea v-model="body" rows="8" placeholder="正文..." class="w-full border border-slate-200 rounded-md px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-blue-400 focus:border-blue-400 resize-y"></textarea>
        <div class="flex items-center gap-2">
          <label class="inline-flex items-center gap-1.5 text-xs text-slate-500 cursor-pointer px-3 py-2 border border-slate-200 rounded-md hover:bg-slate-50">
            <i class="fa-solid fa-paperclip"></i> 添加附件
            <input type="file" multiple class="hidden" @change="onFiles">
          </label>
          <span v-if="files.length" class="text-xs text-slate-500">{{ files.map((f) => f.name).join('、') }}</span>
        </div>
        <p v-if="error" class="text-xs text-red-500 bg-red-50 border border-red-100 rounded-lg px-3 py-2">{{ error }}</p>
      </div>
      <div class="flex items-center justify-end gap-2 px-5 py-3 border-t border-blue-100 bg-slate-50/50">
        <button class="px-4 py-2 rounded-md text-sm text-slate-600 hover:bg-slate-100" :disabled="busy || draftSaving" @click="saveDraft">存草稿</button>
        <button class="px-4 py-2 rounded-md text-sm text-slate-600 hover:bg-slate-100 disabled:opacity-40" :disabled="busy" @click="close()">取消</button>
        <button class="px-5 py-2 rounded-md text-sm bg-blue-500 hover:bg-blue-600 text-white font-medium disabled:opacity-60" :disabled="busy" @click="send">{{ busy ? '发送中…' : '发送' }}</button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue'
import type { PropType } from 'vue'
import { api, ApiError } from '../api'
import { useMailStore } from '../stores/mail'

export interface ComposeInitial {
  to?: string
  cc?: string
  subject?: string
  body?: string
  accountId?: number | null
  draftId?: number | string | null
  /** 回复 threading：原信 Message-ID，作 In-Reply-To（转发不传） */
  inReplyTo?: string
  /** 回复/转发 threading：References 链 */
  references?: string | string[]
}

const props = defineProps({
  open: { type: Boolean, default: false },
  // initial: { to, cc, subject, body, accountId, draftId? }（回复/转发/编辑草稿时传入）
  initial: { type: Object as PropType<ComposeInitial>, default: () => ({}) }
})
const emit = defineEmits(['close', 'sent'])
const mail = useMailStore()

const to = ref<string>('')
const cc = ref<string>('')
const subject = ref<string>('')
const body = ref<string>('')
const accountId = ref<number | null>(null)
const draftId = ref<number | string | null>(null)
const isEdit = ref<boolean>(false)
const files = ref<File[]>([])
const busy = ref<boolean>(false)
const error = ref<string>('')
// 回复/转发 threading（审计 #10 H1）：原信 Message-ID 与 References 链，
// 由 MailView 的 reply()/forward() 经 initial 传进来；打开弹窗时记下，
// 发信时两条路径都带上（回复带 In-Reply-To + References，转发只带 References）。
const inReplyTo = ref<string>('')
const references = ref<string | string[] | undefined>(undefined)
// 发信幂等键（F9）：每打开一次写信弹窗生成一个，同一封邮件重试发送复用
// 同一个 key（后端去重），新开一封则重新生成。
const idempotencyKey = ref<string>('')
function newIdempotencyKey(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  } catch { /* 回落到时间戳+随机数 */ }
  return `lm-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

// 服务端草稿自动保存（2026-11-18 用户定夺：草稿进数据库）：输入停约 1 秒
// 后 PUT 更新，首次保存 POST 建草稿；发信成功后服务端按 draftId 自动删草稿。
const draftSaving = ref<boolean>(false) // 存草稿锁：防并行 PUT 乱序，也防极快双击造两条草稿（F5）
let autosaveTimer: ReturnType<typeof setTimeout> | null = null
const lastSaved = ref<{ accountId: number | null; to: string; subject: string; text: string; inReplyTo?: string; references?: string; cc?: string[] } | null>(null)
// 审计 #11 H1/L15：草稿契约带 threading（inReplyTo/references）与抄送 cc——
// 重开草稿再发仍是同一会话，cc 不再丢失；references 数组转空格串（后端契约），
// cc 字符串转数组；空值不进快照（后端按缺省处理）。
function draftSnapshot(): { accountId: number | null; to: string; subject: string; text: string; inReplyTo?: string; references?: string; cc?: string[] } {
  return {
    accountId: accountId.value, to: to.value.trim(), subject: subject.value.trim(), text: body.value,
    inReplyTo: inReplyTo.value || undefined,
    references: Array.isArray(references.value) ? references.value.join(' ') : references.value || undefined,
    cc: splitAddrs(cc.value)
  }
}
function sameSnapshot(a: { accountId: number | null; to: string; subject: string; text: string; inReplyTo?: string; references?: string; cc?: string[] }, b: { accountId: number | null; to: string; subject: string; text: string; inReplyTo?: string; references?: string; cc?: string[] }): boolean {
  return a.accountId === b.accountId && a.to === b.to && a.subject === b.subject && a.text === b.text
    && (a.inReplyTo || '') === (b.inReplyTo || '') && (a.references || '') === (b.references || '')
    && (a.cc || []).join(',') === (b.cc || []).join(',')
}
 // 返回 true 表示草稿已落盘（或无内容可存、无需保存）；false 表示应保存
 // 却未存上——调用方（显式存草稿/关闭）须提示用户，不要当成功处理。
 // 审计 #14 BLOCKER：以前返回 void 且 catch 静默吞错，“存草稿”按钮调它
 // 时根本不知道保存有没有发生，关窗 + 切视图假装成功，回复草稿就这么丢了。
async function autosaveDraft(force = false): Promise<boolean> {
  if (!props.open) return false
  const snap = draftSnapshot()
  // 审计 #15 LOW-5：正文只敲空格/换行也算“空内容”，不建空白草稿——
  // 判空时 text 按 trim 后算；保存内容本身仍用原值，不改用户输入。
  if (!snap.to && !snap.subject && !snap.text.trim()) return true // 空内容不建草稿
  // 审计 #15 MED-1：没有发件邮箱时不发保存请求（后端必 400），调用方
  // 按 false 处理；显式保存由 saveDraft 先报“没有可用的发件邮箱”。
  if (accountId.value == null) return false
  // 内容与上次已保存的快照一致：服务端已有该草稿（draftId 非空）时直接算
  // 成功；draftId 为空说明从未落盘过——回复/转发预填内容以前在打开时就
  // 被记成 lastSaved，不改字点“存草稿”会在这里被跳过、一次 POST 都不发。
  // 只有显式保存（force）才强制 POST；后台自动保存仍跳过、等显式保存。
  if (lastSaved.value && sameSnapshot(lastSaved.value, snap)) {
    if (draftId.value != null) return true
    if (!force) return false
  }
  if (draftSaving.value) {
    // 正在存：等它存完再存一次（避免并行 PUT 乱序），最多等 3 秒；
    // 等不到就返回 false（调用方提示失败），不要当成功处理。
    const deadline = Date.now() + 3000
    while (draftSaving.value && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100))
    if (draftSaving.value) return false
    if (lastSaved.value && sameSnapshot(lastSaved.value, draftSnapshot())) {
      if (draftId.value != null) return true
      if (!force) return false
    }
  }
  draftSaving.value = true
  try {
    const saved = draftId.value
      ? (await api.updateDraft(draftId.value, draftSnapshot())).draft
      : (await api.createDraft({ ...draftSnapshot(), idempotencyKey: idempotencyKey.value })).draft
    if (saved?.id) {
      draftId.value = saved.id
      isEdit.value = true
      if (saved.idempotencyKey) idempotencyKey.value = saved.idempotencyKey
      mail.upsertDraft(saved)
      lastSaved.value = draftSnapshot()
      return true
    }
    return false
  } catch { /* 保存失败返回 false：自动保存静默重试，显式保存由调用方提示用户 */ return false }
  finally { draftSaving.value = false }
}
function scheduleAutosave(): void {
  if (autosaveTimer) clearTimeout(autosaveTimer)
  autosaveTimer = setTimeout(() => { autosaveTimer = null; void autosaveDraft() }, 1000)
}

watch(() => props.open, (v) => {
  if (!v) return
  if (autosaveTimer) { clearTimeout(autosaveTimer); autosaveTimer = null }
  const init = props.initial || {}
  // 幂等键随草稿持久化（审计 #5）：重开已有草稿复用它存的 key，
  // 发信时后端按 key 去重；新开一封才生成新 key。先查服务端草稿列表，
  // 再查 openMessage 交来的 composeDraft（草稿视图外打开时用）。
  const existingDraft = init.draftId
    ? (mail.drafts.find((d) => d.id === init.draftId) || mail.composeDraft)
    : null
  idempotencyKey.value = existingDraft?.idempotencyKey || newIdempotencyKey()
  to.value = init.to || ''
  // 审计 #11 H1/L15：打开时 threading/cc 先取 init、再回落已有草稿（重开草稿
  // 时 initial 未必带这三项，草稿对象里有；都不带时为空）。
  cc.value = init.cc || (existingDraft?.cc || []).join(', ') || ''
  subject.value = init.subject || ''
  body.value = init.body || ''
  draftId.value = init.draftId ?? null
  isEdit.value = init.draftId != null
  inReplyTo.value = init.inReplyTo || existingDraft?.inReplyTo || ''
  references.value = init.references ?? existingDraft?.references
  files.value = []
  error.value = ''
  busy.value = false
  accountId.value = init.accountId || mail.settings.defaultAccountId || mail.activeAccountId || mail.accounts[0]?.id || null
  // 打开时的内容只在重开已有草稿时记为“已保存”（内容确实已在服务端）；
  // 新草稿（含回复/转发预填）记为 null，直到第一次真正保存成功才赋值——
  // 审计 #14 BLOCKER：以前预填内容一打开就被记成已保存，回复后不改字点
  // “存草稿”会被 sameSnapshot 守卫跳过、静默丢失。
  lastSaved.value = init.draftId != null ? draftSnapshot() : null
  // 审计 #13 LOW-5：重开草稿时幂等键可能被重生成——drafts 若过期、
  // composeDraft 又已被 MailView 置 null，existingDraft 找不到就生成了
  // 新 key。发信失败且服务端其实已发出的模糊重试窗口里可能重复发信。
  // 有 draftId 但没找到草稿时，先刷新一次草稿列表再定 key；draftId 已
  // 先行记下，自动保存走 PUT、不受 key 影响，刷新回来仍找不到才用新 key。
  if (init.draftId != null && !existingDraft) {
    const did = init.draftId
    void (async () => {
      try { await mail.loadDrafts() } catch { /* 拉不到就用已生成的 key */ }
      if (draftId.value !== did) return // 期间已关窗/换了草稿，不动
      const found = mail.drafts.find((d) => d.id === did)
      if (found?.idempotencyKey) idempotencyKey.value = found.idempotencyKey
    })()
  }
})

// 输入防抖自动保存（约 1 秒）：cc 进草稿契约（审计 #11 L15），改抄送也触发保存。
watch([to, cc, subject, body, accountId], () => { if (props.open) scheduleAutosave() })

function onFiles(e: Event): void {
  files.value = Array.from((e.target as HTMLInputElement).files || [])
  // 有附件且主题为空时，主题自动填第一个附件的文件名；已填了主题的不覆盖。
  if (files.value.length && !subject.value.trim()) {
    subject.value = files.value[0].name
  }
}

function buildText(): string {
  // 签名只由后端统一加（发信时后端读 settings.signature 追加），前端不再追加，
  // 否则每封发出的邮件正文末尾会出现两次签名。
  return body.value || ''
}

// 发信前收件人/抄送格式校验（用户 2026-11-19 要求：收件人必填、格式
// 不正确不得发送）。与后端 messageRoutes.ts 的 isValidEmail 用同一正则，
// 只判格式是否合法，不做 DNS/可达性检查；接受 + 号、子域名、多级域名。
// 分隔按半角/全角逗号都认（与后端 splitAddrList 一致）。
const EMAIL_RE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/
function splitAddrs(v: string): string[] {
  return v.split(/[,，]/).map((s) => s.trim()).filter(Boolean)
}
function validateSendAddrs(): string | null {
  const tos = splitAddrs(to.value)
  if (!tos.length) return '请填写收件人。'
  const badTo = tos.filter((a) => !EMAIL_RE.test(a))
  if (badTo.length) return `收件人邮箱格式不正确：${badTo.slice(0, 3).join('、')}`
  const badCc = splitAddrs(cc.value).filter((a) => !EMAIL_RE.test(a))
  if (badCc.length) return `抄送邮箱格式不正确：${badCc.slice(0, 3).join('、')}`
  return null
}

async function send(): Promise<void> {
  // 入口重入守卫（F5）：极快双击“发送”只发一次；busy 在 finally 里复位。
  if (busy.value) return
  error.value = ''
  const addrError = validateSendAddrs()
  if (addrError) { error.value = addrError; return }
  if (!subject.value.trim()) { error.value = '请填写主题。'; return }
  if (!accountId.value) { error.value = '没有可用的发件邮箱，请先添加邮箱。'; return }
  busy.value = true
  try {
    // 先把当前内容落盘成草稿（发信失败时草稿保留在服务端，可重开续发）；
    // 发信成功后服务端按 draftId 自动删草稿，前端再清本地状态。
    await autosaveDraft()
    let sent: { id?: number; warning?: string; rejected?: string[] } | null = null
    if (files.value.length) {
      const fd = new FormData()
      fd.append('accountId', String(accountId.value))
      fd.append('to', to.value.trim())
      if (cc.value.trim()) fd.append('cc', cc.value.trim())
      fd.append('subject', subject.value.trim() || '（无主题）')
      fd.append('text', buildText())
      fd.append('idempotencyKey', idempotencyKey.value)
      if (draftId.value != null) fd.append('draftId', String(draftId.value))
      // 回复 threading：multipart 字段只能是字符串，References 链拼成一个空格分隔串
      //（后端按单个字符串收，再拼进 References 头，效果与数组一致）。
      if (inReplyTo.value) fd.append('inReplyTo', inReplyTo.value)
      if (references.value) fd.append('references', Array.isArray(references.value) ? references.value.join(' ') : references.value)
      for (const f of files.value) fd.append('attachments', f)
      sent = await api.sendMessage(fd)
    } else {
      sent = await api.sendMessageJson({
        accountId: accountId.value,
        to: splitAddrs(to.value),
        cc: cc.value ? splitAddrs(cc.value) : [],
        subject: subject.value.trim() || '（无主题）',
        text: buildText(),
        idempotencyKey: idempotencyKey.value,
        ...(draftId.value != null ? { draftId: draftId.value } : {}),
        ...(inReplyTo.value ? { inReplyTo: inReplyTo.value } : {}),
        ...(references.value ? { references: references.value } : {})
      })
    }
    if (draftId.value != null) { mail.dropDraft(draftId.value); draftId.value = null }
    // 发信成功提示 4 秒；warning 表示已发出、但未存入已发送文件夹。
    // 部分拒收（审计 #10 M2）先判：rejected 非空时报被拒收名单，别报“发送成功”误导用户。
    if (sent?.rejected?.length) mail.showToast(`已发送，但以下收件人被拒收：${sent.rejected.join('、')}`, 4000)
    else mail.showToast(sent?.warning ? '已发送，但未存入已发送文件夹' : '发送成功', 4000)
    // 随后切视图触发的 loadMessages 若失败，别让失败 toast 盖掉“发送成功”。
    mail.suppressLoadFailToast(4000)
    emit('sent')
    await close({ skipSave: true }) // 发信成功后草稿已删，不能再强制存回来
    // 发信后切到所有已发送（与旧版一致），再用 201 返回的 id 直接打开
    // 刚发的信；拿不到 id 时只出列表（不自动打开，由用户自己点开）。
    await mail.setAggregate('all-sent')
    // 审计 #11 M8：发信后打开刚发的信失败时不弹“打开邮件失败”（静默处理），
    // 别让它盖掉“发送成功”。
    if (sent?.id) await mail.openMessage(sent.id, { silentFail: true })
  } catch (e) {
    // SMTP 451 灰名单兜底（审计 #10 正确性 L4）：后端文案优先——后端返回的
    // 451 文案本身就带“请 5 分钟后再发”时原样显示；只有后端文案里没给
    // 指引（只提到 451/灰名单）时，前端才映射为固定文案。
    const msg = e instanceof ApiError ? e.message : ''
    if (e instanceof ApiError && /451|灰名单/.test(msg) && !msg.includes('5 分钟')) error.value = '请 5 分钟后再发'
    else error.value = e instanceof ApiError ? e.message : '发送失败，请重试。'
  } finally {
    busy.value = false
  }
}

async function saveDraft(): Promise<void> {
  // 手动存草稿：显式保存必须强制落盘（跳过“没改过就不存”守卫），
  // 保存失败时报错且不关窗、不切视图，让用户能重试——审计 #14 BLOCKER：
  // 以前守卫跳过保存后照样关窗切视图，回复草稿就这么静默丢了。
  if (autosaveTimer) { clearTimeout(autosaveTimer); autosaveTimer = null }
  // 审计 #15 MED-1：没有发件邮箱时后端 POST /api/drafts 必 400——
  // 直接报“没有可用的发件邮箱”，别当成普通保存失败。
  if (!accountId.value) { error.value = '没有可用的发件邮箱，请先添加邮箱'; return }
  const ok = await autosaveDraft(true)
  if (!ok) { error.value = '草稿保存失败，请重试'; return }
  await close({ skipSave: true })
  await mail.setAggregate('all-drafts')
}

async function close(opts: { skipSave?: boolean } = {}): Promise<void> {
  // 关闭前把未存的改动落盘：显式强制保存一次；保存失败时报错、不关窗，
  // 避免静默丢弃（同款 bug：以前只调 autosaveDraft，守卫一跳过就丢了）。
  // 空内容仍不建草稿。发信成功后调 close({ skipSave: true })，草稿已删、
  // 不能再存回来。
  if (autosaveTimer) { clearTimeout(autosaveTimer); autosaveTimer = null }
  if (!opts.skipSave) {
    // 审计 #15 MED-1：没有发件邮箱时（零邮箱，或写信中途账号被另一标签页
    // 删掉）无内容可存、直接关窗；零邮箱的写信入口已在 MailView 拦住，
    // 这里是中途丢账号的防御。
    if (accountId.value != null) {
      const ok = await autosaveDraft(true)
      if (!ok) {
        // 保存失败时给明确出口：用户点“确定”才放弃未保存的改动并关闭，
        // 点“取消”留在窗口里继续编辑/重试——绝不能静默丢弃，也不能
        // 像审计 #14 那样永远关不掉（那时只挡住关窗、没给出口）。
        error.value = '草稿保存失败，请重试'
        const discard = await mail.requestConfirm('草稿保存失败，是否放弃未保存的改动并关闭？', true)
        if (!discard) return
      }
    }
  }
  emit('close')
}
</script>
