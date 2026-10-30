import type { FastifyInstance } from 'fastify';
import type { RawData } from 'ws';
import { authenticateToken } from '../auth/tokens.js';
import type { AuthUser } from '../context.js';
import { type ClientMessage, type EventBus, SocketConn } from './events.js';

/** Close code for a missing/invalid/expired token or a revoked session. */
export const WS_UNAUTHORIZED = 4401;
/** Sockets silent for this long are dropped (clients ping every 25 s). */
const IDLE_TIMEOUT_MS = 75_000;

/**
 * `GET /api/v1/ws?token=<accessToken>`. Authenticates before the upgrade completes, then routes
 * client frames: `ping` is answered here, other types go to handlers registered via
 * `ctx.events.onClientMessage(type, handler)`.
 */
export function wsGateway(bus: EventBus) {
  return async function wsRoutes(app: FastifyInstance): Promise<void> {
    const { db, config } = app.ctx;
    const pending = new WeakMap<object, AuthUser | null>();

    const sweep = setInterval(() => {
      const cutoff = Date.now() - IDLE_TIMEOUT_MS;
      for (const conn of bus.connections()) if (conn.lastActivity < cutoff) conn.socket.terminate();
    }, 30_000);
    sweep.unref();
    app.addHook('onClose', async () => clearInterval(sweep));

    app.get(
      '/ws',
      {
        websocket: true,
        preHandler: async (req) => {
          const token = (req.query as Record<string, unknown>).token;
          pending.set(req, typeof token === 'string' ? await authenticateToken(db, config.jwtSecret, token) : null);
        },
      },
      (socket, req) => {
        const user = pending.get(req) ?? null;
        if (!user) {
          socket.close(WS_UNAUTHORIZED, 'unauthorized');
          return;
        }
        const conn = new SocketConn(user.id, user.sessionId, socket);
        bus.add(conn);

        socket.on('message', (raw: RawData, isBinary: boolean) => {
          conn.lastActivity = Date.now();
          let msg: ClientMessage;
          try {
            if (isBinary) throw new Error('binary');
            const parsed: unknown = JSON.parse(raw.toString());
            if (!parsed || typeof parsed !== 'object' || typeof (parsed as ClientMessage).type !== 'string') {
              throw new Error('no type');
            }
            msg = parsed as ClientMessage;
          } catch {
            conn.send({ type: 'error', error: 'bad_request', message: 'Frames must be JSON objects with a type' });
            return;
          }

          if (msg.type === 'ping') {
            conn.send({ type: 'pong' });
            return;
          }
          const handler = bus.handlerFor(msg.type);
          if (!handler) {
            conn.send({ type: 'error', error: 'bad_request', message: `Unknown frame type ${msg.type}` });
            return;
          }
          Promise.resolve()
            .then(() => handler(conn, msg))
            .catch((err: unknown) => {
              req.log.error({ err, type: msg.type }, 'websocket handler failed');
              conn.send({ type: 'error', error: 'internal', message: 'Handler failed' });
            });
        });

        socket.on('close', () => bus.remove(conn));
        socket.on('error', () => bus.remove(conn));
      },
    );
  };
}
