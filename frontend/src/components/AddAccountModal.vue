<template>
  <div v-if="open" class="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4">
    <div class="bg-white rounded-lg shadow-xl w-[520px] max-w-full flex flex-col overflow-hidden max-h-[92vh]">
      <div class="flex items-center justify-between px-5 py-3 border-b border-blue-100">
        <span class="font-bold text-slate-700">{{ editing ? '邮箱设置' : '添加邮箱' }}</span>
        <button class="text-slate-400 hover:text-slate-600" aria-label="关闭" @click="close"><i class="fa-solid fa-xmark"></i></button>
      </div>
      <div class="flex-1 min-h-0 p-5 space-y-3 overflow-y-auto text-sm">
        <p class="text-xs text-slate-400">创建时后端会实测 IMAP + SMTP 连通。</p>
        <div>
          <label class="block text-xs text-slate-500 mb-1">邮件帐号</label>
          <!-- 帐号框禁止浏览器自动填充（用户 2026-11-19 补充要求）：与设置
               弹窗密码框同一手法——未聚焦时 readonly（浏览器不往只读框里
               自动填），聚焦后才可编辑；autocomplete 本来就是 off。注意
               @blur 要同时做两件事（恢复只读 + 按域名自动填服务器），合
               并成一个 onEmailBlur 处理器（同一元素不能写两个 @blur）。 -->
          <input id="add-email" v-model="form.email" type="email" autocomplete="off" :disabled="!!editing" :readonly="!emailFocused" @focus="emailFocused = true" @blur="onEmailBlur" class="w-full border border-slate-200 rounded-md px-3 py-2 outline-none focus:ring-1 focus:ring-blue-400 focus:border-blue-400 disabled:bg-slate-50" @input="autofill">
        </div>
        <div>
          <label class="block text-xs text-slate-500 mb-1">密码 <span class="text-slate-400">（163/QQ 请填客户端授权码，不是网页密码）</span></label>
          <div class="relative">
            <!-- 密码框禁止浏览器自动填充（用户 2026-11-19 补充要求）：与帐号
                 框同一手法——未聚焦时 readonly，聚焦后才可编辑；同时去掉
                 会招填充的 autocomplete="new-password" 信号，改成 off。
                 编辑模式下密码是程序回填的（api.getAccountPassword），只读
                 不影响程序赋值；小眼睛切换只改 type，不影响只读逻辑。 -->
            <input id="add-password" v-model="form.password" :type="showPw ? 'text' : 'password'" autocomplete="off" :readonly="!passwordFocused" @focus="passwordFocused = true" @blur="passwordFocused = false" class="w-full border border-slate-200 rounded-md px-3 py-2 pr-10 outline-none focus:ring-1 focus:ring-blue-400 focus:border-blue-400">
            <button type="button" class="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 w-7 h-7" @click="showPw = !showPw">
              <i :class="showPw ? 'fa-regular fa-eye-slash' : 'fa-regular fa-eye'"></i>
            </button>
          </div>
        </div>
        <div>
          <label class="block text-xs text-slate-500 mb-1">备注名（别名，选填）</label>
          <input v-model="form.displayName" type="text" autocomplete="off" class="w-full border border-slate-200 rounded-md px-3 py-2 outline-none focus:ring-1 focus:ring-blue-400 focus:border-blue-400">
        </div>

        <div class="border-t border-slate-100 pt-3 space-y-3">
          <div class="font-medium text-slate-700 text-[13px]">接收服务器（IMAP）</div>
          <div class="grid grid-cols-[1fr_110px] gap-2">
            <input id="add-imap-host" v-model="form.imapHost" type="text" autocomplete="off" class="border border-slate-200 rounded-md px-3 py-2 outline-none focus:ring-1 focus:ring-blue-400 focus:border-blue-400" @input="markManualServerEdit">
            <input v-model.number="form.imapPort" type="number" autocomplete="off" class="border border-slate-200 rounded-md px-3 py-2 outline-none focus:ring-1 focus:ring-blue-400 focus:border-blue-400" @input="markManualServerEdit">
          </div>
          <div class="flex items-center gap-4">
            <label class="flex items-center gap-1.5 text-xs text-slate-600"><input v-model="form.imapSecure" type="radio" value="SSL" class="accent-blue-500"> SSL</label>
            <label class="flex items-center gap-1.5 text-xs text-slate-600"><input v-model="form.imapSecure" type="radio" value="STARTTLS" class="accent-blue-500"> STARTTLS</label>
          </div>

          <div class="font-medium text-slate-700 text-[13px] pt-1">发送服务器（SMTP）</div>
          <div class="grid grid-cols-[1fr_110px] gap-2">
            <input id="add-smtp-host" v-model="form.smtpHost" type="text" autocomplete="off" class="border border-slate-200 rounded-md px-3 py-2 outline-none focus:ring-1 focus:ring-blue-400 focus:border-blue-400" @input="markManualServerEdit">
            <input v-model.number="form.smtpPort" type="number" autocomplete="off" class="border border-slate-200 rounded-md px-3 py-2 outline-none focus:ring-1 focus:ring-blue-400 focus:border-blue-400" @input="markManualServerEdit">
          </div>
          <div class="flex items-center gap-4">
            <label class="flex items-center gap-1.5 text-xs text-slate-600"><input v-model="form.smtpSecure" type="radio" value="SSL" class="accent-blue-500"> SSL</label>
            <label class="flex items-center gap-1.5 text-xs text-slate-600"><input v-model="form.smtpSecure" type="radio" value="STARTTLS" class="accent-blue-500"> STARTTLS</label>
          </div>
          <p v-if="presetNote" class="text-xs text-blue-500">{{ presetNote }}</p>
        </div>

        <p v-if="error" class="text-xs text-red-500 bg-red-50 border border-red-100 rounded-lg px-3 py-2 whitespace-pre-wrap">{{ error }}</p>
      </div>
      <div class="flex items-center justify-end gap-2 px-5 py-3 border-t border-blue-100 bg-slate-50/50">
        <button v-if="editing" class="px-4 py-2 rounded-md text-sm text-slate-600 hover:bg-slate-100" :disabled="busy" title="测试的是已保存的凭据；改了表单请先保存" @click="test">测试连通</button>
        <button class="px-4 py-2 rounded-md text-sm text-slate-600 hover:bg-slate-100" @click="close">取消</button>
        <button v-if="!editing" class="px-4 py-2 rounded-md text-sm text-slate-600 hover:bg-slate-100" @click="back">返回</button>
        <button class="px-5 py-2 rounded-md text-sm bg-blue-500 hover:bg-blue-600 text-white font-medium disabled:opacity-60" :disabled="busy" @click="submit">{{ busy ? '验证中…' : (editing ? '保存' : '创建') }}</button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue'
