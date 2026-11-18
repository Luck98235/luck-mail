import { defineStore } from 'pinia'
import { nextTick, ref } from 'vue'

export interface ThemeDef { key: string; name: string; color: string }

export const THEMES: ThemeDef[] = [
  { key: 'blue', name: '蓝色', color: '#3b82f6' },
  { key: 'green', name: '绿色', color: '#22c55e' },
  { key: 'mono', name: '黑白', color: '#111827' },
  { key: 'purple', name: '紫色', color: '#a855f7' },
  { key: 'orange', name: '橙色', color: '#f97316' },
  { key: 'teal', name: '青色', color: '#14b8a6' }
]
const THEME_KEY = 'luck-mail-theme'

export const useThemeStore = defineStore('theme', () => {
  const current = ref<string>('blue')

  function apply(name: string): void {
    if (!THEMES.some((t) => t.key === name)) name = 'blue'
    current.value = name
    document.body.setAttribute('data-theme', name)
    try { localStorage.setItem(THEME_KEY, name) } catch { /* 忽略 */ }
  }

  function init(): void {
    let saved: string | null = null
    try { saved = localStorage.getItem(THEME_KEY) } catch { /* 忽略 */ }
    apply(saved || document.body.getAttribute('data-theme') || 'blue')
  }

  // ---- 配色面板（单例，由 MailView 渲染；各处调色板按钮调 openPanel） ----
  const panelOpen = ref<boolean>(false)
  const panelPos = ref<{ left: number; top: number }>({ left: 0, top: 0 })

  async function openPanel(anchor: HTMLElement | null): Promise<void> {
    if (!anchor) return
    // 先显示，等 Vue 把面板挂进 DOM 后再量尺寸定位
    panelOpen.value = true
    await nextTick()
    const panel = document.getElementById('theme-panel')
    const pw = panel ? panel.offsetWidth : 208
    const ph = panel ? panel.offsetHeight : 200
    const r = anchor.getBoundingClientRect()
    let left = r.right + 8
    let top = r.bottom - ph
    if (left + pw > window.innerWidth - 8) left = r.left - pw - 8
    if (left < 8) left = Math.max(8, (window.innerWidth - pw) / 2)
    if (top < 8) top = 8
    if (top + ph > window.innerHeight - 8) top = Math.max(8, window.innerHeight - ph - 8)
    panelPos.value = { left, top }
  }

  function closePanel(): void { panelOpen.value = false }

  function togglePanel(anchor: HTMLElement | null): void {
    if (panelOpen.value) closePanel()
    else openPanel(anchor)
  }

  return { current, apply, init, panelOpen, panelPos, openPanel, closePanel, togglePanel }
})
