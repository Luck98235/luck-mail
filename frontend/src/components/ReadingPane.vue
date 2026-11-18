<template>
  <main class="flex-1 min-h-0 bg-white flex flex-col min-w-0" :class="$attrs.class">
    <!-- 手机端返回栏（MobileShell 里用 showBack 时显示） -->
    <div v-if="showBack" class="flex items-center gap-2 h-12 px-3 border-b border-blue-100 bg-white shrink-0">
      <button class="w-8 h-8 rounded-full flex items-center justify-center text-blue-500 bg-blue-50" aria-label="返回邮件列表" @click="$emit('back')">
        <i class="fa-solid fa-chevron-left"></i>
      </button>
      <span class="font-bold text-slate-700 text-[15px] truncate">邮件详情</span>
    </div>

    <!-- 顶部操作栏（与旧版一致：回复/转发/删除/标垃圾邮件；已删回复全部/打印/三个点） -->
    <div class="h-16 border-b border-blue-50 flex items-center px-6 bg-white flex-shrink-0">
      <div class="flex items-center gap-5 text-slate-500">
        <button :disabled="!mail.selectedMessage" class="hover:text-blue-500 hover:bg-blue-50 p-2 rounded transition-colors flex items-center gap-1.5 text-sm disabled:opacity-40" title="回复" @click="act('reply')">
          <i class="fa-solid fa-reply"></i>
        </button>
        <button :disabled="!mail.selectedMessage" class="hover:text-blue-500 hover:bg-blue-50 p-2 rounded transition-colors flex items-center gap-1.5 text-sm disabled:opacity-40" title="转发" @click="act('forward')">
          <i class="fa-solid fa-share"></i>
        </button>
        <div class="w-px h-4 bg-blue-100 mx-1"></div>
        <button :disabled="!mail.selectedMessage || mail.isDeletingHere" class="hover:text-red-500 hover:bg-red-50 p-2 rounded transition-colors flex items-center gap-1.5 text-sm disabled:opacity-40" :title="mail.isTrashView ? '彻底删除' : '删除'" @click="act('delete')">
          <i class="fa-regular fa-trash-can"></i>
        </button>
        <button :disabled="!mail.selectedMessage || mail.isDeletingHere" class="hover:text-amber-500 hover:bg-amber-50 p-2 rounded transition-colors flex items-center gap-1.5 text-sm disabled:opacity-40" title="标记为垃圾邮件" @click="act('spam')">
          <i class="fa-solid fa-ban"></i>
        </button>
        <button :disabled="!mail.selectedMessage" class="hover:text-blue-500 hover:bg-blue-50 p-2 rounded transition-colors flex items-center gap-1.5 text-sm disabled:opacity-40" :title="mail.selectedMessage?.isRead ? '标为未读' : '标为已读'" @click="act('toggle-read')">
          <i :class="mail.selectedMessage?.isRead ? 'fa-regular fa-envelope' : 'fa-regular fa-envelope-open'"></i>
        </button>
      </div>
    </div>

    <!-- 正文：不限宽，100% 铺满阅读窗（用户要求不固定死宽度） -->
    <div class="flex-1 min-h-0 overflow-y-auto p-8 w-full" :class="{ '!p-4': showBack }">
      <div v-if="mail.readingLoading" class="flex items-center justify-center h-full text-slate-400 text-sm">加载中…</div>
      <div v-else-if="!mail.selectedMessage" class="flex items-center justify-center h-full text-slate-400 text-sm">在此查看列表中选中的邮件。</div>
      <div v-else>
        <div class="mb-8">
          <h1 class="text-2xl font-bold text-slate-800 mb-6 break-words">{{ mail.selectedMessage.subject || '（无主题）' }}</h1>
          <div class="flex items-start justify-between gap-4">
            <div class="flex items-center gap-3 min-w-0">
              <div class="w-10 h-10 rounded-full bg-blue-100 text-blue-600 flex items-center justify-center text-lg font-bold shrink-0">{{ initialOf(mail.selectedMessage.fromName || mail.selectedMessage.from) }}</div>
              <div class="min-w-0">
                <!-- 发件人：悬停出现复制按钮，点一下复制发件人邮箱 -->
                <div class="group flex items-center gap-1.5 min-w-0">
                  <span class="font-bold text-slate-800 text-base truncate">{{ mail.selectedMessage.fromName || mail.selectedMessage.from }}</span>
                  <span v-if="mail.selectedMessage.fromName && mail.selectedMessage.fromName !== mail.selectedMessage.from" class="text-xs text-slate-500 truncate">&lt;{{ mail.selectedMessage.from }}&gt;</span>
                  <button class="opacity-0 group-hover:opacity-100 transition-opacity text-slate-400 hover:text-blue-500 p-1 rounded shrink-0" title="复制发件人邮箱" @click="copySender">
                    <i :class="senderCopied ? 'fa-solid fa-check text-green-500' : 'fa-regular fa-copy'"></i>
                  </button>
                </div>
                <div class="text-xs text-slate-500 mt-0.5">发至 <span class="text-blue-500">{{ (mail.selectedMessage.to || []).join(', ') }}</span></div>
                <div v-if="(mail.selectedMessage.cc || []).length" class="text-xs text-slate-500 mt-0.5">抄送 <span class="text-blue-500">{{ mail.selectedMessage.cc.join(', ') }}</span></div>
              </div>
            </div>
            <div class="text-xs text-slate-400 mt-1 flex flex-col items-end shrink-0">
              <span>{{ fmtFullTime(mail.selectedMessage.date) }}</span>
              <!-- 正文翻译：放在日期下面，点一下英文翻中文，再点回原文 -->
              <button :disabled="!mail.selectedMessage || translating" class="mt-1.5 flex items-center gap-1 text-blue-500 hover:text-blue-600 disabled:opacity-40" :title="showingTranslation ? '显示原文' : '翻译为中文'" @click="toggleTranslate">
                <i :class="translating ? 'fa-solid fa-circle-notch fa-spin' : 'fa-solid fa-language'"></i>
                <span>{{ translating ? '翻译中…' : showingTranslation ? '原文' : '翻译' }}</span>
              </button>
            </div>
          </div>
        </div>
        <div v-if="(mail.selectedMessage.attachments || []).length" class="mb-6 flex flex-wrap gap-2">
          <a
            v-for="att in mail.selectedMessage.attachments" :key="att.id"
            :href="`/api/messages/${mail.selectedMessage.id}/attachments/${att.id}`"
            :download="att.filename" target="_blank" rel="noopener noreferrer"
            title="点击下载：从邮箱服务器实时取，不经过本项目服务器缓存"
            class="inline-flex items-center gap-1.5 text-xs border rounded-md px-2.5 py-1.5 bg-blue-50 text-blue-600 border-blue-100 hover:bg-blue-100"
          >
            <i class="fa-solid fa-paperclip"></i>{{ att.filename }}<span v-if="att.size != null">（{{ formatSize(att.size) }}）</span>
          </a>
        </div>
        <!-- 正文用沙盒 iframe（srcdoc）渲染：洗净后的 HTML 不直接插进主应用，
             邮件内 CSS/脚本伤不到主应用的浅蓝色 UI。sandbox 不给 allow-scripts，
             只给 allow-same-origin（用于量高度自适应）与 allow-popups（链接新窗口打开）。 -->
        <iframe
          ref="frameRef"
          :srcdoc="srcdocHtml"
          sandbox="allow-same-origin allow-popups"
          class="w-full border-0 bg-white block"
          style="min-height: 200px; touch-action: pan-y"
          title="邮件正文"
          @load="setupFrame"
        ></iframe>
      </div>
    </div>
  </main>