import type { PropType } from 'vue'
import { api, ApiError } from '../api'
import { useMailStore } from '../stores/mail'
import type { Account, SecureKind } from '../types'

const props = defineProps({
  open: { type: Boolean, default: false },
  editing: { type: Object as PropType<Account | null>, default: null } // 账号对象（编辑模式）或 null（新增）
})
const emit = defineEmits(['close', 'back', 'saved'])
const mail = useMailStore()

interface AccountForm {
  email: string
  password: string
  displayName: string
  imapHost: string
  imapPort: number
  imapSecure: SecureKind
  smtpHost: string
  smtpPort: number
  smtpSecure: SecureKind
}

const empty = (): AccountForm => ({
  email: '', password: '', displayName: '',
  imapHost: '', imapPort: 993, imapSecure: 'SSL',
  smtpHost: '', smtpPort: 465, smtpSecure: 'SSL'
})
const form = ref<AccountForm>(empty())
const showPw = ref<boolean>(false)
const emailFocused = ref<boolean>(false) // 帐号框防自动填充：聚焦前只读（同设置弹窗密码框）
const passwordFocused = ref<boolean>(false) // 密码框防自动填充：聚焦前只读（同设置弹窗密码框）
// 审计 #12 L2：打开设置时回填的已保存密码（与表单密码分开记）——
// “测试连通”测的是已保存凭据，表单密码改过时要能比出来、拦住误导性测试。
const savedPassword = ref<string>('')
const busy = ref<boolean>(false)
const error = ref<string>('')
const presetNote = ref<string>('')
// 预设表缓存：弹窗打开时拉一次，之后按域名同步查，不用每次等接口，
// 输完域名立刻就能填好服务器，不用等失焦、也不怕接口慢一拍。
const presetsCache = ref<Record<string, { imapHost: string; imapPort: number; imapSecure: string; smtpHost: string; smtpPort: number; smtpSecure: string; note: string }> | null>(null)
const lastAutofillDomain = ref<string>('')
// 用户手工改过服务器的域名集合（审计 #5 LOW）：域名 A→B→A 时，A 若在集合里
// 说明用户在 A 下手工改过服务器，自动填入不再覆盖；只在本次弹窗打开期间记，
// 关弹窗即清（每次打开重新记）。
const manualServerDomains = ref<Set<string>>(new Set())
// 用户手工改服务器字段时记下当前域名：之后自动填入跳过这个域名，
// 不把手工改过的服务器覆盖掉（v-model 的程序赋值不触发 @input，
// 只有用户真动手改才记）。
function markManualServerEdit(): void {
  const domain = (form.value.email.trim().split('@')[1] || '').toLowerCase()
  if (domain) manualServerDomains.value.add(domain)
}

