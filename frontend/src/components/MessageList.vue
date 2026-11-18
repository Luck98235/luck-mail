<template>
  <section class="bg-white border-r border-blue-100 flex flex-col min-h-0 lg:shrink-0" :class="variant === 'qq' ? 'w-full border-r-0' : 'w-[300px] min-[1600px]:w-[340px] min-[2400px]:w-[380px]'">
    <!-- 列表头部 -->
    <div v-if="variant === 'desktop'" class="h-16 border-b border-blue-50 flex items-center justify-between px-4 bg-white">
      <div class="font-bold text-slate-700 text-base truncate">{{ mail.view.label }}</div>
      <div class="flex items-center gap-3 text-slate-400">
        <span v-if="mail.isDeletingHere" class="flex items-center gap-1 text-xs text-red-500 font-normal shrink-0"><i class="fa-solid fa-circle-notch fa-spin"></i>{{ mail.deleteRemaining > 0 ? `删除中（${mail.deleteRemaining}）` : '删除中…' }}</span>
        <i class="fa-solid fa-rotate-right cursor-pointer hover:text-blue-500 transition-colors" :class="{ 'opacity-40 pointer-events-none': mail.refreshingAll }" title="刷新" @click="mail.refreshAll()"></i>
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

    <!-- 加载指示：列表非空时也显示（审计 #4 主修加固）——切视图时旧列表已清，
         空列表走下面的“加载中…”；搜索/翻页不适合清列表，靠这条细提示表明正在加载 -->
    <div v-if="mail.loading && mail.mailList.length" class="px-3 py-1.5 text-center text-xs text-blue-500 bg-blue-50/60 border-b border-blue-100">加载中…</div>

    <!-- 邮件列表（虚拟滚动：只渲染可视窗口内的行；账号树不用虚拟滚动） -->
    <!-- 删除中：列表半透明示意、仍可滚动；查看（openMessage）与勾选（toggleCheck/toggleCheckAll）
         由 store 里的 isDeletingHere 守卫挡住，只锁发起删除的那个视图，别的视图不受影响 -->
    <div ref="scrollEl" class="flex-1 min-h-0 overflow-y-auto" :class="mail.isDeletingHere ? 'opacity-60' : ''" @scroll="onScroll">
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
                      {{ m.subject }}<span v-if="m.isDraft" class="text-amber-500 text-xs">（草稿）</span>
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
import { ref, computed, watch, onMounted, onUnmounted, nextTick } from 'vue'
import { useMailStore } from '../stores/mail'
import { fmtListTime, initialOf } from '../utils'

const props = withDefaults(defineProps<{ variant?: 'desktop' | 'qq' }>(), { variant: 'desktop' })
const mail = useMailStore()
const q = ref<string>(mail.searchQuery)
// 搜索框平时只读、聚焦后才可编辑：浏览器不会往只读框里自动填用户名
const searchFocused = ref<boolean>(false)

let timer: ReturnType<typeof setTimeout> | null = null
watch(q, (v) => {
  // 同步回写不触发搜索：桌面与移动两个 MessageList 实例同时挂载，
  // 一个实例输入后 setSearch 改了 mail.searchQuery，另一实例的回写 watcher
  // 把 q 设成同一值；若这里不跳过，防抖回调会再发一次搜索请求。
  // 切视图时 store 会清 searchQuery，回写值与当前 q 一致时同样跳过，不重复加载。
  if (v === mail.searchQuery) return
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
// 兜底：量不到可视高度（viewportH<=0）时全量渲染，不再只显示 OVERSCAN=5 行。
// 列表最多 50 条/页，全量渲染也没有性能问题。
const visibleEnd = computed<number>(() => {
  if (viewportH.value <= 0) return mail.mailList.length
  return Math.min(mail.mailList.length, Math.ceil((scrollTop.value + viewportH.value) / rowHeight.value) + OVERSCAN)
})
const visibleRows = computed(() => mail.mailList.slice(visibleStart.value, visibleEnd.value))
const totalHeight = computed<number>(() => mail.mailList.length * rowHeight.value)

function onScroll(): void {
  if (scrollEl.value) {
    scrollTop.value = scrollEl.value.scrollTop
    measureViewport()
  }
}

// 量可视高度：clientHeight 为 0 时不覆盖（手机端列表挂载时父级 display:none，
// 高度为 0；若直接写入 0，虚拟滚动只会渲染 OVERSCAN=5 行，看起来永远只有 5 封）。
function measureViewport(): void {
  if (scrollEl.value && scrollEl.value.clientHeight > 0) {
    viewportH.value = scrollEl.value.clientHeight
  }
}

// ResizeObserver：尺寸变化时重测（手机端从账号总览切到列表时 display:none→flex，
// 高度从 0 变为真实值，靠它把 viewportH 纠回来；桌面端窗口缩放也受益）。
let ro: ResizeObserver | null = null

onMounted(() => {
  measureViewport()
  if (scrollEl.value && typeof ResizeObserver !== 'undefined') {
    ro = new ResizeObserver(() => measureViewport())
    ro.observe(scrollEl.value)
  }
})

onUnmounted(() => {
  if (ro) { ro.disconnect(); ro = null }
  // 搜索防抖定时器卸载时清理：避免组件已卸载、定时器还触发 setSearch（审计 #5 LOW）。
  if (timer) { clearTimeout(timer); timer = null }
})

// 切视图 / 翻页 / 搜索后回到顶部（列表内容换了，停在半截会看错页）
function scrollToTop(): void {
  if (scrollEl.value) scrollEl.value.scrollTop = 0
  scrollTop.value = 0
}
watch(() => mail.view, scrollToTop)
watch(() => mail.page, scrollToTop)
watch(() => mail.searchQuery, scrollToTop)

// 列表数据变化后重测可视高度（手机端切进未读视图时数据刚回来、布局刚展开，
// 靠这次重测量到真实高度；nextTick 等 DOM 落定后再量）。
watch(() => mail.mailList.length, () => {
  void nextTick(() => measureViewport())
})

// 新邮件插到顶部时的滚动补偿（审计 #5 LOW）：用户已往下滚时把滚动位置
// 下移一行高，保持当前可见内容不动；在顶部（scrollTop=0）时不补偿，
// 新邮件自然出现在视野顶部。nextTick 等虚拟滚动重算后再调位置。
watch(() => mail.topInsertCount, () => {
  void nextTick(() => {
    if (scrollEl.value && scrollEl.value.scrollTop > 0) {
      scrollEl.value.scrollTop += rowHeight.value
    }
  })
})
</script>
