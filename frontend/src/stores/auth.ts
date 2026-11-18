import { defineStore } from 'pinia'
import { ref } from 'vue'
import { api, ApiError } from '../api'

export const useAuthStore = defineStore('auth', () => {
  const setupRequired = ref<boolean>(false)
  const loggedIn = ref<boolean>(false)
  const username = ref<string>('')
  const checked = ref<boolean>(false) // 是否已查过 /api/auth/status
  const lastError = ref<string>('')

  async function checkStatus(): Promise<void> {
    try {
      const data = await api.authStatus()
      setupRequired.value = !!data.setupRequired
      loggedIn.value = !!data.loggedIn
      username.value = data.username || ''
    } catch {
      // 后端不可达或 401：视为未登录（路由守卫会跳 /login）
      setupRequired.value = false
      loggedIn.value = false
    } finally {
      checked.value = true
    }
  }

  function friendlyError(e: unknown): string {
    if (e instanceof ApiError) {
      if (e.status === 429) {
        const secs = (e.body as { retryAfter?: number } | null)?.retryAfter
        return `账号已锁定${secs ? `，${Math.ceil(secs / 60)} 分钟后再试` : '，请稍后再试'}。`
      }
      return e.message || '操作失败，请重试。'
    }
    return '网络异常，请检查连接后重试。'
  }

  async function login(name: string, password: string, rememberMe = false): Promise<boolean> {
    lastError.value = ''
    try {
      const data = await api.login(name, password, rememberMe)
      loggedIn.value = true
      username.value = data.username || name
      return true
    } catch (e) {
      lastError.value = friendlyError(e)
      return false
    }
  }

  async function setup(name: string, password: string, confirm: string): Promise<boolean> {
    lastError.value = ''
    try {
      await api.setup(name, password, confirm)
      loggedIn.value = true
      username.value = name
      setupRequired.value = false
      return true
    } catch (e) {
      lastError.value = friendlyError(e)
      return false
    }
  }

  async function logout(): Promise<void> {
    try { await api.logout() } catch { /* 忽略，后端会话失效也算退出 */ }
    loggedIn.value = false
    username.value = ''
  }

  return { setupRequired, loggedIn, username, checked, lastError, checkStatus, login, setup, logout, friendlyError }
})