watch(() => props.open, (v) => {
  if (!v) return
  error.value = ''
  presetNote.value = ''
  busy.value = false
  showPw.value = false
  emailFocused.value = false
  passwordFocused.value = false
  savedPassword.value = ''
  lastAutofillDomain.value = ''
  manualServerDomains.value = new Set()
  if (!props.editing && !presetsCache.value) {
    api.presets().then((d) => { presetsCache.value = d.presets || {} }).catch(() => { /* 拉不到就走单域名接口 */ })
  }
  if (props.editing) {
    const a = props.editing
    form.value = {
      email: a.email, password: '', displayName: a.displayName || '',
      imapHost: a.imapHost || '', imapPort: a.imapPort || 993, imapSecure: a.imapSecure || 'SSL',
      smtpHost: a.smtpHost || '', smtpPort: a.smtpPort || 465, smtpSecure: a.smtpSecure || 'SSL'
    }
    // 回填当前密码：打开设置就能看到，点小眼睛显示明文；取不到就留空（仍可手工输入新密码保存）。
    api.getAccountPassword(a.id).then((d) => {
      if (props.open && props.editing && props.editing.id === a.id) {
        form.value.password = d.password || ''
        savedPassword.value = d.password || ''
      }
    }).catch(() => { /* 取不到就留空，不阻塞编辑 */ })
  } else form.value = empty()
})

// 帐号框失焦：恢复只读（防浏览器自动填充），同时按域名自动填服务器。
// 注意：这里的“自动填入”是应用自己的预设服务器查询（见 autofill），
// 不是浏览器自动填充——两件事不要混淆。
function onEmailBlur(): void {
  emailFocused.value = false
  void autofill()
}

