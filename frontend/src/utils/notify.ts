// 浏览器新邮件通知（Notification API；前端-only，无后端依赖）。
// 触发条件（合并窗口到点时统一判断，缺一不可）：
//   1. 通知开关开着（localStorage 键 luck-mail-notify 为 '1'）；
//   2. 浏览器权限已授予（Notification.permission === 'granted'）；
//   3. 页面当前不在前台（document.hidden 为 true；正在看邮件列表时不打扰，只亮红点）。
// 多封合并：3 秒窗口内多封只弹一条——单封标题=发件人、正文=主题；
// 多封标题=`收到 N 封新邮件`、正文=前 3 位发件人（逗号分隔）。
// 点单封通知：聚焦窗口后打开那封邮件；点合并通知：聚焦窗口后切到所有收件箱。
// 防御：Notification 未定义（Node/旧浏览器）时全部静默跳过，绝不报错；
// 本模块从不主动弹授权框（requestNotifyPermission 只由设置弹窗的开关点击调）。

export const NOTIFY_KEY = 'luck-mail-notify' // localStorage 键：'1' 开，其他关
export const NOTIFY_MERGE_MS = 3000 // 合并窗口
export const NOTIFY_BATCH_TAG = 'luck-mail-batch'

export interface NotifyItem {
  id: number | string
  sender: string
  subject: string
}

export interface NotifyHandlers {
  onOpenMessage: (id: number | string) => void
  onOpenInbox: () => void
}

export function isNotifySupported(): boolean {
  return typeof Notification !== 'undefined'
}

export function getNotifyPermission(): NotificationPermission | 'unsupported' {
  if (!isNotifySupported()) return 'unsupported'
  try {
    return Notification.permission
  } catch {
    return 'default'
  }
}

/** 请求通知权限：必须由用户点击触发，浏览器才允许弹授权框。 */
export async function requestNotifyPermission(): Promise<NotificationPermission | 'unsupported'> {
  if (!isNotifySupported()) return 'unsupported'
  try {
    const p = await Notification.requestPermission()
    return p
  } catch {
    return getNotifyPermission()
  }
}

function singleTag(id: number | string): string {
  return `luck-mail-${String(id)}`
}

export class MailNotifier {
  private pending: NotifyItem[] = []
  private timer: ReturnType<typeof setTimeout> | null = null
  private handlers: NotifyHandlers | null = null
  private isEnabled: (() => boolean) | null = null

  private mergeMs: number

  constructor(mergeMs: number = NOTIFY_MERGE_MS) {
    // 不用参数属性（constructor(private x)：Node 类型剥离不支持，会导致测试无法直接 import 此文件）
    this.mergeMs = mergeMs
  }

  /** 新邮件入队：窗口内攒着，到点只弹一条（单封/合并）。开关、权限、前台状态在到点时再判断。 */
  queue(item: NotifyItem, ctx: { isEnabled: () => boolean } & NotifyHandlers): void {
    this.isEnabled = ctx.isEnabled
    this.handlers = { onOpenMessage: ctx.onOpenMessage, onOpenInbox: ctx.onOpenInbox }
    this.pending.push(item)
    if (!this.timer) {
      this.timer = setTimeout(() => { this.timer = null; this.flush() }, this.mergeMs)
    }
  }

  /** 清掉待发队列（退出登录时调，避免登出后还弹通知、点了又打不开）。 */
  reset(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null }
    this.pending = []
    this.handlers = null
    this.isEnabled = null
  }

  private flush(): void {
    const items = this.pending
    this.pending = []
    const handlers = this.handlers
    if (!items.length || !handlers) return
    if (!this.isEnabled || !this.isEnabled()) return
    if (!isNotifySupported()) return
    if (Notification.permission !== 'granted') return
    // 正在看页面时不打扰：只亮左栏红点（store 那边已更新未读数）。
    if (typeof document !== 'undefined' && !document.hidden) return
    try {
      if (items.length === 1) {
        const m = items[0]
        const n = new Notification(m.sender || '新邮件', { body: m.subject || '', tag: singleTag(m.id) })
        n.onclick = () => { this.focusWindow(); handlers.onOpenMessage(m.id); n.close() }
      } else {
        const senders = items.slice(0, 3).map((m) => m.sender).filter(Boolean)
        const n = new Notification(`收到 ${items.length} 封新邮件`, { body: senders.join('，'), tag: NOTIFY_BATCH_TAG })
        n.onclick = () => { this.focusWindow(); handlers.onOpenInbox(); n.close() }
      }
    } catch {
      // 通知被浏览器拦截/构造失败：静默跳过，不影响收信。
    }
  }

  private focusWindow(): void {
    try { if (typeof window !== 'undefined') window.focus() } catch { /* 忽略 */ }
  }
}
