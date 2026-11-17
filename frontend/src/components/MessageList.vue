<template>
  <section class="bg-white border-r border-blue-100 flex flex-col flex-shrink-0" :class="variant === 'qq' ? 'w-full border-r-0' : 'w-[300px]'">
    <!-- 列表头部 -->
    <div v-if="variant === 'desktop'" class="h-16 border-b border-blue-50 flex items-center justify-between px-4 bg-white">
      <div class="font-bold text-slate-700 text-base truncate">{{ mail.view.label }}</div>
      <div class="flex items-center gap-3 text-slate-400">
        <span v-if="mail.isDeletingHere" class="flex items-center gap-1 text-xs text-red-500 font-normal shrink-0"><i class="fa-solid fa-circle-notch fa-spin"></i>{{ mail.deleteRemaining > 0 ? `删除中（${mail.deleteRemaining}）` : '删除中…' }}</span>
        <i class="fa-solid fa-rotate-right cursor-pointer hover:text-blue-500 transition-colors" title="刷新" @click="mail.refreshAll()"></i>
      </div>
    </div>

    <!-- 搜索框 -->
    <div class="p-2 border-b border-blue-50 bg-slate-50/50">
      <div class="relative">
        <i class="fa-solid fa-magnifying-glass absolute left-3 top-2.5 text-slate-400 text-xs"></i>
        <input
          v-model="q" type="search" name="mail-search" autocomplete="off" placeholder="搜索邮件..." aria-label="搜索邮件"
          :readonly="!searchFocused" @focus="searchFocused = true" @blur="searchFocused = false"
          class="w-full bg-white border border-slate-200 rounded-md pl-8 pr-3 py-1.5 text-xs focus:ring-1 focus:ring-blue-400 focus:border-blue-400 transition-all outline-none"
        >
      </div>
    </div>

    <!-- 批量操作栏：全选 + 已选数量 + 删除/取消 -->
    <!-- 删除中时按钮常驻（刷新后勾选丢失、checkedCount=0 也显示），并带剩余待删数倒数；
         只在发起删除的视图显示，其他视图不受影响 -->
    <div class="flex items-center gap-2 px-3 py-1.5 border-b border-blue-50 bg-white text-xs text-slate-600">
      <label class="flex items-center gap-1.5 cursor-pointer select-none" :class="mail.isDeletingHere ? 'opacity-50 pointer-events-none' : ''">
        <input type="checkbox" :checked="mail.isAllChecked" :indeterminate="mail.isSomeChecked" class="accent-blue-500 w-3.5 h-3.5" :disabled="mail.isDeletingHere" @change="mail.toggleCheckAll()">
        全选
      </label>
      <span v-if="mail.checkedCount > 0" class="text-slate-400">已选 {{ mail.checkedCount }} 封</span>
      <div v-if="mail.checkedCount > 0 || mail.isDeletingHere" class="ml-auto flex items-center gap-2">
        <button class="px-2.5 py-1 rounded bg-red-500 hover:bg-red-600 text-white disabled:opacity-60" :disabled="mail.batchDeleting" @click="mail.deleteChecked()">{{ mail.isDeletingHere ? (mail.deleteRemaining > 0 ? `删除中（${mail.deleteRemaining}）` : '删除中…') : '删除' }}</button>
        <button v-if="mail.checkedCount > 0" class="text-slate-500 hover:text-slate-700" @click="mail.clearChecked()">取消</button>
      </div>
    </div>

    <!-- 邮件列表（虚拟滚动：只渲染可视窗口内的行；账号树不用虚拟滚动） -->
    <!-- 删除中：列表半透明示意、仍可滚动；查看（openMessage）与勾选（toggleCheck/toggleCheckAll）
         由 store 里的 isDeletingHere 守卫挡住，只锁发起删除的那个视图，别的视图不受影响 -->
    <div ref="scrollEl" class="flex-1 overflow-y-auto" :class="mail.isDeletingHere ? 'opacity-60' : ''" @scroll="onScroll">
      <div v-if="mail.loading && !mail.mailList.length" class="p-6 text-center text-xs text-slate-400">加载中…</div>
      <div v-else-if="!mail.mailList.length" class="p-6 text-center text-xs text-slate-400">这里没有邮件</div>
      <template v-else>
        <div class="relative" :style="{ height: totalHeight + 'px' }">
          <div
            v-for="(m, i) in visibleRows" :key="m.id"
            class="absolute left-0 right-0"
            :style="{ top: (visibleStart + i) * rowHeight + 'px', height: rowHeight + 'px' }"
          >
            <!-- 桌面行（参考图样式：左侧大头像 + 发件人/主题/摘要三行，红点未读，选中行浅粉底；悬停头像变复选框） -->
            <div
              v-if="variant === 'desktop'"
              class="group relative h-full overflow-hidden px-3 py-2 cursor-pointer border-b border-slate-100 hover:bg-slate-50 transition-colors"
              :class="m.id === mail.selectedId ? 'bg-[#fde8e8]' : ''"
              @click="mail.openMessage(m.id)"
            >
              <div class="flex items-center gap-3 h-full">
                <!-- 大头像；悬停时变复选框（已勾选时一直显示复选框） -->
                <div class="relative w-10 h-10 shrink-0">
                  <div class="w-10 h-10 rounded-full bg-blue-500 text-white flex items-center justify-center text-base font-bold" :class="mail.checkedIds.has(m.id) ? 'hidden' : 'group-hover:hidden'">{{ initialOf(m.fromName || m.from) }}</div>
                  <input type="checkbox" :checked="mail.checkedIds.has(m.id)" class="absolute inset-0 m-auto w-5 h-5 accent-blue-500 cursor-pointer" :class="mail.checkedIds.has(m.id) ? 'block' : 'hidden group-hover:block'" title="选择这封邮件" @click.stop @change="mail.toggleCheck(m.id)">
                </div>
                <div class="flex-1 min-w-0">
                  <div class="flex items-center justify-between gap-2">
                    <span class="flex items-center gap-1.5 min-w-0">
                      <span v-if="!m.isRead" class="w-2 h-2 rounded-full bg-red-500 shrink-0" title="未读"></span>
                      <span class="truncate text-sm" :class="m.id === mail.selectedId ? 'font-bold text-slate-900' : (m.isRead ? 'text-slate-700' : 'font-bold text-slate-900')">{{ m.fromName || m.from }}</span>
                    </span>
                    <span class="text-[11px] shrink-0 text-slate-400">{{ fmtListTime(m.date) }}</span>
                  </div>
                  <div class="flex items-center gap-1">
                    <span class="text-sm truncate flex-1" :class="m.isRead ? 'text-slate-700' : 'font-bold text-slate-900'">
                      {{ m.subject }}<span v-if="m.isLocalDraft" class="text-amber-500 text-xs">（本地草稿）</span>
                    </span>
                    <i v-if="m.hasAttachments" class="fa-solid fa-paperclip text-[10px] text-slate-400 shrink-0" title="附件"></i>
                  </div>
                  <div class="text-xs text-slate-500 truncate leading-snug">{{ m.snippet }}</div>
                </div>
              </div>
            </div>
            <!-- QQ 式行：大头像圆 + 发件人/主题/摘要 + 日期 + >（红点在发件人前） -->
            <div v-else class="qq-row h-full overflow-hidden" :class="{ active: m.id === mail.selectedId }" @click="mail.openMessage(m.id)">
              <input type="checkbox" :checked="mail.checkedIds.has(m.id)" class="accent-blue-500 w-4 h-4 shrink-0 cursor-pointer mt-1" title="选择这封邮件" @click.stop @change="mail.toggleCheck(m.id)">
              <div class="w-11 h-11 rounded-full bg-blue-500 text-white flex items-center justify-center text-lg font-bold shrink-0">{{ initialOf(m.fromName || m.from) }}</div>
              <div class="flex-1 min-w-0">
                <div class="flex items-center justify-between gap-2">
                  <span class="flex items-center gap-1.5 min-w-0">
                    <span v-if="!m.isRead" class="w-2 h-2 rounded-full bg-red-500 shrink-0" title="未读"></span>
                    <span class="font-bold text-slate-800 truncate" :class="{ 'text-blue-700': !m.isRead }">{{ m.fromName || m.from }}</span>
                  </span>
                  <span class="text-xs text-slate-400 shrink-0 flex items-center gap-1">{{ fmtListTime(m.date) }} <i class="fa-solid fa-chevron-right text-[10px] text-slate-300"></i></span>
                </div>
                <div class="text-[15px] truncate" :class="m.isRead ? 'text-slate-700' : 'font-bold text-slate-900'">{{ m.subject }}</div>
                <div class="text-[13px] text-slate-400 truncate leading-snug">{{ m.snippet }}</div>
              </div>
            </div>
          </div>
        </div>
        <!-- 分页：每页 50 条，点上一页/下一页再向后端拉当页 -->
        <div v-if="mail.total > 0" class="px-2 py-2.5 flex items-center justify-between gap-1 text-xs text-slate-500 whitespace-nowrap">
          <button class="shrink-0 px-2 py-1 rounded-md border border-slate-200 bg-white hover:bg-blue-50 hover:text-blue-600 disabled:opacity-40 disabled:hover:bg-white disabled:hover:text-slate-500" :disabled="mail.page <= 1 || mail.loading" @click="mail.prevPage()">‹ 上一页</button>
          <span class="shrink-0 px-1">{{ mail.page }}/{{ mail.totalPages }} 页 · {{ mail.total }} 封</span>
          <button class="shrink-0 px-2 py-1 rounded-md border border-slate-200 bg-white hover:bg-blue-50 hover:text-blue-600 disabled:opacity-40 disabled:hover:bg-white disabled:hover:text-slate-500" :disabled="mail.page >= mail.totalPages || mail.loading" @click="mail.nextPage()">下一页 ›</button>
        </div>
      </template>
    </div>
  </section>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted } from 'vue'
