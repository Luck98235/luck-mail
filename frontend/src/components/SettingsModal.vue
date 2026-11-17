<template>
  <div v-if="open" class="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4">
    <div class="bg-white rounded-lg shadow-xl w-[480px] max-w-full flex flex-col overflow-hidden max-h-[92vh]">
      <div class="flex items-center justify-between px-5 py-3 border-b border-blue-100">
        <span class="font-bold text-slate-700">设置</span>
        <button class="text-slate-400 hover:text-slate-600" aria-label="关闭" @click="close"><i class="fa-solid fa-xmark"></i></button>
      </div>
      <div class="p-5 space-y-6 overflow-y-auto text-sm">
        <!-- 用户名 -->
        <section>
          <h3 class="font-medium text-slate-700 mb-2">用户名</h3>
          <div class="space-y-2">
            <div class="flex items-center gap-2">
              <input v-model="username" type="text" name="username" autocomplete="off" placeholder="用户名" class="flex-1 min-w-0 border border-slate-200 rounded-md px-3 py-2 outline-none focus:ring-1 focus:ring-blue-400 focus:border-blue-400">
              <button class="px-4 py-2 rounded-md text-sm bg-blue-500 hover:bg-blue-600 text-white disabled:opacity-60 shrink-0" :disabled="nameBusy || !username.trim() || username.trim() === auth.username" @click="changeUsername">{{ nameBusy ? '保存中…' : '保存' }}</button>
            </div>
            <p v-if="nameMsg" class="text-xs rounded-lg px-3 py-2" :class="nameOk ? 'text-green-600 bg-green-50 border border-green-100' : 'text-red-500 bg-red-50 border border-red-100'">{{ nameMsg }}</p>
          </div>
        </section>

        <!-- 修改密码 -->
        <section class="border-t border-slate-100 pt-4">
          <h3 class="font-medium text-slate-700 mb-2">修改密码</h3>
          <div class="space-y-2">
            <!-- 诱饵用户名框：浏览器打开设置时要找个地方填用户名，没有它就会把用户名填进外面的搜索框 -->
            <input type="text" name="username" autocomplete="username" :value="auth.username" tabindex="-1" aria-hidden="true" class="absolute opacity-0 pointer-events-none h-0 w-0">
            <input v-model="current" :type="showCurrent ? 'text' : 'password'" name="current-password" autocomplete="current-password" placeholder="当前密码" class="w-full border border-slate-200 rounded-md px-3 py-2 outline-none focus:ring-1 focus:ring-blue-400 focus:border-blue-400">
            <input v-model="next" :type="showNext ? 'text' : 'password'" name="new-password" autocomplete="new-password" placeholder="新密码（至少 8 位）" class="w-full border border-slate-200 rounded-md px-3 py-2 outline-none focus:ring-1 focus:ring-blue-400 focus:border-blue-400">
            <input v-model="confirm" :type="showNext ? 'text' : 'password'" name="new-password-confirm" autocomplete="new-password" placeholder="确认新密码" class="w-full border border-slate-200 rounded-md px-3 py-2 outline-none focus:ring-1 focus:ring-blue-400 focus:border-blue-400">
            <div class="flex items-center justify-between">
              <label class="flex items-center gap-2 text-xs text-slate-500 cursor-pointer"><input v-model="showNext" type="checkbox" class="accent-blue-500"> 显示新密码</label>
              <button class="px-4 py-1.5 rounded-md text-sm bg-blue-500 hover:bg-blue-600 text-white disabled:opacity-60" :disabled="pwBusy" @click="changePassword">{{ pwBusy ? '保存中…' : '修改密码' }}</button>
            </div>
            <p v-if="pwMsg" class="text-xs rounded-lg px-3 py-2" :class="pwOk ? 'text-green-600 bg-green-50 border border-green-100' : 'text-red-500 bg-red-50 border border-red-100'">{{ pwMsg }}</p>
          </div>
        </section>

        <!-- 默认账号 -->
        <section class="border-t border-slate-100 pt-4">
          <h3 class="font-medium text-slate-700 mb-2">默认账号</h3>
          <select v-model="defaultAccountId" class="w-full border border-slate-200 rounded-md px-3 py-2 outline-none focus:ring-1 focus:ring-blue-400 focus:border-blue-400 bg-white">
            <option :value="null">（未设置）</option>
            <option v-for="(a, idx) in mail.accounts" :key="a.id" :value="a.id">[{{ String(idx + 1).padStart(2, '0') }}] {{ a.displayName || a.email }}</option>
          </select>
          <p class="text-xs text-slate-400 mt-1.5">写信时默认用这个邮箱发件。</p>
        </section>

        <!-- 签名 -->
        <section class="border-t border-slate-100 pt-4">
          <h3 class="font-medium text-slate-700 mb-2">签名</h3>
          <textarea v-model="signature" rows="3" placeholder="发信时自动加在正文末尾" class="w-full border border-slate-200 rounded-md px-3 py-2 outline-none focus:ring-1 focus:ring-blue-400 focus:border-blue-400 resize-y"></textarea>
        </section>

        <!-- 备份 -->
        <section class="border-t border-slate-100 pt-4">
          <h3 class="font-medium text-slate-700 mb-2">备份</h3>
          <p class="text-xs text-slate-400 mb-2">把加密密钥与全部数据（数据库、邮件正文、附件缓存）打包下载到本地。密钥与数据必须一起保存，缺一不可；解压到新服务器的 /opt/luck-mail 即可恢复。</p>
          <button class="px-4 py-2 rounded-md text-sm bg-blue-500 hover:bg-blue-600 text-white disabled:opacity-60" :disabled="backupBusy" @click="downloadBackup">{{ backupBusy ? '正在打包…' : '备份到本地' }}</button>
          <p v-if="backupMsg" class="text-xs rounded-lg px-3 py-2 mt-2" :class="backupOk ? 'text-green-600 bg-green-50 border border-green-100' : 'text-red-500 bg-red-50 border border-red-100'">{{ backupMsg }}</p>
        </section>

        <p v-if="error" class="text-xs text-red-500 bg-red-50 border border-red-100 rounded-lg px-3 py-2">{{ error }}</p>
      </div>
      <div class="flex items-center justify-end gap-2 px-5 py-3 border-t border-blue-100 bg-slate-50/50">
        <button class="px-4 py-2 rounded-md text-sm text-slate-600 hover:bg-slate-100" @click="close">取消</button>
        <button class="px-5 py-2 rounded-md text-sm bg-blue-800 hover:bg-blue-900 text-white font-medium disabled:opacity-60" :disabled="busy" @click="save">{{ busy ? '保存中…' : '确定' }}</button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue'
