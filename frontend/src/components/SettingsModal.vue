<template>
  <div v-if="open" class="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4">
    <div class="bg-white rounded-lg shadow-xl w-[480px] max-w-full flex flex-col overflow-hidden max-h-[92vh]">
      <div class="flex items-center justify-between px-5 py-3 border-b border-blue-100">
        <span class="font-bold text-slate-700">设置</span>
        <button class="text-slate-400 hover:text-slate-600" aria-label="关闭" @click="closeWithConfirm"><i class="fa-solid fa-xmark"></i></button>
      </div>
      <div class="flex-1 min-h-0 p-5 space-y-6 overflow-y-auto text-sm">
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
            <!-- 三个密码框都禁止自动填入（用户 2026-11-19 要求：旧密码必须
                 手动填写；同日补充：新密码、确认新密码也不许自动填充）：
                 以前旧密码框写着 name/autocomplete="current-password"，新
                 密码框写着 name/autocomplete="new-password"，又配了上面
                 的隐藏用户名诱饵框，浏览器一打开设置就把已保存的登录密码
                 填进来（黄底 + 圆点）；前端 ref 本来就是空的，从未主动回填。
                 修复复用搜索框的防自动填充手法：未聚焦时 readonly（浏览器
                 不往只读框里自动填），聚焦后才可编辑；同时去掉会招填充的
                 name/autocomplete 信号（current-password / new-password）。
                 隐藏用户名诱饵框保留不动——它防的是另一个老问题（没有它
                 浏览器会把用户名填进外面的搜索框）。 -->
            <input v-model="current" type="password" name="old-password" autocomplete="off" placeholder="当前密码" :readonly="!currentFocused" @focus="currentFocused = true" @blur="currentFocused = false" class="w-full border border-slate-200 rounded-md px-3 py-2 outline-none focus:ring-1 focus:ring-blue-400 focus:border-blue-400">
            <input v-model="next" :type="showNext ? 'text' : 'password'" name="new-password-field" autocomplete="off" placeholder="新密码（至少 8 位）" :readonly="!nextFocused" @focus="nextFocused = true" @blur="nextFocused = false" class="w-full border border-slate-200 rounded-md px-3 py-2 outline-none focus:ring-1 focus:ring-blue-400 focus:border-blue-400">
            <input v-model="confirm" :type="showNext ? 'text' : 'password'" name="new-password-confirm-field" autocomplete="off" placeholder="确认新密码" :readonly="!confirmFocused" @focus="confirmFocused = true" @blur="confirmFocused = false" class="w-full border border-slate-200 rounded-md px-3 py-2 outline-none focus:ring-1 focus:ring-blue-400 focus:border-blue-400">
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

        <!-- 新邮件通知 -->
        <section class="border-t border-slate-100 pt-4">
          <h3 class="font-medium text-slate-700 mb-2">新邮件通知</h3>
          <label class="flex items-center gap-2 cursor-pointer">
            <input v-model="notifyOn" type="checkbox" class="accent-blue-500 w-4 h-4" :disabled="!notifySupported || notifyPermission === 'denied'" @change="onNotifyToggle">
            <span>有新邮件时在浏览器弹出通知</span>
          </label>
          <p class="text-xs text-slate-400 mt-1.5">{{ notifyStatusText }}</p>
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
        <button class="px-4 py-2 rounded-md text-sm text-slate-600 hover:bg-slate-100" @click="closeWithConfirm">取消</button>
        <button class="px-5 py-2 rounded-md text-sm bg-blue-800 hover:bg-blue-900 text-white font-medium disabled:opacity-60" :disabled="busy" @click="save">{{ busy ? '保存中…' : '确定' }}</button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { api, ApiError } from '../api'
import { downloadBlob } from '../utils'
import { getNotifyPermission, isNotifySupported, requestNotifyPermission } from '../utils/notify'
import { useAuthStore } from '../stores/auth'
import { useMailStore } from '../stores/mail'

const props = defineProps({ open: { type: Boolean, default: false } })
const emit = defineEmits(['close'])
const auth = useAuthStore()
const mail = useMailStore()

