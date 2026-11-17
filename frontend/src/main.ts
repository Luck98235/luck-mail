import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import router from './router'
import { useThemeStore } from './stores/theme'
import './style.css'

const app = createApp(App)
app.use(createPinia())
app.use(router)

// 主题早恢复（index.html 里已按 localStorage 设过一次，这里再确认并同步 store）
useThemeStore().init()

app.mount('#app')
