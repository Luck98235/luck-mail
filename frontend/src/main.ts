import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import router from './router'
import { useThemeStore } from './stores/theme'
import { useMailStore } from './stores/mail'
import './style.css'

const app = createApp(App)
app.use(createPinia())
app.use(router)

// 全局异常兜底（审计 #10 安全 L9）：以前没有任何统一落点，未预见的
// 渲染/回调异常没有用户提示。只记日志 + toast，不吞异常本身。
app.config.errorHandler = (err) => {
  console.error('[luck-mail] vue error:', err)
  try { useMailStore().showToast('页面出现异常，请刷新重试') } catch { /* store 未就绪 */ }
}
if (typeof window !== 'undefined') {
  window.addEventListener('unhandledrejection', (e) => {
    console.error('[luck-mail] unhandled rejection:', e.reason)
    try { useMailStore().showToast('页面出现异常，请刷新重试') } catch { /* store 未就绪 */ }
  })
}

// 主题早恢复（index.html 里已按 localStorage 设过一次，这里再确认并同步 store）
useThemeStore().init()

app.mount('#app')