</template>

<script setup lang="ts">
import { ref, computed, watch, nextTick, onUnmounted } from 'vue'
import { useMailStore } from '../stores/mail'
import { useThemeStore } from '../stores/theme'
import { api } from '../api'
import { attachSwipeBack } from '../utils/swipeBack'
import { fmtFullTime, initialOf, formatSize, copyText } from '../utils'
import type { MessageDetail } from '../types'

defineProps<{ showBack?: boolean }>()
const emit = defineEmits<{
  (e: 'back'): void
  (e: 'reply', m: MessageDetail): void
  (e: 'forward', m: MessageDetail): void
}>()
const mail = useMailStore()
const theme = useThemeStore()

const frameRef = ref<HTMLIFrameElement | null>(null)

// ---- 正文翻译：英文 → 中文（发件人日期下面的“翻译”按钮；译文存着，来回切换不用重调接口）----
const translating = ref(false)
const translatedText = ref<string | null>(null)
const showingTranslation = ref(false)

async function toggleTranslate(): Promise<void> {
  const m = mail.selectedMessage
  if (!m) return
  if (showingTranslation.value) { showingTranslation.value = false; return }
  if (translatedText.value !== null) { showingTranslation.value = true; return }
  translating.value = true
  try {
    const r = await api.translateMessage(m.id)
    // 竞态：等接口回来时用户可能已切到别的邮件，若不是同一封就丢弃这次译文
    if (mail.selectedMessage?.id !== m.id) return
    if (r.alreadyChinese) { mail.showToast('正文已经是中文，无需翻译'); return }
    translatedText.value = r.translated
    showingTranslation.value = true
  } catch {
    mail.showToast('翻译失败，请稍后重试')
  } finally {
    translating.value = false
  }
}

