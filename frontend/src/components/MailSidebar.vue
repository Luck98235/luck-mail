<template>
  <aside class="w-60 bg-blue-50/50 border-r border-blue-100 flex flex-col flex-shrink-0">
    <div class="h-16 flex items-center px-4 border-b border-blue-100/50 gap-2">
      <div class="w-8 h-8 bg-gradient-to-br from-blue-400 to-blue-600 rounded-lg flex items-center justify-center shadow-sm text-white">
        <i class="fa-solid fa-clover"></i>
      </div>
      <span class="font-black text-blue-700 tracking-wide text-lg">Luck-Mail</span>
    </div>

    <div class="p-3 flex gap-2">
      <button id="btn-compose" class="flex-1 bg-blue-500 hover:bg-blue-600 text-white py-2 rounded-md flex items-center justify-center gap-2 shadow-sm transition-colors font-medium text-sm" @click="$emit('compose')">
        <i class="fa-solid fa-pen"></i> 写信
      </button>
      <button id="btn-refresh-all" class="w-9 shrink-0 bg-white hover:bg-blue-50 text-blue-500 border border-blue-200 rounded-lg flex items-center justify-center shadow-sm transition-colors disabled:opacity-40" :disabled="mail.refreshingAll" title="全部刷新" @click="mail.refreshAll()">
        <i class="fa-solid fa-arrow-rotate-left" :class="{ 'fa-spin': mail.refreshingAll }"></i>
      </button>
    </div>

    <div class="flex-1 min-h-0 overflow-y-auto px-2 pb-4 space-y-4">
      <!-- 聚合分类 -->
      <div class="space-y-0.5 text-sm">
        <div v-for="agg in AGGREGATES" :key="agg.kind">
          <div
            class="flex items-center gap-2 px-2 py-1.5 rounded cursor-pointer"
            :class="isAggregateActive(agg.kind) ? 'bg-blue-100 text-blue-700 font-medium' : 'text-slate-700 hover:bg-blue-100/50'"
            @click="mail.setAggregate(agg.kind)"
          >
            <i class="fa-solid fa-chevron-right w-3 text-[10px] text-slate-400"></i>
            <i :class="[agg.icon, 'w-4 text-center', isAggregateActive(agg.kind) ? 'text-blue-500' : 'text-slate-400']"></i>
            <span>{{ agg.label }}</span>
            <span v-if="agg.kind === 'all-unread' && mail.totalUnread > 0" class="text-red-500 font-bold text-xs ml-auto">({{ mail.totalUnread }})</span>
          </div>
        </div>
      </div>

      <!-- 邮箱账号列表（平铺，无分组） -->
      <div class="pt-2">
        <div class="px-2 py-1 text-xs text-slate-400 mb-1 flex items-center justify-between">
          <span>邮箱</span>
          <button class="text-blue-500 hover:text-blue-600 text-xs" title="管理邮箱" @click="$emit('manage')">
            <i class="fa-solid fa-gear"></i> 管理
          </button>
        </div>
        <div class="space-y-0.5 text-sm" id="account-list">
          <div v-for="(a, idx) in mail.accounts" :key="a.id" class="acct-item" :class="{ expanded: mail.expanded.has(a.id) }">
            <!-- 点邮箱行：展开 + 切单邮箱收件箱（已展开时再点仍切收件箱、不折叠）；点 `>`：只展开/折叠 -->
            <div class="acct-row group flex items-center gap-2 px-2 py-1.5 text-slate-700 hover:bg-blue-100/50 rounded cursor-pointer" @click="onAccountRow(a.id)">
              <i class="fa-solid fa-chevron-right w-3 text-[10px] text-slate-400 cursor-pointer" title="展开/折叠文件夹" @click.stop="onToggleExpand(a.id)"></i>
              <span class="w-5 shrink-0 text-right text-[11px] text-slate-400">{{ String(idx + 1).padStart(2, '0') }}</span>
              <span class="w-4 h-4 rounded-full text-white flex items-center justify-center text-[8px] font-bold shrink-0" :style="{ background: domainColor(a.email) }">{{ domainShort(a.email) }}</span>
              <span class="truncate" :title="a.email" :class="{ 'opacity-50': a.enabled === false }">{{ a.displayName || a.email }}</span>
              <span class="ml-auto flex items-center gap-1 shrink-0">
                <!-- 认证失败标记：红色是既定的危险色，不随主题变；独立的可点击元素，
                     点它打开该账号的设置（@click.stop，别触发账号行本身的展开/切视图）。 -->
                <button v-if="a.status === 'error'" class="text-red-500 font-bold text-[11px] shrink-0 px-1 rounded hover:bg-red-50" :title="a.error || '连接异常，点击打开邮箱设置'" @click.stop="onAuthBadge(a.id)">
                  <i class="fa-solid fa-triangle-exclamation mr-0.5"></i>{{ accountErrorLabel(a.status, a.error) }}
                </button>
                <span v-if="a.status === 'syncing'" class="text-blue-400 text-[10px]"><i class="fa-solid fa-circle-notch fa-spin"></i></span>
                <span v-else-if="mail.unreadOfAccount(a.id) > 0" class="text-red-500 font-bold text-xs">({{ mail.unreadOfAccount(a.id) }})</span>
                <button class="w-5 h-5 flex items-center justify-center rounded text-slate-400 hover:text-blue-500 hover:bg-blue-100 opacity-0 group-hover:opacity-100 transition-opacity" :title="copiedId === a.id ? '已复制' : '复制邮箱'" @click.stop="copyEmail(a)">
                  <i :class="copiedId === a.id ? 'fa-solid fa-check text-green-500' : 'fa-regular fa-copy'" class="text-[11px]"></i>
                </button>
              </span>
            </div>
            <div class="acct-folders ml-6 mt-0.5 space-y-0.5">
              <div
                v-for="f in (mail.foldersByAccount[a.id] || [])" :key="f.id"
                class="flex items-center gap-2 px-2 py-1 text-slate-600 hover:bg-blue-100/50 rounded cursor-pointer"
                :class="{ 'bg-blue-100 text-blue-700': mail.view.kind === 'folder' && mail.view.folderId === f.id }"
                @click="mail.setFolderView(a.id, f)"
              >
                <i :class="[folderIcon(f.type), 'w-3 text-center text-slate-400 text-xs']"></i>
                <span class="truncate text-xs">{{ f.name }}</span>
                <span v-if="mail.unreadOfFolder(a.id, f.id) > 0" class="text-red-500 font-bold text-[10px] ml-auto">({{ mail.unreadOfFolder(a.id, f.id) }})</span>
              </div>
              <div v-if="mail.expanded.has(a.id) && !(mail.foldersByAccount[a.id] || []).length" class="px-2 py-1 text-[11px]" :class="foldersFailed.has(a.id) ? 'text-red-400 cursor-pointer' : 'text-slate-400'" @click="onFoldersHintClick(a.id)">{{ foldersFailed.has(a.id) ? '文件夹加载失败，点这里重试' : (mail.foldersByAccount[a.id] ? '暂无文件夹' : '文件夹同步中…') }}</div>
            </div>
          </div>
        </div>
      </div>
    </div>
    <!-- 底部：设置 / 配色 / 退出 -->
    <div class="border-t border-blue-100/60 px-3 py-2 flex items-center justify-around text-blue-400">
      <button class="w-9 h-9 rounded-full hover:bg-blue-100 hover:text-blue-600 transition-colors flex items-center justify-center" title="设置" @click="$emit('settings')">
        <i class="fa-solid fa-gear text-base"></i>
      </button>
      <button class="w-9 h-9 rounded-full hover:bg-blue-100 hover:text-blue-600 transition-colors flex items-center justify-center" title="配色" @click.stop="onPalette">
        <i class="fa-solid fa-palette text-base"></i>
      </button>
      <button class="w-9 h-9 rounded-full hover:bg-blue-100 hover:text-blue-600 transition-colors flex items-center justify-center" title="退出系统" @click="$emit('logout')">
        <i class="fa-solid fa-power-off text-base"></i>
      </button>
    </div>
  </aside>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { useMailStore, AGGREGATES, folderIcon } from '../stores/mail'
