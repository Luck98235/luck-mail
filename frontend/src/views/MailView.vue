<template>
  <div class="app-viewport flex flex-col bg-white text-slate-800 text-sm overflow-hidden">
    <!-- 桌面端 ≥1024px：完整 3 栏 -->
    <div id="desktop-layout" class="hidden lg:flex flex-1 min-h-0">
      <MailSidebar @compose="openCompose()" @manage="manageOpen = true" @settings="settingsOpen = true" @logout="logout" />
      <MessageList variant="desktop" />
      <ReadingPane @reply="reply" @forward="forward" />
    </div>

    <!-- 手机/平板 <1024px：QQ 邮箱 APP 式布局 -->
    <div class="lg:hidden flex-1 min-h-0">
      <MobileShell
        @compose="openCompose()"
        @logout="logout"
        @reply="reply"
        @forward="forward"
      />
    </div>

    <!-- 弹窗 -->
    <ComposeModal :open="composeOpen" :initial="composeInitial" @close="composeOpen = false" @sent="composeOpen = false" />
    <ManageAccountsModal :open="manageOpen" :edit-account-id="manageEditId ?? undefined" @close="manageOpen = false" @edit-consumed="manageEditId = null" />
    <SettingsModal :open="settingsOpen" @close="settingsOpen = false" />
    <ConfirmModal />
    <ThemePanel />

    <!-- Toast：带动作的 toast（认证失败提醒）可点，点它打开该账号的设置；普通 toast 不可点 -->
    <div v-if="mail.toast" class="fixed bottom-6 left-1/2 -translate-x-1/2 z-[70] bg-slate-800 text-white text-xs px-4 py-2 rounded-full shadow-lg" :class="mail.toastAction ? 'cursor-pointer hover:bg-slate-700' : ''" :title="mail.toastAction ? '点击打开邮箱设置' : ''" @click="onToastClick">
      {{ mail.toast }}
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useAuthStore } from '../stores/auth'
import { useMailStore } from '../stores/mail'
import MailSidebar from '../components/MailSidebar.vue'
import MessageList from '../components/MessageList.vue'
import ReadingPane from '../components/ReadingPane.vue'
import MobileShell from '../components/MobileShell.vue'
import ComposeModal from '../components/ComposeModal.vue'
import type { ComposeInitial } from '../components/ComposeModal.vue'
import ManageAccountsModal from '../components/ManageAccountsModal.vue'
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
const manageEditId = ref<number | null>(null) // 侧栏认证失败标记点进来时，直达该账号的设置
const settingsOpen = ref<boolean>(false)

onMounted(() => { void mail.init() })
onUnmounted(() => { mail.disconnectRealtime(); mail.destroyMobileHistory() })

// 打开指定账号的设置（侧栏认证失败标记 / 认证失败 toast 点进来）：
// 先给直达 id 再打开邮箱管理，管理弹窗打开后自动进该账号的设置。
watch(() => mail.accountSettingsRequest, (id) => {
  if (id == null) return
  manageEditId.value = id
  manageOpen.value = true
  mail.accountSettingsRequest = null
})

// 点 toast：有动作才执行（认证失败提醒 → 打开该账号的设置；移动端只提示去电脑端）。
function onToastClick(): void {
  const fn = mail.toastAction
  if (!fn) return
  mail.dismissToast()
  fn()
}

// 点草稿：回填到写信弹窗
watch(() => mail.composeDraft, (d) => {
  if (!d) return
  // 写信窗已开时 open 不变、ComposeModal 的 open watch 不触发，新 initial
  // 会被丢掉——直接返回、不替换正在编辑的内容。这条分支实际不可达：
  // 写信窗是全屏遮罩（fixed inset-0 z-50），窗开着时底层点击到不了草稿行，
  // 审计 #14 LOW-1 删掉了原来这里弹的“请先关闭当前写信窗”toast（死代码），
  // 只留静默守卫作防御。
  if (composeOpen.value) {
    mail.composeDraft = null
    return
  }
  // 审计 #16 LOW-4：草稿所属账号可能已被另一标签页删掉（草稿随账号级联
  // 删除），此时发件人下拉里没有对应选项、打开的是空白发件人的写信窗；
  // 先校验账号还在，不在则提示并刷新草稿列表、不开窗。accountId 为 null
  // 的草稿（无指定账号）不受影响，仍按原流程打开。
  if (d.accountId != null && !mail.accounts.some((a) => a.id === d.accountId)) {
    mail.showToast('该邮箱已被删除')
    void mail.loadDrafts()
    mail.composeDraft = null
    return
  }
  composeInitial.value = {
    to: d.to, subject: d.subject, body: d.text, accountId: d.accountId, draftId: d.id,
    // 审计 #11 H1/L15：草稿的 threading 与抄送透传回写信弹窗（重开草稿再发
    // 仍是同一会话，cc 不丢）；审计 #12 B1：后端 GET /api/drafts 返回的
    // references 是数组（draftRoutes publicDraft split 成数组），不是
    // 空格串——直接 .split 会在数组上抛 TypeError，回复草稿永远打不开。
    // 这里归一化（与下面 replyReferences 的详情写法一致），字符串也兼容。
    ...(d.inReplyTo ? { inReplyTo: d.inReplyTo } : {}),
    ...(d.references ? { references: (Array.isArray(d.references) ? d.references : d.references.split(' ')).filter(Boolean) } : {}),
    ...(d.cc?.length ? { cc: d.cc.join(', ') } : {})
  }
  composeOpen.value = true
  mail.composeDraft = null
})