const username = ref<string>('')
const nameBusy = ref<boolean>(false)
const nameMsg = ref<string>('')
const nameOk = ref<boolean>(false)
const current = ref<string>('')
const currentFocused = ref<boolean>(false) // 旧密码框防自动填充：聚焦前只读（同搜索框）
const next = ref<string>('')
const nextFocused = ref<boolean>(false) // 新密码框防自动填充：聚焦前只读（同旧密码框）
const confirm = ref<string>('')
const confirmFocused = ref<boolean>(false) // 确认新密码框防自动填充：聚焦前只读（同旧密码框）
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
// 新邮件通知：开关即改即存（与改密码/改用户名一样，不等底下的“确定”）。
const notifyOn = ref<boolean>(false)
const notifySupported = ref<boolean>(true)
const notifyPermission = ref<NotificationPermission | 'unsupported'>('default')
const notifyStatusText = computed(() => {
  if (!notifySupported.value) return '此浏览器不支持通知'
  if (notifyPermission.value === 'denied') return '已被浏览器屏蔽，请在浏览器设置里重新允许'
  return notifyOn.value ? '已开启：页面不在前台时，有新邮件会弹出系统通知。' : '已关闭'
})

watch(() => props.open, (v) => {
  if (!v) return
  username.value = auth.username || ''
  nameMsg.value = ''
  nameOk.value = false
  current.value = ''
  currentFocused.value = false
  next.value = ''
  nextFocused.value = false
  confirm.value = ''
  confirmFocused.value = false
  showNext.value = false
  pwMsg.value = ''
  pwOk.value = false
  error.value = ''
  backupMsg.value = ''
  backupOk.value = false
  defaultAccountId.value = mail.settings.defaultAccountId ?? null
  signature.value = mail.settings.signature || ''
  // 审计 #11 L22：打开弹窗时若通知权限已被拒（denied），开关显示为关——
  // 权限被拒时通知根本弹不出来，开关还显示开启是误导；开关本身已禁用（见模板）。
  notifyOn.value = getNotifyPermission() === 'denied' ? false : mail.notifyEnabled
  notifySupported.value = isNotifySupported()
  notifyPermission.value = getNotifyPermission()
})

// 跨标签同步（审计 #10 安全 L6）：弹窗打开期间另一标签页改了通知开关，
// 本地 notifyOn 只在打开时同步一次、会滞后；监听 store 的变化实时同步。
// 审计 #11 L22：权限被拒时同步值也按关显示（与打开时一致）。
watch(() => mail.notifyEnabled, (v) => { if (props.open) notifyOn.value = getNotifyPermission() === 'denied' ? false : v })

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
  // 审计 #19 LOW-2：旧密码必填须前端先拦——用户要求旧密码“必须手动填写”，
  // 空着点“修改密码”不应发请求，只应提示（后端 400 只是兜底）。
  if (!current.value) { pwMsg.value = '请填写当前密码。'; return }
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
    downloadBlob(blob, filename)
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
    // 用户名改了但没点旁边的“保存”：确定时一并提交，避免悄悄丢掉
    const name = username.value.trim()
    if (name && name !== auth.username) {
      if (name.includes('@')) { error.value = '用户名不要带邮箱后缀。'; return }
      await changeUsername()
      if (!nameOk.value) { error.value = nameMsg.value || '用户名保存失败。'; return }
    }
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

async function onNotifyToggle(): Promise<void> {
  // 关：直接落盘。
  if (!notifyOn.value) { mail.setNotifyEnabled(false); return }
  // 开：必须由这次点击触发，浏览器才允许弹授权框。
  if (!isNotifySupported()) { notifyOn.value = false; return }
  const p = await requestNotifyPermission()
  notifyPermission.value = p
  if (p === 'granted') {
    mail.setNotifyEnabled(true)
  } else {
    // 拒绝或关掉授权框：开关回落到关。
    notifyOn.value = false
    mail.setNotifyEnabled(false)
  }
}

function close(): void { emit('close') }

// 未保存改动确认（审计 #10 布局 L5）：签名与默认账号只在点“确定”时提交，
// X/取消直接关会静默丢掉——与邮箱管理弹窗同模式，脏则先确认放弃。
// 用户名与密码是即点即存，不受影响；保存成功后已与 store 一致，不会误弹。
const hasUnsavedEdits = computed<boolean>(() =>
  signature.value !== (mail.settings.signature || '') ||
  (defaultAccountId.value ?? null) !== (mail.settings.defaultAccountId ?? null)
)
async function closeWithConfirm(): Promise<void> {
  if (hasUnsavedEdits.value) {
    const ok = await mail.requestConfirm('设置里的改动尚未保存，确定放弃吗？')
    if (!ok) return
  }
  close()
}
</script>
