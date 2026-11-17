<template>
  <div class="h-screen flex flex-col bg-white text-slate-800 text-sm overflow-hidden">
    <!-- 桌面端 >1024px：完整 4 栏（与旧版一致） -->
    <div id="desktop-layout" class="hidden lg:flex flex-1 min-h-0">
      <SysNav @settings="settingsOpen = true" @logout="logout" />
      <MailSidebar @compose="openCompose()" @manage="manageOpen = true" />
      <MessageList variant="desktop" />
      <ReadingPane @reply="reply" @forward="forward" />
    </div>

    <!-- 手机/平板 <=1024px：QQ 邮箱 APP 式布局 -->
    <div class="lg:hidden flex-1 min-h-0">
      <MobileShell
        @compose="openCompose()"
        @manage="manageOpen = true"
        @add-account="addOpen = true"
        @settings="settingsOpen = true"
        @logout="logout"
        @reply="reply"
        @forward="forward"
      />
    </div>

    <!-- 弹窗 -->
    <ComposeModal :open="composeOpen" :initial="composeInitial" @close="composeOpen = false" @sent="composeOpen = false" />
    <ManageAccountsModal :open="manageOpen" @close="manageOpen = false" />
    <AddAccountModal :open="addOpen" @close="addOpen = false" @back="addOpen = false; manageOpen = true" @saved="addOpen = false" />
    <SettingsModal :open="settingsOpen" @close="settingsOpen = false" />
    <ConfirmModal />
    <ThemePanel />

    <!-- Toast -->
    <div v-if="mail.toast" class="fixed bottom-6 left-1/2 -translate-x-1/2 z-[70] bg-slate-800 text-white text-xs px-4 py-2 rounded-full shadow-lg">
      {{ mail.toast }}
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useAuthStore } from '../stores/auth'
import { useMailStore } from '../stores/mail'
import SysNav from '../components/SysNav.vue'
import MailSidebar from '../components/MailSidebar.vue'
import MessageList from '../components/MessageList.vue'
import ReadingPane from '../components/ReadingPane.vue'
import MobileShell from '../components/MobileShell.vue'
import ComposeModal from '../components/ComposeModal.vue'
import type { ComposeInitial } from '../components/ComposeModal.vue'
import ManageAccountsModal from '../components/ManageAccountsModal.vue'
import AddAccountModal from '../components/AddAccountModal.vue'
import SettingsModal from '../components/SettingsModal.vue'
import ConfirmModal from '../components/ConfirmModal.vue'
import ThemePanel from '../components/ThemePanel.vue'
import type { MessageDetail } from '../types'

const router = useRouter()
const auth = useAuthStore()
const mail = useMailStore()

const composeOpen = ref<boolean>(false)
const composeInitial = ref<ComposeInitial>({})
const manageOpen = ref<boolean>(false)
const addOpen = ref<boolean>(false)
const settingsOpen = ref<boolean>(false)

onMounted(() => { void mail.init() })
onUnmounted(() => { mail.disconnectRealtime() })

// 点本地草稿：回填到写信弹窗
watch(() => mail.composeDraft, (d) => {
  if (!d) return
  composeInitial.value = { to: d.to, subject: d.subject, body: d.text, accountId: d.accountId, draftId: d.id }
  composeOpen.value = true
  mail.composeDraft = null
})

function openCompose(prefill: ComposeInitial = {}): void {
  composeInitial.value = prefill
  composeOpen.value = true
}

function quoteOf(m: MessageDetail): string {
  return `\n\n--- 原始邮件 ---\n发件人：${m.fromName || m.from}\n主题：${m.subject}\n${m.bodyText || ''}`
}

function reply(m: MessageDetail): void {
  openCompose({
    to: m.from,
    subject: m.subject?.startsWith('回复：') ? m.subject : `回复：${m.subject}`,
    body: quoteOf(m),
    accountId: m.accountId
  })
}

function forward(m: MessageDetail): void {
  openCompose({
    to: '',
    subject: m.subject?.startsWith('转发：') ? m.subject : `转发：${m.subject}`,
    body: quoteOf(m),
    accountId: m.accountId
  })
}

async function logout(): Promise<void> {
  mail.disconnectRealtime()
  await auth.logout()
  router.replace('/login')
}
</script>
