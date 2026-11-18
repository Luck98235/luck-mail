<template>
  <!-- 手机/平板：QQ 邮箱 APP 式布局（布局学 QQ，配色用本项目浅色主题，不用 QQ 深色）
       三级：home（账号总览：账号头 + 搜索 + 常用文件夹 + 我的邮箱）
             → account（邮箱内：顶部切换账号 + 收件箱/未读/管理页签 + 侧滑文件夹菜单 + 列表）
             → read（阅读窗）
       平板 768–1024px：左栏固定为账号总览，右栏为列表/阅读窗；手机 <768px：单栏逐级钻取。 -->
  <div ref="shellRef" class="mobile-shell" :data-mview="mail.mview">
    <!-- ===== 账号总览 ===== -->
    <div class="m-home flex-col bg-white overflow-y-auto">
      <!-- 账号头 -->
      <div class="flex items-center gap-3 px-5 pt-6 pb-4">
        <div class="w-12 h-12 rounded-full bg-blue-500 text-white flex items-center justify-center text-xl font-bold shrink-0">
          {{ initialOf(auth.username) }}
        </div>
        <div class="flex-1 min-w-0">
          <div class="flex items-center gap-2">
            <span class="font-bold text-slate-800 text-[17px] truncate">{{ auth.username || '我的邮箱' }}</span>
            <span class="text-[10px] bg-blue-50 text-blue-500 border border-blue-100 rounded px-1.5 py-0.5 shrink-0">主账号</span>
          </div>
          <div class="text-[13px] text-slate-400 truncate mt-0.5">{{ defaultAccountEmail || '还没有邮箱账号' }}</div>
        </div>
        <button class="w-9 h-9 rounded-full text-blue-500 hover:bg-blue-50 flex items-center justify-center shrink-0 disabled:opacity-40" :disabled="mail.refreshingAll" title="刷新全部邮箱" @click="mail.refreshAll()">
          <i class="fa-solid fa-arrow-rotate-left text-lg" :class="{ 'fa-spin': mail.refreshingAll }"></i>
        </button>
        <button class="w-9 h-9 rounded-full text-slate-400 hover:bg-slate-100 flex items-center justify-center shrink-0" title="退出登录" @click="$emit('logout')">
          <i class="fa-solid fa-power-off text-lg"></i>
        </button>
      </div>

      <!-- 搜索 -->
      <div class="px-5 pb-3">
        <div class="relative">
          <i class="fa-solid fa-magnifying-glass absolute left-3.5 top-3 text-slate-400 text-sm"></i>
          <input
            v-model="homeQ" type="search" placeholder="搜索" aria-label="搜索邮件"
            class="w-full bg-slate-100 border-0 rounded-full pl-10 pr-4 py-2.5 text-sm outline-none focus:ring-1 focus:ring-blue-400"
            @keyup.enter="searchFromHome"
          >
        </div>
      </div>

      <!-- 常用文件夹（聚合视图；按项目取舍，不含星标/红旗） -->
      <div class="px-2">
        <div class="px-3 pt-3 pb-1 text-[13px] text-slate-400">常用文件夹</div>
        <button
          v-for="agg in AGGREGATES" :key="agg.kind"
          class="w-full flex items-center gap-3.5 px-3 py-3 rounded-lg text-left hover:bg-blue-50/50"
          @click="mail.setAggregate(agg.kind)"
        >
          <span class="w-9 h-9 rounded-full flex items-center justify-center text-white shrink-0" :style="{ background: aggColor(agg.kind) }">
            <i :class="agg.icon"></i>
          </span>
          <span class="flex-1 text-[15px] text-slate-800">{{ agg.label }}</span>
          <span v-if="agg.kind === 'all-unread' && mail.totalUnread > 0" class="text-sm text-slate-400">{{ mail.totalUnread }}</span>
        </button>
      </div>

      <!-- 我的邮箱（平铺，无分组） -->
      <div class="px-2 pb-4">
        <div class="px-3 pt-4 pb-1 text-[13px] text-slate-400">我的邮箱</div>
        <button
          v-for="a in mail.accounts" :key="a.id"
          class="w-full flex items-center gap-3.5 px-3 py-3 rounded-lg text-left hover:bg-blue-50/50"
          @click="enterAccount(a.id)"
        >
          <span class="w-9 h-9 rounded-full text-white flex items-center justify-center text-xs font-bold shrink-0" :style="{ background: domainColor(a.email) }">{{ domainShort(a.email) }}</span>
          <span class="flex-1 text-[15px] text-slate-800 truncate">{{ a.displayName || a.email }}</span>
          <span v-if="mail.unreadOfAccount(a.id) > 0" class="text-sm text-slate-400">{{ mail.unreadOfAccount(a.id) }}</span>
          <i class="fa-solid fa-chevron-right text-xs text-slate-300"></i>
        </button>
        <div v-if="!mail.accounts.length" class="px-3 py-3 text-sm text-slate-400">还没有邮箱，请在电脑端添加。</div>
      </div>
    </div>

    <!-- ===== 邮箱内：列表 / 阅读 ===== -->
    <div class="m-content flex-col bg-white">
      <!-- 列表 -->
      <div class="m-list flex-col">
        <!-- 顶部：返回 + 切换账号 + 写信 -->
        <div class="flex items-center gap-2 h-14 px-3 border-b border-slate-100 shrink-0 relative">
          <button class="w-9 h-9 flex items-center justify-center text-slate-500 md:hidden" aria-label="返回账号总览" @click="mail.goMobileBack()">
            <i class="fa-solid fa-chevron-left"></i>
          </button>
          <button class="flex-1 flex items-center justify-center gap-1.5 font-bold text-slate-800 truncate" @click="switcherOpen = !switcherOpen">
            <span class="truncate">{{ switcherLabel }}</span>
            <i class="fa-solid fa-chevron-down text-xs text-slate-400"></i>
          </button>
          <button class="w-9 h-9 flex items-center justify-center text-blue-500" title="写信" @click="$emit('compose')">
            <i class="fa-regular fa-pen-to-square text-xl"></i>
          </button>
          <!-- 账号切换下拉：点空白处关闭（遮罩层，盖在下拉框之下、其他内容之上） -->
          <div v-if="switcherOpen" class="fixed inset-0 z-30" @click="switcherOpen = false"></div>
          <div v-if="switcherOpen" class="absolute top-12 left-1/2 -translate-x-1/2 z-40 w-64 bg-white rounded-xl shadow-lg border border-slate-100 py-1 max-h-80 overflow-y-auto">
            <button class="w-full text-left px-4 py-2.5 text-sm hover:bg-blue-50" :class="{ 'text-blue-600 font-medium': !mail.mobileAccountId }" @click="pickAccount(null)">全部邮箱</button>
            <button
              v-for="a in mail.accounts" :key="a.id"
              class="w-full text-left px-4 py-2.5 text-sm hover:bg-blue-50 truncate"
              :class="{ 'text-blue-600 font-medium': mail.mobileAccountId === a.id }"
              @click="pickAccount(a.id)"
            >{{ a.displayName || a.email }}</button>
          </div>
        </div>

        <!-- 页签：当前文件夹（点开侧滑菜单）| 未读邮件 -->
        <div class="flex items-center h-11 border-b border-slate-100 shrink-0 text-[14px] text-slate-600">
          <button class="flex-1 flex items-center justify-center gap-1.5 h-full" :class="{ 'text-blue-600 font-medium': mail.view.kind === 'folder' }" @click="openDrawer">
            <i :class="folderTabIcon"></i>{{ folderTabLabel }}
            <i class="fa-solid fa-chevron-up text-[10px] text-slate-400"></i>
          </button>
          <div class="w-px h-4 bg-slate-200"></div>
          <button class="flex-1 flex items-center justify-center gap-1.5 h-full" :class="{ 'text-blue-600 font-medium': mail.view.kind === 'all-unread' }" @click="unreadTab">
            <i class="fa-regular fa-envelope"></i>未读邮件
          </button>
        </div>

        <MessageList variant="qq" class="flex-1" />
      </div>

      <!-- 阅读窗 -->
      <div class="m-reading flex-col">
        <ReadingPane show-back class="flex-1" @back="mail.goMobileBack()" @reply="(m) => $emit('reply', m)" @forward="(m) => $emit('forward', m)" />
      </div>
    </div>

    <!-- ===== 侧滑文件夹菜单 ===== -->
    <div v-if="mail.drawerOpen" class="m-drawer-mask" @click="mail.drawerOpen = false"></div>
    <div class="m-drawer" :class="{ open: mail.drawerOpen }">
      <div class="flex items-center justify-between px-5 pt-5 pb-3">
        <span class="font-bold text-slate-800 truncate">{{ mail.mobileAccount ? (mail.mobileAccount.displayName || mail.mobileAccount.email) : '全部邮箱' }}</span>
        <button class="text-slate-400 w-8 h-8" @click="mail.drawerOpen = false"><i class="fa-solid fa-xmark"></i></button>
      </div>
      <div class="flex-1 min-h-0 overflow-y-auto pb-4">
        <template v-if="mail.mobileAccount">
          <div
            v-for="f in mobileFolders" :key="f.id"
            class="drawer-item"
            :class="{ active: mail.activeFolder?.id === f.id }"
            @click="pickFolder(f)"
          >
            <i :class="[folderIcon(f.type), 'w-5 text-center']"></i>
            <span class="flex-1">{{ f.name }}</span>
            <span v-if="unreadOfMobileFolder(f.id) > 0" class="text-xs bg-red-500 text-white rounded-full min-w-5 h-5 px-1 flex items-center justify-center">{{ unreadOfMobileFolder(f.id) }}</span>
          </div>
          <div v-if="!mobileFolders.length" class="px-5 py-3 text-sm text-slate-400">文件夹同步中…</div>
        </template>
        <template v-else>
          <div
            v-for="agg in AGGREGATES" :key="agg.kind" class="drawer-item"
            :class="{ active: mail.view.kind === agg.kind }"
            @click="mail.setAggregate(agg.kind); mail.drawerOpen = false"
          >
            <i :class="[agg.icon, 'w-5 text-center']"></i>
            <span class="flex-1">{{ agg.label }}</span>
          </div>
        </template>
        <div class="border-t border-slate-100 mt-2 pt-2">
          <div v-if="mail.mobileAccount" class="drawer-item" @click="refreshCurrent">
            <i class="fa-solid fa-arrow-rotate-left w-5 text-center"></i><span class="flex-1">刷新该邮箱</span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch } from 'vue'