// 按域名自动填服务器：输入时就触发（不用等失焦），域名没变不重复填，
// 避免把用户手工改过的服务器又覆盖掉。优先用缓存的预设表同步查，
// 缓存还没到就走单域名接口；接口失败也不阻塞，保留手工输入。
// 审计 #11 L17：进行中的自动填充请求（autofillPromise）：提交前先等它完成，
// 避免用户输完邮箱立刻点保存、请求还没回来、服务器地址还是空的就发出去了。
let autofillPromise: Promise<void> | null = null
async function autofill(): Promise<void> {
  const email = form.value.email.trim()
  const domain = (email.split('@')[1] || '').toLowerCase()
  if (!domain || !domain.includes('.') || props.editing) return
  if (domain === lastAutofillDomain.value) return
  lastAutofillDomain.value = domain
  // 该域名下用户手工改过服务器：不再自动填入，避免覆盖手工值。
  if (manualServerDomains.value.has(domain)) {
    presetNote.value = '该域名服务器为手工填写，未自动覆盖。'
    return
  }
  const apply = (p: { imapHost: string; imapPort: number; imapSecure: string; smtpHost: string; smtpPort: number; smtpSecure: string } | null, note: string): void => {
    if (p) {
      form.value.imapHost = p.imapHost; form.value.imapPort = p.imapPort; form.value.imapSecure = p.imapSecure as 'SSL' | 'STARTTLS'
      form.value.smtpHost = p.smtpHost; form.value.smtpPort = p.smtpPort; form.value.smtpSecure = p.smtpSecure as 'SSL' | 'STARTTLS'
      presetNote.value = note || `已按 ${domain} 自动填入服务器信息。`
    } else {
      // 未知域名：契约回落 imap./smtp.+domain
      form.value.imapHost = `imap.${domain}`; form.value.imapPort = 993; form.value.imapSecure = 'SSL'
      form.value.smtpHost = `smtp.${domain}`; form.value.smtpPort = 465; form.value.smtpSecure = 'SSL'
      presetNote.value = '该域名没有预设，已按通用规则填入 imap./smtp. 服务器，请核对。'
    }
  }
  const cached = presetsCache.value?.[domain]
  if (cached) { apply(cached, cached.note || ''); return }
  const p = (async (): Promise<void> => {
    try {
      const data = await api.preset(domain)
      // 竞态：等接口回来时用户可能已改了邮箱域名，若不一致就丢弃这次结果，
      // 避免把 A 域名的服务器填进已改成 B 域名的表单里。
      const nowDomain = (form.value.email.trim().split('@')[1] || '').toLowerCase()
      if (nowDomain !== domain) return
      const preset = data.preset
      if (preset) apply(preset, data.note || '')
      else apply(null, '')
    } catch {
      // 审计 #11 L18：预设拉取失败时重置 lastAutofillDomain，下次输入同一域名
      // 还会再试一次（以前失败后同域名不再重试自动填充）；预设失败不阻塞，
      // 保留手工输入。
      if (lastAutofillDomain.value === domain) lastAutofillDomain.value = ''
    }
  })()
  autofillPromise = p
  try { await p } finally { if (autofillPromise === p) autofillPromise = null }
}

