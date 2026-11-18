<template>
  <div v-if="open" class="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4">
    <div class="bg-white rounded-lg shadow-xl w-[520px] max-w-full flex flex-col overflow-hidden max-h-[92vh]">
      <div class="flex items-center justify-between px-5 py-3 border-b border-blue-100">
        <span class="font-bold text-slate-700">{{ editing ? '邮箱设置' : '添加邮箱' }}</span>
        <button class="text-slate-400 hover:text-slate-600" aria-label="关闭" @click="close"><i class="fa-solid fa-xmark"></i></button>
      </div>
      <div class="flex-1 min-h-0 p-5 space-y-3 overflow-y-auto text-sm">
        <p class="text-xs text-slate-400">创建时后端会实测 IMAP + SMTP 连通。</p>
        <div>
          <label class="block text-xs text-slate-500 mb-1">邮件帐号</label>
          <input v-model="form.email" type="email" autocomplete="off" :disabled="!!editing" class="w-full border border-slate-200 rounded-md px-3 py-2 outline-none focus:ring-1 focus:ring-blue-400 focus:border-blue-400 disabled:bg-slate-50" @blur="autofill" @input="autofill">
        </div>
        <div>
          <label class="block text-xs text-slate-500 mb-1">密码 <span class="text-slate-400">（163/QQ 请填客户端授权码，不是网页密码）</span></label>
          <div class="relative">
            <input v-model="form.password" :type="showPw ? 'text' : 'password'" autocomplete="new-password" class="w-full border border-slate-200 rounded-md px-3 py-2 pr-10 outline-none focus:ring-1 focus:ring-blue-400 focus:border-blue-400">
            <button type="button" class="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 w-7 h-7" @click="showPw = !showPw">
              <i :class="showPw ? 'fa-regular fa-eye-slash' : 'fa-regular fa-eye'"></i>
            </button>
          </div>
        </div>
        <div>
          <label class="block text-xs text-slate-500 mb-1">备注名（别名，选填）</label>
          <input v-model="form.displayName" type="text" autocomplete="off" class="w-full border border-slate-200 rounded-md px-3 py-2 outline-none focus:ring-1 focus:ring-blue-400 focus:border-blue-400">
        </div>

        <div class="border-t border-slate-100 pt-3 space-y-3">
          <div class="font-medium text-slate-700 text-[13px]">接收服务器（IMAP）</div>
          <div class="grid grid-cols-[1fr_110px] gap-2">
            <input v-model="form.imapHost" type="text" autocomplete="off" class="border border-slate-200 rounded-md px-3 py-2 outline-none focus:ring-1 focus:ring-blue-400 focus:border-blue-400">
            <input v-model.number="form.imapPort" type="number" autocomplete="off" class="border border-slate-200 rounded-md px-3 py-2 outline-none focus:ring-1 focus:ring-blue-400 focus:border-blue-400">
          </div>
          <div class="flex items-center gap-4">
            <label class="flex items-center gap-1.5 text-xs text-slate-600"><input v-model="form.imapSecure" type="radio" value="SSL" class="accent-blue-500"> SSL</label>
            <label class="flex items-center gap-1.5 text-xs text-slate-600"><input v-model="form.imapSecure" type="radio" value="STARTTLS" class="accent-blue-500"> STARTTLS</label>
          </div>

          <div class="font-medium text-slate-700 text-[13px] pt-1">发送服务器（SMTP）</div>
          <div class="grid grid-cols-[1fr_110px] gap-2">
            <input v-model="form.smtpHost" type="text" autocomplete="off" class="border border-slate-200 rounded-md px-3 py-2 outline-none focus:ring-1 focus:ring-blue-400 focus:border-blue-400">
            <input v-model.number="form.smtpPort" type="number" autocomplete="off" class="border border-slate-200 rounded-md px-3 py-2 outline-none focus:ring-1 focus:ring-blue-400 focus:border-blue-400">
          </div>
          <div class="flex items-center gap-4">
            <label class="flex items-center gap-1.5 text-xs text-slate-600"><input v-model="form.smtpSecure" type="radio" value="SSL" class="accent-blue-500"> SSL</label>
            <label class="flex items-center gap-1.5 text-xs text-slate-600"><input v-model="form.smtpSecure" type="radio" value="STARTTLS" class="accent-blue-500"> STARTTLS</label>
          </div>
          <p v-if="presetNote" class="text-xs text-blue-500">{{ presetNote }}</p>
        </div>

        <p v-if="error" class="text-xs text-red-500 bg-red-50 border border-red-100 rounded-lg px-3 py-2 whitespace-pre-wrap">{{ error }}</p>
      </div>
      <div class="flex items-center justify-end gap-2 px-5 py-3 border-t border-blue-100 bg-slate-50/50">
        <button v-if="editing" class="px-4 py-2 rounded-md text-sm text-slate-600 hover:bg-slate-100" :disabled="busy" @click="test">测试连通</button>
        <button class="px-4 py-2 rounded-md text-sm text-slate-600 hover:bg-slate-100" @click="close">取消</button>
        <button v-if="!editing" class="px-4 py-2 rounded-md text-sm text-slate-600 hover:bg-slate-100" @click="back">返回</button>
        <button class="px-5 py-2 rounded-md text-sm bg-blue-500 hover:bg-blue-600 text-white font-medium disabled:opacity-60" :disabled="busy" @click="submit">{{ busy ? '验证中…' : (editing ? '保存' : '创建') }}</button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue'