import { useThemeStore } from '../stores/theme'
import { domainColor, domainShort, copyText, accountErrorLabel } from '../utils'
import type { Account } from '../types'

defineEmits(['compose', 'manage', 'settings', 'logout'])
const mail = useMailStore()
const theme = useThemeStore()

function onPalette(e: MouseEvent): void {
  theme.togglePanel(e.currentTarget as HTMLElement | null)
}

// 复制邮箱：点复制按钮把完整邮箱地址写进剪贴板，成功后该行图标变绿勾 1.5 秒。
const copiedId = ref<number | null>(null)
let copiedTimer: ReturnType<typeof setTimeout> | null = null

async function copyEmail(a: Account): Promise<void> {
  const ok = await copyText(a.email)
  if (!ok) { mail.showToast('复制失败，请重试'); return }
  copiedId.value = a.id
  if (copiedTimer) clearTimeout(copiedTimer)
  copiedTimer = setTimeout(() => { copiedId.value = null }, 1500)
}

// 文件夹加载失败标记：store 的 loadFolders 失败时不写缓存（foldersByAccount[id]
// 仍是 undefined），成功（即使零个文件夹）也会写进一个数组；展开后用这个区分
// “加载失败”和“确实无文件夹”，别让失败也一直显示“同步中…”。
const foldersFailed = ref<Set<number>>(new Set())
function setFoldersFailed(id: number, failed: boolean): void {
  const next = new Set(foldersFailed.value)
  if (failed) next.add(id)
  else next.delete(id)
  foldersFailed.value = next
}
function checkFoldersAfterLoad(id: number): void {
  setFoldersFailed(id, mail.foldersByAccount[id] === undefined)
}
async function onAccountRow(id: number): Promise<void> {
  const wasExpanded = mail.expanded.has(id)
  await mail.selectAccount(id)
  if (!wasExpanded && mail.expanded.has(id)) checkFoldersAfterLoad(id)
  else if (wasExpanded) setFoldersFailed(id, false)
}
async function onToggleExpand(id: number): Promise<void> {
  const wasExpanded = mail.expanded.has(id)
  await mail.toggleAccountExpand(id)
  if (!wasExpanded && mail.expanded.has(id)) checkFoldersAfterLoad(id)
  else if (wasExpanded) setFoldersFailed(id, false)
}
async function retryFolders(id: number): Promise<void> {
  await mail.loadFolders(id, true)
  checkFoldersAfterLoad(id)
}
function onFoldersHintClick(id: number): void {
  // 展开后没文件夹就点这里重试——不只限加载失败时：刷新恢复的展开态
  // 也可能从没发过加载请求（2026-11-19 修复前就是这样一直转圈），
  // 点一下就补拉一次。
  void retryFolders(id)
}

// 认证失败标记：点它打开该账号的设置（桌面端；移动端不渲染本组件，
// MobileShell 那边点标记只提示去电脑端处理，见 requestAccountSettings）。
function onAuthBadge(id: number): void {
  mail.requestAccountSettings(id)
}

function isAggregateActive(kind: string): boolean {
  // 聚合视图激活态：当前是该聚合视图且未进入单邮箱
  return mail.view.kind === kind && mail.view.accountId == null
}
</script>
