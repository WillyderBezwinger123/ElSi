import type { WebSocket } from 'ws';

/** Server-to-client frame. `type` is the event name from docs/api.md (e.g. `sync.hint`). */
export interface ServerEvent {
  type: string;
  [key: string]: unknown;
}

/** Client-to-server frame, already JSON-parsed. */
export interface ClientMessage {
  type: string;
  [key: string]: unknown;
}

/** One authenticated WebSocket connection. */
export interface ClientConn {
  readonly userId: string;
  readonly sessionId: string;
  send(event: ServerEvent): void;
  close(code?: number, reason?: string): void;
}

export type ClientMessageHandler = (conn: ClientConn, msg: ClientMessage) => void | Promise<void>;

export interface PublishOptions {
  /** Skip sockets of this device session (usually the one that caused the event). */
  exceptSessionId?: string;
}

/** `ctx.events`: fan-out to connected clients plus client message routing. */
export interface Events {
  publish(userIds: Iterable<string>, event: ServerEvent, opts?: PublishOptions): void;
  isOnline(userId: string): boolean;
  /** Registers the handler for a client frame type (one handler per type). */
  onClientMessage(type: string, handler: ClientMessageHandler): void;
  /** Closes all sockets of a device session (e.g. after it was revoked). */
  closeSession(sessionId: string, code?: number, reason?: string): void;
}

export class SocketConn implements ClientConn {
  lastActivity = Date.now();
  constructor(
    readonly userId: string,
    readonly sessionId: string,
    readonly socket: WebSocket,
  ) {}

  send(event: ServerEvent): void {
    if (this.socket.readyState === this.socket.OPEN) this.socket.send(JSON.stringify(event));
  }

  close(code = 1000, reason = ''): void {
    this.socket.close(code, reason);
  }
}

/** In-process registry of sockets by user. Single-instance server, so no external broker. */
export class EventBus implements Events {
  private readonly byUser = new Map<string, Set<SocketConn>>();
  private readonly handlers = new Map<string, ClientMessageHandler>();

  add(conn: SocketConn): void {
    let set = this.byUser.get(conn.userId);
    if (!set) this.byUser.set(conn.userId, (set = new Set()));
    set.add(conn);
  }

  remove(conn: SocketConn): void {
    const set = this.byUser.get(conn.userId);
    if (!set) return;
    set.delete(conn);
    if (set.size === 0) this.byUser.delete(conn.userId);
  }

  connections(): SocketConn[] {
    return [...this.byUser.values()].flatMap((s) => [...s]);
  }

  publish(userIds: Iterable<string>, event: ServerEvent, opts: PublishOptions = {}): void {
    const payload = JSON.stringify(event);
    for (const userId of new Set(userIds)) {
      for (const conn of this.byUser.get(userId) ?? []) {
        if (conn.sessionId === opts.exceptSessionId) continue;
        if (conn.socket.readyState === conn.socket.OPEN) conn.socket.send(payload);
      }
    }
  }

  isOnline(userId: string): boolean {
    return (this.byUser.get(userId)?.size ?? 0) > 0;
  }

  onClientMessage(type: string, handler: ClientMessageHandler): void {
    if (type === 'ping') throw new Error('ping is handled by the gateway');
    if (this.handlers.has(type)) throw new Error(`handler for "${type}" already registered`);
    this.handlers.set(type, handler);
  }

  handlerFor(type: string): ClientMessageHandler | undefined {
    return this.handlers.get(type);
  }

  closeSession(sessionId: string, code = 4401, reason = 'session revoked'): void {
    for (const conn of this.connections()) {
      if (conn.sessionId === sessionId) conn.close(code, reason);
    }
  }
}