function openCompose(prefill: ComposeInitial = {}): void {
  // 写信窗已开时 open 不变、弹窗的 open watch 不触发，新 initial 会被丢掉——
  // 直接返回、不替换正在编辑的内容。这条分支实际不可达（写信窗是全屏遮罩，
  // 窗开着时底层点击到不了回复/转发/写信按钮），审计 #14 LOW-1 删掉了原来
  // 这里弹的“请先关闭当前写信窗”toast（死代码），只留静默守卫作防御。
  if (composeOpen.value) {
    return
  }
  // 审计 #15 MED-1：零邮箱时写信入口直接拦住——写信窗的发件人下拉是空的，
  // 打开也存不上草稿、发不出去；提示用户先添加邮箱。
  if (!mail.accounts.length) { mail.showToast('请先添加邮箱'); return }
  composeInitial.value = prefill
  composeOpen.value = true
}

function quoteOf(m: MessageDetail): string {
  return `\n\n--- 原始邮件 ---\n发件人：${m.fromName || m.from}\n主题：${m.subject}\n${m.bodyText || ''}`
}

// 回复 threading（审计 #10 H1）：原信 Message-ID 作 In-Reply-To，
// 原 References 链 + 原 Message-ID 作 References；后端在发信时据此写头。
// 审计 #13 LOW-2：字符串分支须拆分——以前 `[m.references]` 把整条空格串
// 当成一个 References 元素；与 composeDraft watch 的归一化一致。
function replyReferences(m: MessageDetail): string[] {
  const refs = typeof m.references === 'string' ? m.references.split(' ').filter(Boolean) : (m.references || [])
  return m.messageId ? [...refs, m.messageId] : refs
}

// 审计 #11 M5：回复/转发主题前缀同时认中文与英文（Re:/Fw:/Fwd:，大小写不敏感）；
// 原主题为空时不加前缀（不留孤零零的“回复：”）。
function withReplyPrefix(subject: string | undefined, prefix: '回复：' | '转发：'): string {
  const s = (subject || '').trim()
  if (!s) return ''
  if (prefix === '回复：' && (s.startsWith('回复：') || /^re\s*:/i.test(s))) return s
  if (prefix === '转发：' && (s.startsWith('转发：') || /^fw(d)?\s*:/i.test(s))) return s
  return `${prefix}${s}`
}

function reply(m: MessageDetail): void {
  openCompose({
    // 审计 #11 L23：有 Reply-To 时优先发给它（详情接口返回的 replyTo 字段），无则沿用发件人。
    to: m.replyTo || m.from,
    subject: withReplyPrefix(m.subject, '回复：'),
    body: quoteOf(m),
    accountId: m.accountId,
    ...(m.messageId ? { inReplyTo: m.messageId } : {}),
    ...(replyReferences(m).length ? { references: replyReferences(m) } : {})
  })
}

function forward(m: MessageDetail): void {
  // 转发不带 In-Reply-To，只带 References（原链 + 原 Message-ID）。
  openCompose({
    to: '',
    subject: withReplyPrefix(m.subject, '转发：'),
    body: quoteOf(m),
    accountId: m.accountId,
    ...(replyReferences(m).length ? { references: replyReferences(m) } : {})
  })
}

async function logout(): Promise<void> {
  mail.disconnectRealtime()
  // 审计 #11 L1：退出时清掉持久化导航/移动端/展开/删除视图状态，下次登录从默认视图进。
  mail.resetSessionState(true)
  await auth.logout()
  router.replace('/login')
}
</script>
