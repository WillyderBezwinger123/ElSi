import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Config } from './config.js';
import type { Db } from './db/db.js';
import type { Events } from './ws/events.js';

/** Shared services, available in every plugin as `app.ctx`. */
export interface AppContext {
  db: Db;
  config: Config;
  events: Events;
}

/** Set by the `authenticate` preHandler. */
export interface AuthUser {
  id: string;
  sessionId: string;
}

declare module 'fastify' {
  interface FastifyInstance {
    ctx: AppContext;
    /**
     * Hook that verifies the bearer token and its device session, then sets `req.user`.
     * Use as `onRequest` (runs before body parsing) or `preHandler`.
     */
    authenticate: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
  interface FastifyRequest {
    /** Only set on routes that use `app.authenticate`. */
    user: AuthUser;
  }
}