import type { PropType } from 'vue'
import { api, ApiError } from '../api'
import { useMailStore } from '../stores/mail'
import type { Account, SecureKind } from '../types'

const props = defineProps({
  open: { type: Boolean, default: false },
  editing: { type: Object as PropType<Account | null>, default: null } // 账号对象（编辑模式）或 null（新增）
})
const emit = defineEmits(['close', 'back', 'saved'])
const mail = useMailStore()

interface AccountForm {
  email: string
  password: string
  displayName: string
  imapHost: string
  imapPort: number
  imapSecure: SecureKind
  smtpHost: string
  smtpPort: number
  smtpSecure: SecureKind
}

const empty = (): AccountForm => ({
  email: '', password: '', displayName: '',
  imapHost: '', imapPort: 993, imapSecure: 'SSL',
  smtpHost: '', smtpPort: 465, smtpSecure: 'SSL'
})
const form = ref<AccountForm>(empty())
const showPw = ref<boolean>(false)
const busy = ref<boolean>(false)
const error = ref<string>('')
const presetNote = ref<string>('')
// 预设表缓存：弹窗打开时拉一次，之后按域名同步查，不用每次等接口，
// 输完域名立刻就能填好服务器，不用等失焦、也不怕接口慢一拍。
const presetsCache = ref<Record<string, { imapHost: string; imapPort: number; imapSecure: string; smtpHost: string; smtpPort: number; smtpSecure: string; note: string }> | null>(null)
const lastAutofillDomain = ref<string>('')

watch(() => props.open, (v) => {
  if (!v) return
  error.value = ''
  presetNote.value = ''
  busy.value = false
  showPw.value = false
  lastAutofillDomain.value = ''
  if (!props.editing && !presetsCache.value) {
    api.presets().then((d) => { presetsCache.value = d.presets || {} }).catch(() => { /* 拉不到就走单域名接口 */ })
  }
  if (props.editing) {
    const a = props.editing
    form.value = {
      email: a.email, password: '', displayName: a.displayName || '',
      imapHost: a.imapHost || '', imapPort: a.imapPort || 993, imapSecure: a.imapSecure || 'SSL',
      smtpHost: a.smtpHost || '', smtpPort: a.smtpPort || 465, smtpSecure: a.smtpSecure || 'SSL'
    }
    // 回填当前密码：打开设置就能看到，点小眼睛显示明文；取不到就留空（仍可手工输入新密码保存）。
    api.getAccountPassword(a.id).then((d) => {
      if (props.open && props.editing && props.editing.id === a.id) form.value.password = d.password || ''
    }).catch(() => { /* 取不到就留空，不阻塞编辑 */ })
  } else form.value = empty()
})