import { useMailStore } from '../stores/mail'
import { fmtListTime, initialOf } from '../utils'

const props = withDefaults(defineProps<{ variant?: 'desktop' | 'qq' }>(), { variant: 'desktop' })
const mail = useMailStore()
const q = ref<string>(mail.searchQuery)
// 搜索框平时只读、聚焦后才可编辑：浏览器不会往只读框里自动填用户名
const searchFocused = ref<boolean>(false)

let timer: ReturnType<typeof setTimeout> | null = null
watch(q, (v) => {
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => mail.setSearch(v), 300) // 输入防抖 300ms，走 q（FTS5）
})
watch(() => mail.searchQuery, (v) => { if (v !== q.value) q.value = v })

// ---- 虚拟滚动（只给邮件列表用；账号树最多 50 个，直接 v-for） ----
// 行高固定（桌面 76px / QQ 式 84px），只渲染可视窗口 + 上下各 5 行 overscan。
const rowHeight = computed<number>(() => (props.variant === 'qq' ? 84 : 76))
const OVERSCAN = 5
const scrollEl = ref<HTMLElement | null>(null)
const scrollTop = ref<number>(0)
const viewportH = ref<number>(600)

const visibleStart = computed<number>(() => Math.max(0, Math.floor(scrollTop.value / rowHeight.value) - OVERSCAN))
const visibleEnd = computed<number>(() =>
  Math.min(mail.mailList.length, Math.ceil((scrollTop.value + viewportH.value) / rowHeight.value) + OVERSCAN)
)
const visibleRows = computed(() => mail.mailList.slice(visibleStart.value, visibleEnd.value))
const totalHeight = computed<number>(() => mail.mailList.length * rowHeight.value)

function onScroll(): void {
  if (scrollEl.value) {
    scrollTop.value = scrollEl.value.scrollTop
    viewportH.value = scrollEl.value.clientHeight
  }
}

onMounted(() => {
  if (scrollEl.value) viewportH.value = scrollEl.value.clientHeight
})

// 切视图时回到顶部
watch(() => mail.view, () => {
  if (scrollEl.value) scrollEl.value.scrollTop = 0
  scrollTop.value = 0
})
</script>
