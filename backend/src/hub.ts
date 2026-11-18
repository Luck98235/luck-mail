// Socket.io broadcast hub (contract: events by name, payload directly —
// NO {type:...} wrapper). Events: new-mail, mail-updated, mail-deleted,
// sync, account. Server.ts attaches the io instance after auth setup.
import type { Server as SocketIOServer, Socket } from 'socket.io';

// Audit #10 L-12：按用户跟踪 socket——登录吊销旧会话 / 改密码轮换后，
// 已建立的 Socket.io 连接原来不断开，被踢下线的设备仍能收到新邮件
// 事件（主题/发件人），直到下次握手才被挡。吊销时一并断开该用户全部
// socket（本机其他标签页重连时会拿新会话握手，不受影响）。
const userSockets = new Map<number, Set<Socket>>();

let io: SocketIOServer | null = null;

export function attachIo(serverIo: SocketIOServer): void {
  io = serverIo;
}

export function trackSocket(socket: Socket): void {
  const userId = (socket.data as { user?: { id?: number } }).user?.id;
  if (typeof userId !== 'number') return;
  let set = userSockets.get(userId);
  if (!set) {
    set = new Set<Socket>();
    userSockets.set(userId, set);
  }
  set.add(socket);
  socket.on('disconnect', () => {
    set.delete(socket);
    if (!set.size) userSockets.delete(userId);
  });
}

export function disconnectUserSockets(userId: number): void {
  const set = userSockets.get(userId);
  if (!set) return;
  for (const socket of [...set]) {
    try { socket.disconnect(true); } catch { /* ignore */ }
  }
}

export function emit(event: string, payload: Record<string, unknown>): void {
  if (!io) return;
  io.emit(event, payload || {});
}