// 按域名自动填服务器：输入时就触发（不用等失焦），域名没变不重复填，
// 避免把用户手工改过的服务器又覆盖掉。优先用缓存的预设表同步查，
// 缓存还没到就走单域名接口；接口失败也不阻塞，保留手工输入。
async function autofill(): Promise<void> {
  const email = form.value.email.trim()
  const domain = (email.split('@')[1] || '').toLowerCase()
  if (!domain || !domain.includes('.') || props.editing) return
  if (domain === lastAutofillDomain.value) return
  lastAutofillDomain.value = domain
  const apply = (p: { imapHost: string; imapPort: number; imapSecure: string; smtpHost: string; smtpPort: number; smtpSecure: string } | null, note: string): void => {
    if (p) {
      form.value.imapHost = p.imapHost; form.value.imapPort = p.imapPort; form.value.imapSecure = p.imapSecure as 'SSL' | 'STARTTLS'
      form.value.smtpHost = p.smtpHost; form.value.smtpPort = p.smtpPort; form.value.smtpSecure = p.smtpSecure as 'SSL' | 'STARTTLS'
      presetNote.value = note || `已按 ${domain} 自动填入服务器信息。`
    } else {
      // 未知域名：契约回落 imap./smtp.+domain
      form.value.imapHost = `imap.${domain}`; form.value.imapPort = 993; form.value.imapSecure = 'SSL'
      form.value.smtpHost = `smtp.${domain}`; form.value.smtpPort = 465; form.value.smtpSecure = 'SSL'
      presetNote.value = '该域名没有预设，已按通用规则填入 imap./smtp. 服务器，请核对。'
    }
  }
  const cached = presetsCache.value?.[domain]
  if (cached) { apply(cached, cached.note || ''); return }
  try {
    const data = await api.preset(domain)
    // 竞态：等接口回来时用户可能已改了邮箱域名，若不一致就丢弃这次结果，
    // 避免把 A 域名的服务器填进已改成 B 域名的表单里。
    const nowDomain = (form.value.email.trim().split('@')[1] || '').toLowerCase()
    if (nowDomain !== domain) return
    const p = data.preset
    if (p) apply(p, data.note || '')
    else apply(null, '')
  } catch { /* 预设失败不阻塞，保留手工输入 */ }
}

async function submit(): Promise<void> {
  error.value = ''
  if (!form.value.email.trim()) { error.value = '请填写邮箱地址。'; return }
  if (!props.editing && !form.value.password) { error.value = '请填写密码（163/QQ 请填客户端授权码）。'; return }
  busy.value = true
  try {
    if (props.editing) {
      const payload: Record<string, unknown> = {
        displayName: form.value.displayName || undefined,
        imapHost: form.value.imapHost, imapPort: form.value.imapPort, imapSecure: form.value.imapSecure,
        smtpHost: form.value.smtpHost, smtpPort: form.value.smtpPort, smtpSecure: form.value.smtpSecure
      }
      if (form.value.password) payload.password = form.value.password
      await api.updateAccount(props.editing.id, payload)
      mail.showToast('邮箱设置已保存')
    } else {
      await api.createAccount({
        email: form.value.email.trim(),
        password: form.value.password,
        displayName: form.value.displayName || undefined,
        imapHost: form.value.imapHost || undefined,
        imapPort: form.value.imapPort || undefined,
        imapSecure: form.value.imapSecure,
        smtpHost: form.value.smtpHost || undefined,
        smtpPort: form.value.smtpPort || undefined,
        smtpSecure: form.value.smtpSecure
      })
      mail.showToast('邮箱添加成功，正在同步')
    }
    await mail.loadAccounts()
    emit('saved')
    close()
  } catch (e) {
    // 后端返回的错误原样显示（说明哪一步连通失败）
    error.value = e instanceof ApiError ? e.message : '操作失败，请重试。'
  } finally {
    busy.value = false
  }
}

async function test(): Promise<void> {
  if (!props.editing) return
  error.value = ''
  busy.value = true
  try {
    const r = await api.testAccount(props.editing.id)
    if (r.imapOk && r.smtpOk) mail.showToast('IMAP 与 SMTP 连通正常')
    else error.value = r.error || `连通测试未通过：IMAP ${r.imapOk ? '正常' : '失败'}，SMTP ${r.smtpOk ? '正常' : '失败'}。`
  } catch (e) {
    error.value = e instanceof ApiError ? e.message : '测试失败，请重试。'
  } finally {
    busy.value = false
  }
}

function back(): void { emit('back') }
function close(): void { emit('close') }
</script>
