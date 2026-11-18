// 实时推送：Socket.io 单连接（契约定稿，用户 2026-11-17 00:34 定）。
// 前端只用 socket.io-client，同源 /socket.io/，不用原生 WebSocket、不用 ws 库，
// 前端不直连 IMAP。服务端事件名与契约一致：
//   new-mail / mail-updated / mail-deleted / sync / account
// 客户端只发 ping 保活（Socket.io 自带心跳）。
// 收到事件后统一归一化成 {type, ...payload} 交给 Pinia store（mail.ts），
// 由 store 更新响应式 unreadCounts，导航树红色角标即时变化，不轮询、不整页刷新。
import { io, type Socket } from 'socket.io-client'
import type { RealtimeEvent } from './types'

const EVENT_TYPES = ['new-mail', 'mail-updated', 'mail-deleted', 'sync', 'account'] as const

export function createRealtime(
  onEvent: (msg: RealtimeEvent) => void,
  opts?: { onConnect?: () => void }
): { disconnect: () => void } {
  let socket: Socket | null = null
  let pingTimer: ReturnType<typeof setInterval> | null = null
  // 首次连接由应用 init() 拉全量；只有重连才需要对账（断线期间可能漏事件）。
  let firstConnect = true

  socket = io({
    path: '/socket.io/',
    reconnection: true,
    reconnectionDelay: 2000,
    reconnectionAttempts: Infinity,
    timeout: 5000
  })

  socket.on('connect', () => {
    if (pingTimer) clearInterval(pingTimer)
    pingTimer = setInterval(() => {
      try { socket?.emit('ping', { type: 'ping' }) } catch { /* 忽略 */ }
    }, 30000)
    if (!firstConnect) opts?.onConnect?.()
    firstConnect = false
  })
  socket.on('disconnect', () => {
    if (pingTimer) { clearInterval(pingTimer); pingTimer = null }
  })

  // 服务端按事件名分发（new-mail / mail-updated / mail-deleted / sync / account）
  for (const t of EVENT_TYPES) {
    socket.on(t, (payload: unknown) => {
      const p = (payload ?? {}) as Record<string, unknown>
      // 载荷归一化（审计 #10 安全 L7）：socket 载荷只做类型断言、无运行时校验；
      // id 若是数字字符串，去重比较（x.id === m.id）会失效、同一封信可出现两次。
      // 数字字符串归一化为 number，非数字原样保留。
      const asNum = (v: unknown): unknown => {
        if (typeof v === 'string' && /^\d+$/.test(v)) return Number(v)
        return v
      }
      if (t === 'new-mail' && p.message && typeof p.message === 'object') {
        const m = p.message as Record<string, unknown>
        m.id = asNum(m.id)
        m.accountId = asNum(m.accountId)
        m.folderId = asNum(m.folderId)
      }
      if ((t === 'mail-updated' || t === 'mail-deleted') && p.messageId != null) p.messageId = asNum(p.messageId)
      if (p.accountId != null) p.accountId = asNum(p.accountId)
      if (p.folderId != null) p.folderId = asNum(p.folderId)
      onEvent({ type: t, ...p } as RealtimeEvent)
    })
  }

  return {
    disconnect(): void {
      if (pingTimer) clearInterval(pingTimer)
      try { socket?.disconnect() } catch { /* 忽略 */ }
      socket = null
    }
  }
}
