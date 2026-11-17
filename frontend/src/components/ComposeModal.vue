<template>
  <div v-if="open" class="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4">
    <div class="bg-white rounded-lg shadow-xl w-[560px] max-w-full flex flex-col overflow-hidden max-h-[92vh]">
      <div class="flex items-center justify-between px-5 py-3 border-b border-blue-100">
        <span class="font-bold text-slate-700">{{ isEdit ? '编辑草稿' : '写信' }}</span>
        <button class="text-slate-400 hover:text-slate-600" aria-label="关闭" @click="close"><i class="fa-solid fa-xmark"></i></button>
      </div>
      <div class="p-5 space-y-3 overflow-y-auto">
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
        <button class="px-4 py-2 rounded-md text-sm text-slate-600 hover:bg-slate-100" :disabled="busy" @click="saveDraft">存草稿</button>
        <button class="px-4 py-2 rounded-md text-sm text-slate-600 hover:bg-slate-100" @click="close">取消</button>
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
  draftId?: string | null
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
const draftId = ref<string | null>(null)
const isEdit = ref<boolean>(false)
const files = ref<File[]>([])
const busy = ref<boolean>(false)
const error = ref<string>('')

watch(() => props.open, (v) => {
  if (!v) return
  const init = props.initial || {}
  to.value = init.to || ''
  cc.value = init.cc || ''
  subject.value = init.subject || ''
  body.value = init.body || ''
  draftId.value = init.draftId || null
  isEdit.value = !!init.draftId
  files.value = []
  error.value = ''
  busy.value = false
  accountId.value = init.accountId || mail.settings.defaultAccountId || mail.activeAccountId || mail.accounts[0]?.id || null
})

function onFiles(e: Event): void {
  files.value = Array.from((e.target as HTMLInputElement).files || [])
  // 有附件且主题为空时，主题自动填第一个附件的文件名；已填了主题的不覆盖。
  if (files.value.length && !subject.value.trim()) {
    subject.value = files.value[0].name
  }
}

function buildText(): string {
  let text = body.value || ''
  if (mail.settings.signature) text += `\n\n-- \n${mail.settings.signature}`
  return text
}

async function send(): Promise<void> {
  error.value = ''
  if (!to.value.trim()) { error.value = '请填写收件人。'; return }
  if (!subject.value.trim()) { error.value = '请填写主题。'; return }
  if (!accountId.value) { error.value = '没有可用的发件邮箱，请先添加邮箱。'; return }
  busy.value = true
  try {
    if (files.value.length) {
      const fd = new FormData()
      fd.append('accountId', String(accountId.value))
      fd.append('to', to.value.trim())
      if (cc.value.trim()) fd.append('cc', cc.value.trim())
      fd.append('subject', subject.value.trim() || '（无主题）')
      fd.append('text', buildText())
      for (const f of files.value) fd.append('attachments', f)
      await api.sendMessage(fd)
    } else {
      await api.sendMessageJson({
        accountId: accountId.value,
        to: to.value.split(',').map((s) => s.trim()).filter(Boolean),
        cc: cc.value ? cc.value.split(',').map((s) => s.trim()).filter(Boolean) : [],
        subject: subject.value.trim() || '（无主题）',
        text: buildText()
      })
    }
    if (draftId.value) mail.deleteLocalDraft(draftId.value)
    mail.showToast('已发送')
    emit('sent')
    close()
    // 发信后切到所有已发送（与旧版一致）
    mail.setAggregate('all-sent')
  } catch (e) {
    error.value = e instanceof ApiError ? e.message : '发送失败，请重试。'
  } finally {
    busy.value = false
  }
}

function saveDraft(): void {
  mail.saveLocalDraft({
    id: draftId.value || undefined,
    accountId: accountId.value,
    to: to.value.trim(),
    subject: subject.value.trim(),
    text: body.value
  })
  close()
  mail.setAggregate('all-drafts')
}

function close(): void { emit('close') }
</script>
