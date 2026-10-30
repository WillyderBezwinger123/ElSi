import rateLimit from '@fastify/rate-limit';
import websocket from '@fastify/websocket';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { authenticateToken } from './auth/tokens.js';
import type { Config } from './config.js';
import type { AppContext } from './context.js';
import type { Db } from './db/db.js';
import { installErrorHandlers, unauthorized } from './errors.js';
import { modules as defaultModules, type ElsiModule } from './modules.js';
import { EventBus } from './ws/events.js';
import { wsGateway } from './ws/gateway.js';

export interface BuildAppOptions {
  db: Db;
  config: Config;
  /** Override the module list (tests). Defaults to `src/modules.ts`. */
  modules?: ElsiModule[];
}

/** Hides `?token=` (WebSocket auth) from request logs. */
function redactUrl(url: string): string {
  return url.replace(/([?&]token=)[^&]*/g, '$1[redacted]');
}

/**
 * Builds the Fastify app around an already-migrated database. The caller owns `db` (closes it).
 * Decorates `app.ctx = {db, config, events}` and `app.authenticate`; registers the WebSocket
 * gateway and every module from `src/modules.ts` under `/api/v1`.
 */
export function buildApp({ db, config, modules = defaultModules }: BuildAppOptions): FastifyInstance {
  const app = Fastify({
    logger: {
      level: config.logLevel,
      serializers: {
        req: (req: FastifyRequest) => ({ method: req.method, url: redactUrl(req.url), remoteAddress: req.ip }),
      },
    },
    // Fastify accepts a hop count at runtime even though its types omit numbers.
    trustProxy: config.trustProxy as boolean | string,
  });

  const events = new EventBus();
  const ctx: AppContext = { db, config, events };
  app.decorate('ctx', ctx);
  app.decorateRequest('user', null as never);

  app.decorate('authenticate', async (req: FastifyRequest, _reply: FastifyReply) => {
    const header = req.headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice(7).trim() : undefined;
    if (!token) throw unauthorized('Missing bearer token');
    const user = await authenticateToken(db, config.jwtSecret, token);
    if (!user) throw unauthorized('Invalid or expired token');
    req.user = user;
  });

  installErrorHandlers(app);

  app.register(rateLimit, {
    global: false,
    errorResponseBuilder: (_req, context) => ({
      statusCode: context.statusCode,
      error: 'rate_limited',
      message: `Too many requests, retry in ${context.after}`,
    }),
  });
  app.register(websocket, { options: { maxPayload: 64 * 1024 } });

  app.get('/health', async () => ({ status: 'ok' }));

  app.register(
    async (api) => {
      await api.register(wsGateway(events));
      for (const m of modules) await api.register(m.plugin);
    },
    { prefix: '/api/v1' },
  );

  return app;
}
