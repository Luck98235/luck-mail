<template>
  <nav class="w-16 bg-blue-50 border-r border-blue-100 flex flex-col items-center py-4 flex-shrink-0 justify-between">
    <div class="w-10 h-10 rounded-full bg-blue-200 text-blue-700 flex items-center justify-center font-bold shadow-sm border border-blue-300 cursor-pointer" :title="auth.username || '用户'">
      <i class="fa-solid fa-user"></i>
    </div>
    <div class="flex flex-col gap-4 text-blue-400">
      <button class="w-10 h-10 rounded-full hover:bg-blue-100 hover:text-blue-600 transition-colors flex items-center justify-center" title="设置" @click="$emit('settings')">
        <i class="fa-solid fa-gear text-lg"></i>
      </button>
      <button class="w-10 h-10 rounded-full hover:bg-blue-100 hover:text-blue-600 transition-colors flex items-center justify-center" title="退出系统" @click="$emit('logout')">
        <i class="fa-solid fa-power-off text-lg"></i>
      </button>
      <button class="w-10 h-10 rounded-full hover:bg-blue-100 hover:text-blue-600 transition-colors flex items-center justify-center" title="配色" @click.stop="onPalette">
        <i class="fa-solid fa-palette text-lg"></i>
      </button>
    </div>
  </nav>
</template>

<script setup lang="ts">
import { useAuthStore } from '../stores/auth'
import { useThemeStore } from '../stores/theme'

defineEmits(['settings', 'logout'])
const auth = useAuthStore()
const theme = useThemeStore()

function onPalette(e: MouseEvent): void {
  theme.togglePanel(e.currentTarget as HTMLElement | null)
}
</script>