import { api, ApiError } from '../api'
import { useAuthStore } from '../stores/auth'
import { useMailStore } from '../stores/mail'

const props = defineProps({ open: { type: Boolean, default: false }, openPassword: { type: Boolean, default: false } })
const emit = defineEmits(['close'])
const auth = useAuthStore()
const mail = useMailStore()

const username = ref<string>('')
const nameBusy = ref<boolean>(false)
const nameMsg = ref<string>('')
const nameOk = ref<boolean>(false)
const current = ref<string>('')
const next = ref<string>('')
const confirm = ref<string>('')
const showCurrent = ref<boolean>(false)
const showNext = ref<boolean>(false)
const pwBusy = ref<boolean>(false)
const pwMsg = ref<string>('')
const pwOk = ref<boolean>(false)
const defaultAccountId = ref<number | null>(null)
const signature = ref<string>('')
const backupBusy = ref<boolean>(false)
const backupMsg = ref<string>('')
const backupOk = ref<boolean>(false)
const busy = ref<boolean>(false)
const error = ref<string>('')

watch(() => props.open, (v) => {
  if (!v) return
  username.value = auth.username || ''
  nameMsg.value = ''
  current.value = ''
  next.value = ''
  confirm.value = ''
  pwMsg.value = ''
  error.value = ''
  defaultAccountId.value = mail.settings.defaultAccountId ?? null
  signature.value = mail.settings.signature || ''
})

async function changeUsername(): Promise<void> {
  nameMsg.value = ''
  nameOk.value = false
  const name = username.value.trim()
  if (!name) { nameMsg.value = '用户名必填。'; return }
  if (name.includes('@')) { nameMsg.value = '用户名不要带邮箱后缀。'; return }
  if (name === auth.username) return
  nameBusy.value = true
  try {
    const data = await api.changeUsername(name)
    auth.username = data.username || name
    nameOk.value = true
    nameMsg.value = '用户名已修改。'
  } catch (e) {
    nameMsg.value = e instanceof ApiError ? e.message : '修改失败，请重试。'
  } finally {
    nameBusy.value = false
  }
}

async function changePassword(): Promise<void> {
  pwMsg.value = ''
  pwOk.value = false
  if (next.value.length < 8) { pwMsg.value = '新密码至少 8 位。'; return }
  if (next.value !== confirm.value) { pwMsg.value = '两次输入的新密码不一致。'; return }
  pwBusy.value = true
  try {
    await api.changePassword(current.value, next.value)
    pwOk.value = true
    pwMsg.value = '密码已修改。'
    current.value = ''
    next.value = ''
    confirm.value = ''
  } catch (e) {
    pwMsg.value = e instanceof ApiError ? e.message : '修改失败，请重试。'
  } finally {
    pwBusy.value = false
  }
}

async function downloadBackup(): Promise<void> {
  backupMsg.value = ''
  backupOk.value = false
  backupBusy.value = true
  try {
    const { blob, filename } = await api.downloadBackup()
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 5000)
    backupOk.value = true
    backupMsg.value = `备份已开始下载（${filename}），请妥善保存。`
  } catch (e) {
    backupMsg.value = e instanceof ApiError ? e.message : '备份失败，请重试。'
  } finally {
    backupBusy.value = false
  }
}

async function save(): Promise<void> {
  error.value = ''
  busy.value = true
  try {
    await api.updateSettings({ signature: signature.value, defaultAccountId: defaultAccountId.value })
    mail.settings = { signature: signature.value, defaultAccountId: defaultAccountId.value }
    mail.showToast('设置已保存')
    close()
  } catch (e) {
    error.value = e instanceof ApiError ? e.message : '保存失败，请重试。'
  } finally {
    busy.value = false
  }
}

function close(): void { emit('close') }
</script>