async function submit(): Promise<void> {
  error.value = ''
  if (!form.value.email.trim()) { error.value = '请填写邮箱地址。'; return }
  // 添加邮箱必填与格式校验（用户 2026-11-19 要求）：邮件帐号须符合邮箱
  // 格式才允许提交。注意 type="email" 的原生校验拦不住这里——提交是 click
  // 处理器、不是表单 submit，浏览器不会代劳；须自己校验。与后端 POST
  // /api/accounts 用同一正则（允许 + 号、子域名、多级域名）。编辑模式
  // 下邮箱框是 disabled、改不了，不重复校验。
  if (!props.editing && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.value.email.trim())) { error.value = '邮箱格式不正确，请检查邮件帐号。'; return }
  if (!props.editing && !form.value.password) { error.value = '请填写密码（163/QQ 请填客户端授权码）。'; return }
  // 审计 #11 L17：有进行中的自动填充先等它完成（最多 3 秒），再校验服务器
  // 地址非空——避免提交抢在填充完成前发出、服务器地址还是空的。
  // 注意：这里等的不是浏览器自动填充，而是应用自己的预设服务器查询
  // （autofill() 按邮箱域名从后端取预设）；浏览器自动填充已被上面的
  // readonly 手法拦住，与这段等待无关，所以这段逻辑原样保留。
  if (autofillPromise) {
    try { await Promise.race([autofillPromise, new Promise((r) => setTimeout(r, 3000))]) } catch { /* 等不到就按现有表单提交 */ }
  }
  // 添加邮箱必填与格式校验（用户 2026-11-19 要求）：接收/发送服务器
  // 各自必填，缺哪项就点名哪项（旧版是两项合在一起的一句话）。
  if (!form.value.imapHost.trim()) { error.value = '请填写接收服务器（IMAP）地址。'; return }
  if (!form.value.smtpHost.trim()) { error.value = '请填写发送服务器（SMTP）地址。'; return }
  busy.value = true
  try {
    if (props.editing) {
      const payload: Record<string, unknown> = {
        displayName: form.value.displayName || undefined,
        imapHost: form.value.imapHost, imapPort: form.value.imapPort, imapSecure: form.value.imapSecure,
        smtpHost: form.value.smtpHost, smtpPort: form.value.smtpPort, smtpSecure: form.value.smtpSecure
      }
      if (form.value.password) payload.password = form.value.password
      await api.updateAccount(props.editing.id, payload)
      mail.showToast('邮箱设置已保存')
    } else {
      await api.createAccount({
        email: form.value.email.trim(),
        password: form.value.password,
        displayName: form.value.displayName || undefined,
        imapHost: form.value.imapHost || undefined,
        imapPort: form.value.imapPort || undefined,
        imapSecure: form.value.imapSecure,
        smtpHost: form.value.smtpHost || undefined,
        smtpPort: form.value.smtpPort || undefined,
        smtpSecure: form.value.smtpSecure
      })
      mail.showToast('邮箱添加成功，正在同步')
    }
    await mail.loadAccounts()
    emit('saved')
    close()
  } catch (e) {
    // 后端返回的错误原样显示（说明哪一步连通失败）
    error.value = e instanceof ApiError ? e.message : '操作失败，请重试。'
  } finally {
    busy.value = false
  }
}

async function test(): Promise<void> {
  if (!props.editing) return
  error.value = ''
  // 审计 #12 L2：POST /api/accounts/:id/test 测的是库里已保存的凭据，
  // 不是当前表单——用户改了密码/服务器后点它，看到的是旧凭据的结果，
  // 属于虚假信心。表单与已保存不一致时不发请求，直接明示：改了请先
  // 保存（保存时后端会重测，见 submit），或把改动改回去再测。
  // 密码框是异步回填的（打开时可能还是空）：空时不参与比较，不误拦。
  const a = props.editing
  const f = form.value
  const differs = f.email.trim() !== (a.email || '')
    || f.imapHost.trim() !== (a.imapHost || '')
    || Number(f.imapPort) !== Number(a.imapPort || 993)
    || f.imapSecure !== (a.imapSecure || 'SSL')
    || f.smtpHost.trim() !== (a.smtpHost || '')
    || Number(f.smtpPort) !== Number(a.smtpPort || 465)
    || f.smtpSecure !== (a.smtpSecure || 'SSL')
    || (f.password !== '' && savedPassword.value !== '' && f.password !== savedPassword.value)
  if (differs) {
    error.value = '表单有未保存的改动：这里测的是已保存的凭据，不是当前表单。改了密码或服务器请先点“保存”（保存时会自动重新测试），或把改动改回去再测。'
    return
  }
  busy.value = true
  try {
    const r = await api.testAccount(props.editing.id)
    if (r.imapOk && r.smtpOk) mail.showToast('IMAP 与 SMTP 连通正常')
    else error.value = r.error || `连通测试未通过：IMAP ${r.imapOk ? '正常' : '失败'}，SMTP ${r.smtpOk ? '正常' : '失败'}。`
  } catch (e) {
    error.value = e instanceof ApiError ? e.message : '测试失败，请重试。'
  } finally {
    busy.value = false
  }
}

function back(): void { emit('back') }
function close(): void { emit('close') }
</script>
