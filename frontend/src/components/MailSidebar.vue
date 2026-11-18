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
      <button id="btn-refresh-all" class="w-9 shrink-0 bg-white hover:bg-blue-50 text-blue-500 border border-blue-200 rounded-lg flex items-center justify-center shadow-sm transition-colors" title="全部刷新" @click="mail.refreshAll()">
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
            <!-- 点邮箱行：未展开时展开 + 切单邮箱收件箱，已展开时再点折叠；点 `>`：只展开/折叠 -->
            <div class="acct-row group flex items-center gap-2 px-2 py-1.5 text-slate-700 hover:bg-blue-100/50 rounded cursor-pointer" @click="mail.selectAccount(a.id)">
              <i class="fa-solid fa-chevron-right w-3 text-[10px] text-slate-400 cursor-pointer" title="展开/折叠文件夹" @click.stop="mail.toggleAccountExpand(a.id)"></i>
              <span class="w-5 shrink-0 text-right text-[11px] text-slate-400">{{ String(idx + 1).padStart(2, '0') }}</span>
              <span class="w-4 h-4 rounded-full text-white flex items-center justify-center text-[8px] font-bold shrink-0" :style="{ background: domainColor(a.email) }">{{ domainShort(a.email) }}</span>
              <span class="truncate" :title="a.email" :class="{ 'opacity-50': a.enabled === false }">{{ a.displayName || a.email }}</span>
              <span class="ml-auto flex items-center gap-1 shrink-0">
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
              <div v-if="mail.expanded.has(a.id) && !(mail.foldersByAccount[a.id] || []).length" class="px-2 py-1 text-[11px] text-slate-400">文件夹同步中…</div>
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
import { domainColor, domainShort } from '../utils'
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
  const text = a.email
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    // 剪贴板 API 不可用时回落到临时 textarea + execCommand
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    try { document.execCommand('copy') } catch { /* 忽略 */ }
    document.body.removeChild(ta)
  }
  copiedId.value = a.id
  if (copiedTimer) clearTimeout(copiedTimer)
  copiedTimer = setTimeout(() => { copiedId.value = null }, 1500)
}

function isAggregateActive(kind: string): boolean {
  // 聚合视图激活态：当前是该聚合视图且未进入单邮箱
  return mail.view.kind === kind && mail.view.accountId == null
}
</script>
