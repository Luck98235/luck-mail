<template>
  <div class="app-min-viewport bg-slate-50 flex items-center justify-center px-4">
    <div class="w-full max-w-sm bg-white rounded-2xl shadow-lg border border-slate-100 px-8 py-10">
      <!-- Logo -->
      <div class="flex flex-col items-center mb-8">
        <div class="w-12 h-12 bg-gradient-to-br from-blue-400 to-blue-600 rounded-xl flex items-center justify-center shadow-sm text-white text-xl mb-3">
          <i class="fa-solid fa-clover"></i>
        </div>
        <h1 class="font-black text-blue-700 tracking-wide text-xl">Luck-Mail</h1>
        <p class="text-xs text-slate-400 mt-1">{{ isSetup ? '创建管理员账号（首次使用）' : '欢迎回来，请登录' }}</p>
      </div>

      <form @submit.prevent="submit" class="space-y-4">
        <div>
          <label class="block text-xs text-slate-500 mb-1.5">用户名</label>
          <input
            v-model="username" type="text" autocomplete="username"
            class="w-full border border-slate-200 rounded-lg px-3 py-2.5 text-sm outline-none focus:ring-1 focus:ring-blue-400 focus:border-blue-400"
          >
        </div>
        <div>
          <label class="block text-xs text-slate-500 mb-1.5">密码</label>
          <div class="relative">
            <input
              v-model="password" :type="showPassword ? 'text' : 'password'" autocomplete="current-password"
              placeholder="密码" class="w-full border border-slate-200 rounded-lg px-3 py-2.5 pr-10 text-sm outline-none focus:ring-1 focus:ring-blue-400 focus:border-blue-400"
            >
            <button type="button" class="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 w-7 h-7" :title="showPassword ? '隐藏密码' : '显示密码'" @click="showPassword = !showPassword">
              <i :class="showPassword ? 'fa-regular fa-eye-slash' : 'fa-regular fa-eye'"></i>
            </button>
          </div>
        </div>
        <div v-if="isSetup">
          <label class="block text-xs text-slate-500 mb-1.5">确认密码</label>
          <div class="relative">
            <input
              v-model="confirm" :type="showConfirm ? 'text' : 'password'" autocomplete="new-password"
              placeholder="再输入一次密码" class="w-full border border-slate-200 rounded-lg px-3 py-2.5 pr-10 text-sm outline-none focus:ring-1 focus:ring-blue-400 focus:border-blue-400"
            >
            <button type="button" class="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 w-7 h-7" @click="showConfirm = !showConfirm">
              <i :class="showConfirm ? 'fa-regular fa-eye-slash' : 'fa-regular fa-eye'"></i>
            </button>
          </div>
          <p class="text-xs text-slate-400 mt-1.5">密码至少 8 位。</p>
        </div>

        <label v-if="!isSetup" class="flex items-center gap-2 text-xs text-slate-500 select-none cursor-pointer">
          <input v-model="remember" type="checkbox" class="accent-blue-500 w-4 h-4">
          30天内免登录
        </label>

        <p v-if="error" class="text-xs text-red-500 bg-red-50 border border-red-100 rounded-lg px-3 py-2">{{ error }}</p>

        <button
          type="submit" :disabled="busy"
          class="w-full bg-blue-500 hover:bg-blue-600 disabled:opacity-60 text-white py-2.5 rounded-lg font-medium text-sm shadow-sm transition-colors"
        >
          {{ busy ? '请稍候…' : (isSetup ? '创建账号并登录' : '登录') }}
        </button>
      </form>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { useAuthStore } from '../stores/auth'

const router = useRouter()
const auth = useAuthStore()

const username = ref<string>('')
const password = ref<string>('')
const confirm = ref<string>('')
const showPassword = ref<boolean>(false)
const showConfirm = ref<boolean>(false)
const remember = ref<boolean>(false)
const busy = ref<boolean>(false)
const error = ref<string>('')

const isSetup = computed(() => auth.setupRequired)

onMounted(async () => {
  if (!auth.checked) await auth.checkStatus()
  try { remember.value = localStorage.getItem('luck-mail-remember') === '1' } catch { /* 忽略 */ }
})

async function submit(): Promise<void> {
  error.value = ''
  if (!username.value.trim()) { error.value = '请输入用户名。'; return }
  // 密码 ≥8 位只在创建账号时校验（isSetup）：登录时不拦短密码，
  // 老账号的密码可能短于 8 位，拦了就永远登不进去了。
  if (isSetup.value && password.value.length < 8) { error.value = '密码至少 8 位。'; return }
  if (!isSetup.value && !password.value) { error.value = '请输入密码。'; return }
  if (isSetup.value && password.value !== confirm.value) { error.value = '两次输入的密码不一致。'; return }
  busy.value = true
  // “30天内免登录”：勾选值随登录请求发给后端（rememberMe），后端据此建
  // 30 天或 1 天会话；不勾选时后端默认 1 天（审计 #5：以前前端不传，
  // 后端缺省恒为 30 天，复选框是摆设）。偏好仍记 localStorage 供下次回填。
  try { localStorage.setItem('luck-mail-remember', remember.value ? '1' : '0') } catch { /* 忽略 */ }
  const ok = isSetup.value
    ? await auth.setup(username.value.trim(), password.value, confirm.value)
    : await auth.login(username.value.trim(), password.value, remember.value)
  busy.value = false
  if (ok) router.replace('/')
  else error.value = auth.lastError || '登录失败，请重试。'
}
</script>