import { useAuthStore } from '../stores/auth'
import { useMailStore, AGGREGATES, folderIcon } from '../stores/mail'
import { initialOf, domainColor, domainShort } from '../utils'
import { attachSwipeBack } from '../utils/swipeBack'
import type { Folder } from '../types'
import MessageList from './MessageList.vue'
import ReadingPane from './ReadingPane.vue'

defineEmits(['compose', 'logout', 'reply', 'forward'])
const auth = useAuthStore()
const mail = useMailStore()

const homeQ = ref<string>('')
const switcherOpen = ref<boolean>(false)
const shellRef = ref<HTMLElement | null>(null)

// 回首页时清空首页搜索框：搜过的词留在框里，下次回首页会误以为还在搜（审计 #5 LOW）。
watch(() => mail.mview, (v) => { if (v === 'home') homeQ.value = '' })

// 手机/平板右滑返回上一屏（2026-11-18）：挂在 MobileShell 根元素上，
// 覆盖首页、列表、阅读窗顶栏等主文档区域；邮件正文在 iframe 里，另见 ReadingPane。
let detachSwipe: (() => void) | null = null
onMounted(() => {
  if (shellRef.value) detachSwipe = attachSwipeBack(shellRef.value, () => mail.goMobileBack())
})
onUnmounted(() => { detachSwipe?.(); detachSwipe = null })

