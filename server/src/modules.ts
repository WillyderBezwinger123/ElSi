import type { FastifyPluginAsync } from 'fastify';
import { authRoutes } from './auth/routes.js';
import { fileRoutes } from './files/routes.js';
import { syncRoutes } from './sync/routes.js';
import { workspaceRoutes } from './workspaces/routes.js';

export interface ElsiModule {
  name: string;
  /** Registered under the `/api/v1` prefix, in its own encapsulation context. */
  plugin: FastifyPluginAsync;
}

/**
 * Feature modules, registered in this order. To add a module, append one line.
 * Inside a plugin use `app.ctx` ({db, config, events}), `app.authenticate` as a hook
 * (`app.addHook('onRequest', app.authenticate)`), and `src/policy/policy.ts` for every access check.
 * Put migrations in `src/db/migrations/` within your number range (chat 100-199, AI 200-299).
 */
export const modules: ElsiModule[] = [
  { name: 'auth', plugin: authRoutes },
  { name: 'workspaces', plugin: workspaceRoutes },
  { name: 'sync', plugin: syncRoutes },
  { name: 'files', plugin: fileRoutes },
];
