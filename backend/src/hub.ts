// Socket.io broadcast hub (contract: events by name, payload directly —
// NO {type:...} wrapper). Events: new-mail, mail-updated, mail-deleted,
// sync, account. Server.ts attaches the io instance after auth setup.
import type { Server as SocketIOServer } from 'socket.io';

let io: SocketIOServer | null = null;

export function attachIo(serverIo: SocketIOServer): void {
  io = serverIo;
}

export function emit(event: string, payload: Record<string, unknown>): void {
  if (!io) return;
  io.emit(event, payload || {});
}