// ---- 发件人复制：悬停发件人行出现复制按钮，点一下复制发件人邮箱 ----
const senderCopied = ref(false)
let senderCopyTimer: ReturnType<typeof setTimeout> | null = null
async function copySender(): Promise<void> {
  const m = mail.selectedMessage
  if (!m?.from) return
  const ok = await copyText(m.from)
  if (!ok) { mail.showToast('复制失败，请重试'); return }
  senderCopied.value = true
  if (senderCopyTimer) clearTimeout(senderCopyTimer)
  senderCopyTimer = setTimeout(() => { senderCopied.value = false }, 1500)
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string))
}

// 链接统一新窗口打开（srcdoc 里 <base target="_blank"> 已兜底；这里再补没写 target 的 <a>）
function forceBlankTarget(html: string): string {
  return html.replace(/<a\s([^>]*?)>/gi, (match: string, attrs: string) => {
    if (/target\s*=/.test(attrs)) return match
    return `<a ${attrs} target="_blank" rel="noopener noreferrer">`
  })
}

const srcdocHtml = computed<string>(() => {
  const m = mail.selectedMessage
  if (!m) return ''
  // iframe 是独立文档，主站的滚动条 CSS 进不去，所以把当前主题的滚动条色也写进 srcdoc，
  // 让正文 iframe 的滚动条与外层容器的主题色一致。读 theme.current 建立响应式依赖，换主题时重算。
  const t = theme.current
  void t
  const cs = getComputedStyle(document.body)
  const c300 = (cs.getPropertyValue('--c-300') || '#93c5fd').trim()
  const c400 = (cs.getPropertyValue('--c-400') || '#60a5fa').trim()
  // 正在看译文时：译文纯文本按段落显示（转义后换行成 <p>），不走原文 HTML。
  const body = showingTranslation.value && translatedText.value !== null
    ? translatedText.value.split(/\n\s*\n/).map((p) => `<p style="margin:0 0 1em">${escapeHtml(p.trim()).replace(/\n/g, '<br>')}</p>`).join('')
    : m.bodyHtml
      ? forceBlankTarget(m.bodyHtml)
      : `<div style="white-space:pre-wrap">${escapeHtml(m.bodyText || '')}</div>`
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><base target="_blank">`
    + `<style>body{margin:0;padding:2px;font:14px/1.7 ui-sans-serif,system-ui,sans-serif;color:#334155;background:#fff;word-wrap:break-word}img{max-width:100%;height:auto}a{color:#2563eb}`
    + `::-webkit-scrollbar{width:6px;height:6px}::-webkit-scrollbar-track{background:transparent}::-webkit-scrollbar-thumb{background:${c300};border-radius:10px}::-webkit-scrollbar-thumb:hover{background:${c400}}`
    + `html{scrollbar-color:${c300} transparent;scrollbar-width:thin}</style>`
    + `</head><body>${body}</body></html>`
})

let bodyObserver: ResizeObserver | null = null
let remeasureTimers: ReturnType<typeof setTimeout>[] = []
let detachFrameSwipe: (() => void) | null = null

// 正文 iframe 高度：多取几个量取最大，避免个别浏览器在手机上量不准导致底部被截。
function measureDocHeight(doc: Document): number {
  const de = doc.documentElement
  const body = doc.body
  if (!body) return 0
  return Math.max(
    de.scrollHeight, body.scrollHeight,
    de.offsetHeight, body.offsetHeight,
    de.clientHeight, body.clientHeight,
    body.getBoundingClientRect().height
  )
}

function resizeFrame(): void {
  const f = frameRef.value
  const doc = f?.contentDocument
  if (!f || !doc) return
  const h = measureDocHeight(doc)
  if (h > 0) f.style.height = h + 'px'
}

// iframe 高度自适应：只靠 @load 量一次不够（图片加载、字体加载、内容变化后高度会变），
// 用 ResizeObserver 盯着正文 html + body，高度一变就重算；图片未加载完的也补 load 监听；
// 再加两次延迟复量，兜底字体/图片晚到的重排。这样 iframe 本身基本不需要自己的滚动条，
// 只有外层容器一条滚动条，手机上才能一路拖到底。
function setupFrame(): void {
  resizeFrame()
  const doc = frameRef.value?.contentDocument
  if (!doc || !doc.body) return
  bodyObserver?.disconnect()
  bodyObserver = new ResizeObserver(() => resizeFrame())
  bodyObserver.observe(doc.body)
  bodyObserver.observe(doc.documentElement)
  doc.querySelectorAll('img').forEach((img) => {
    if (!img.complete) img.addEventListener('load', resizeFrame, { once: true })
  })
  // 手机/平板：邮件正文 iframe 里右滑返回上一屏（阅读 → 列表）。
  // iframe 是独立文档，主应用的触摸监听收不到里面的手势，必须直接挂在 iframe 的 document 上。
  // sandbox 有 allow-same-origin，父页面能访问 contentDocument；不改 sandbox、不往正文里注脚本。
  // 只在手机/平板挂（桌面端 ReadingPane 也用同一组件，但桌面没有 mview 导航）。
  detachFrameSwipe?.()
  detachFrameSwipe = null
  if (window.innerWidth < 1024) {
    detachFrameSwipe = attachSwipeBack(doc, () => mail.goMobileBack())
  }
  // 延迟复量：字体、图片晚到会引起重排，load 时量的高度可能偏小。
  remeasureTimers.forEach((t) => clearTimeout(t))
  remeasureTimers = [300, 1200].map((ms) => setTimeout(resizeFrame, ms))
}

onUnmounted(() => {
  bodyObserver?.disconnect()
  remeasureTimers.forEach((t) => clearTimeout(t))
  detachFrameSwipe?.()
  detachFrameSwipe = null
})

watch(() => mail.selectedMessage?.id, () => {
  // 换一封邮件时译文与复制态都清掉，回到原文。
  translatedText.value = null
  showingTranslation.value = false
  senderCopied.value = false
  void nextTick(setupFrame)
})

// 单封删除先弹确认（批量删除已在 store 里走 requestConfirm；
// 这里与 store 共用同一个 requestConfirm，走覆盖保护：上一个确认框
// 没点就来了新的，旧的按“取消” resolve，不会卡住调用方）。
async function confirmDelete(): Promise<boolean> {
  const msg = mail.isTrashView
    ? '确定彻底删除这封邮件吗？彻底删除后不可恢复。'
    : '确定删除这封邮件吗？将移到已删除。'
  return mail.requestConfirm(msg, true)
}

function act(kind: 'reply' | 'forward' | 'delete' | 'spam' | 'toggle-read'): void {
  const m = mail.selectedMessage
  if (!m) return
  if (kind === 'delete') {
    void confirmDelete().then((ok) => { if (ok) void mail.deleteMessage(m.id) })
  }
  else if (kind === 'spam') void mail.moveToSpam(m.id)
  else if (kind === 'toggle-read') void mail.setRead(m.id, !m.isRead)
  else if (kind === 'reply') emit('reply', m)
  else if (kind === 'forward') emit('forward', m)
}
</script>
