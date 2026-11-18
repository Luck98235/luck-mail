<template>
  <div v-if="open" class="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4">
    <div class="bg-white rounded-lg shadow-xl w-[560px] max-w-full flex flex-col overflow-hidden max-h-[92vh]">
      <div class="flex items-center justify-between px-5 py-3 border-b border-blue-100">
        <span class="font-bold text-slate-700">{{ isEdit ? '编辑草稿' : '写信' }}</span>
        <button class="text-slate-400 hover:text-slate-600 disabled:opacity-40 disabled:pointer-events-none" aria-label="关闭" :disabled="busy" @click="close"><i class="fa-solid fa-xmark"></i></button>
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
        <button class="px-4 py-2 rounded-md text-sm text-slate-600 hover:bg-slate-100 disabled:opacity-40" :disabled="busy" @click="close">取消</button>
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
const lastSaved = ref<{ accountId: number | null; to: string; subject: string; text: string } | null>(null)
function draftSnapshot(): { accountId: number | null; to: string; subject: string; text: string } {
  return { accountId: accountId.value, to: to.value.trim(), subject: subject.value.trim(), text: body.value }
}
function sameSnapshot(a: { accountId: number | null; to: string; subject: string; text: string }, b: { accountId: number | null; to: string; subject: string; text: string }): boolean {
  return a.accountId === b.accountId && a.to === b.to && a.subject === b.subject && a.text === b.text
}
async function autosaveDraft(): Promise<void> {
  if (!props.open) return
  const snap = draftSnapshot()
  if (!snap.to && !snap.subject && !snap.text) return // 空内容不建草稿
  if (lastSaved.value && sameSnapshot(lastSaved.value, snap)) return // 打开后没改过，不存
  if (draftSaving.value) {
    // 正在存：等它存完再存一次（避免并行 PUT 乱序），最多等 3 秒；
    // 等不到就放弃本次，下次输入/关闭时再触发。
    const deadline = Date.now() + 3000
    while (draftSaving.value && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100))
    if (draftSaving.value) return
    if (lastSaved.value && sameSnapshot(lastSaved.value, draftSnapshot())) return
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
    }
  } catch { /* 自动保存失败不打扰用户：下次输入或关闭时再试 */ }
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
  cc.value = init.cc || ''
  subject.value = init.subject || ''
  body.value = init.body || ''
  draftId.value = init.draftId ?? null
  isEdit.value = init.draftId != null
  files.value = []
  error.value = ''
  busy.value = false
  accountId.value = init.accountId || mail.settings.defaultAccountId || mail.activeAccountId || mail.accounts[0]?.id || null
  // 打开时的内容记为“已保存”：用户没改就不触发自动保存。
  lastSaved.value = draftSnapshot()
})

// 输入防抖自动保存（约 1 秒）：cc 不进草稿契约，不监听。
watch([to, subject, body, accountId], () => { if (props.open) scheduleAutosave() })

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

async function send(): Promise<void> {
  // 入口重入守卫（F5）：极快双击“发送”只发一次；busy 在 finally 里复位。
  if (busy.value) return
  error.value = ''
  if (!to.value.trim()) { error.value = '请填写收件人。'; return }
  if (!subject.value.trim()) { error.value = '请填写主题。'; return }
  if (!accountId.value) { error.value = '没有可用的发件邮箱，请先添加邮箱。'; return }
  busy.value = true
  try {
    // 先把当前内容落盘成草稿（发信失败时草稿保留在服务端，可重开续发）；
    // 发信成功后服务端按 draftId 自动删草稿，前端再清本地状态。
    await autosaveDraft()
    let sent: { id?: number; warning?: string } | null = null
    if (files.value.length) {
      const fd = new FormData()
      fd.append('accountId', String(accountId.value))
      fd.append('to', to.value.trim())
      if (cc.value.trim()) fd.append('cc', cc.value.trim())
      fd.append('subject', subject.value.trim() || '（无主题）')
      fd.append('text', buildText())
      fd.append('idempotencyKey', idempotencyKey.value)
      if (draftId.value != null) fd.append('draftId', String(draftId.value))
      for (const f of files.value) fd.append('attachments', f)
      sent = await api.sendMessage(fd)
    } else {
      sent = await api.sendMessageJson({
        accountId: accountId.value,
        to: to.value.split(',').map((s) => s.trim()).filter(Boolean),
        cc: cc.value ? cc.value.split(',').map((s) => s.trim()).filter(Boolean) : [],
        subject: subject.value.trim() || '（无主题）',
        text: buildText(),
        idempotencyKey: idempotencyKey.value,
        ...(draftId.value != null ? { draftId: draftId.value } : {})
      })
    }
    if (draftId.value != null) { mail.dropDraft(draftId.value); draftId.value = null }
    // 发信成功提示 4 秒；warning 表示已发出、但未存入已发送文件夹。
    mail.showToast(sent?.warning ? '已发送，但未存入已发送文件夹' : '发送成功', 4000)
    // 随后切视图触发的 loadMessages 若失败，别让失败 toast 盖掉“发送成功”。
    mail.suppressLoadFailToast(4000)
    emit('sent')
    close()
    // 发信后切到所有已发送（与旧版一致），再用 201 返回的 id 直接打开
    // 刚发的信；失败时回落到通用规则（setAggregate 已按无选中自动打开第一封）。
    await mail.setAggregate('all-sent')
    if (sent?.id) await mail.openMessage(sent.id)
  } catch (e) {
    error.value = e instanceof ApiError ? e.message : '发送失败，请重试。'
  } finally {
    busy.value = false
  }
}

async function saveDraft(): Promise<void> {
  // 手动存草稿：先清掉待触发的自动保存，立刻存一次（走同一条 autosaveDraft，
  // 首次 POST、之后 PUT），存完关弹窗并切到所有草稿。
  if (autosaveTimer) { clearTimeout(autosaveTimer); autosaveTimer = null }
  await autosaveDraft()
  close()
  await mail.setAggregate('all-drafts')
}

function close(): void {
  // 关闭前把未存的改动落盘（静默失败，不阻塞关闭；autosaveDraft 自己会
  // 跳过空内容与未改动的内容）。
  if (autosaveTimer) { clearTimeout(autosaveTimer); autosaveTimer = null }
  void autosaveDraft()
  emit('close')
}
</script>