const defaultAccountEmail = computed(() => {
  const d = mail.accounts.find((a) => a.id === mail.settings.defaultAccountId)
  return (d || mail.accounts[0])?.email || ''
})

// 当前移动端账号的文件夹（已做 null 收窄，模板里不再用可能为 null 的 id 索引）
const mobileFolders = computed<Folder[]>(() => {
  if (mail.mobileAccountId == null) return []
  return mail.foldersByAccount[mail.mobileAccountId] || []
})
function unreadOfMobileFolder(folderId: number): number {
  if (mail.mobileAccountId == null) return 0
  return mail.unreadOfFolder(mail.mobileAccountId, folderId)
}

const switcherLabel = computed(() => {
  if (mail.mobileAccount) return mail.mobileAccount.displayName || mail.mobileAccount.email
  return '全部邮箱'
})

const folderTabLabel = computed(() => {
  if (mail.view.kind === 'folder') return mail.activeFolder?.name || '收件箱'
  if (mail.view.kind === 'all-unread') return '未读邮件'
  return mail.view.label || '收件箱'
})
const folderTabIcon = computed(() => {
  if (mail.view.kind === 'folder') return folderIcon(mail.activeFolder?.type || 'inbox')
  return 'fa-solid fa-inbox'
})

function aggColor(kind: string): string {
  return { 'all-inbox': '#f59e0b', 'all-unread': '#3b82f6', 'all-drafts': '#64748b', 'all-sent': '#22c55e', 'all-trash': '#ef4444' }[kind] || '#3b82f6'
}

