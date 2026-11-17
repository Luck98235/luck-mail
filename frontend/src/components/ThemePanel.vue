<template>
  <div
    v-if="theme.panelOpen" id="theme-panel"
    :style="{ left: theme.panelPos.left + 'px', top: theme.panelPos.top + 'px' }"
    @click.stop
  >
    <div class="theme-title">主题配色</div>
    <div class="theme-grid">
      <button
        v-for="t in THEMES" :key="t.key" class="theme-swatch"
        :class="{ active: theme.current === t.key }"
        @click="pick(t.key)"
      >
        <span class="dot" :style="{ background: t.color }"></span>
        <span class="nm">{{ t.name }}</span>
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { onMounted, onUnmounted } from 'vue'
import { useThemeStore, THEMES } from '../stores/theme'

const theme = useThemeStore()

function pick(key: string): void {
  theme.apply(key)
  theme.closePanel()
}

function onDocClick(e: MouseEvent): void {
  if (theme.panelOpen && !(e.target as HTMLElement | null)?.closest('#theme-panel')) theme.closePanel()
}
function onKey(e: KeyboardEvent): void { if (e.key === 'Escape') theme.closePanel() }

onMounted(() => {
  document.addEventListener('click', onDocClick)
  document.addEventListener('keydown', onKey)
})
onUnmounted(() => {
  document.removeEventListener('click', onDocClick)
  document.removeEventListener('keydown', onKey)
})
</script>
