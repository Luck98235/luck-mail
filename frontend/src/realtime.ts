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

export function createRealtime(onEvent: (msg: RealtimeEvent) => void): { readonly connected: boolean; disconnect: () => void } {
  let socket: Socket | null = null
  let pingTimer: ReturnType<typeof setInterval> | null = null

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
  })
  socket.on('disconnect', () => {
    if (pingTimer) { clearInterval(pingTimer); pingTimer = null }
  })

  // 服务端按事件名分发；同时兼容统一 'message' 事件带 {type} 的发法
  for (const t of EVENT_TYPES) {
    socket.on(t, (payload: unknown) => {
      const p = (payload ?? {}) as Record<string, unknown>
      onEvent({ type: t, ...p } as RealtimeEvent)
    })
  }
  socket.on('message', (payload: unknown) => {
    const msg = (typeof payload === 'string' ? safeJson(payload) : payload) as RealtimeEvent | null
    if (msg && msg.type) onEvent(msg)
  })

  function safeJson(s: string): unknown {
    try { return JSON.parse(s) as unknown } catch { return null }
  }

  return {
    get connected(): boolean { return !!socket?.connected },
    disconnect(): void {
      if (pingTimer) clearInterval(pingTimer)
      try { socket?.disconnect() } catch { /* 忽略 */ }
      socket = null
    }
  }
}