async function searchFromHome(): Promise<void> {
  if (!homeQ.value.trim()) return
  // 首页搜 = 全局搜：先切到“所有收件箱”，否则搜的是上次停留的视图
  //（可能只是某一个邮箱），用户在首页搜时期望的是全部邮箱。
  // 必须 await：setAggregate 末尾会 loadMessages，不等它完成就 setSearch，
  // 两次加载会竞态，后返回的那次会把搜索结果冲掉。
  await mail.setAggregate('all-inbox')
  mail.setSearch(homeQ.value.trim())
  mail.mview = 'account'
}

function pickAccount(id: number | null): void {
  switcherOpen.value = false
  if (id == null) {
    mail.setMobileAccount(null)
    void mail.setAggregate('all-inbox')
  } else if (mail.expanded.has(id)) {
    // 已展开：切到该邮箱收件箱，不折叠（与 enterAccount 同一路）
    void enterAccount(id)
  } else {
    void mail.selectAccount(id)
  }
}

// 点“我的邮箱”里的邮箱：未展开时展开 + 切单邮箱收件箱（走 enterMobileAccount）；
// 已展开时再点仍切到该邮箱的收件箱视图，不折叠（折叠只留给行首 >）。
// 否则第二次点同一邮箱会直接折叠、视图不动，看起来像“没反应”。
async function enterAccount(id: number): Promise<void> {
  if (!mail.expanded.has(id)) { mail.enterMobileAccount(id); return }
  await mail.loadFolders(id)
  const fid = mail.inboxFolderId(id)
  const inbox = (mail.foldersByAccount[id] || []).find((f) => f.id === fid) || null
  if (!inbox) { mail.showToast('文件夹同步中，请稍后再试'); return }
  await mail.setFolderView(id, inbox)
}

async function openDrawer(): Promise<void> {
  if (mail.mobileAccountId) await mail.loadFolders(mail.mobileAccountId)
  mail.drawerOpen = true
}

function pickFolder(f: Folder): void {
  void mail.setFolderView(mail.mobileAccountId as number, f)
  mail.drawerOpen = false
}

function unreadTab(): void {
  if (mail.mobileAccountId) void mail.setAccountUnread(mail.mobileAccountId)
  else void mail.setAggregate('all-unread')
}

function refreshCurrent(): void {
  if (mail.mobileAccountId) void mail.refreshAccount(mail.mobileAccountId)
  mail.drawerOpen = false
}
</script>
