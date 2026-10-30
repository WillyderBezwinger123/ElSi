import type { FastifyInstance } from 'fastify';
import { parse } from '../errors.js';
import { workspaceMemberIds } from '../workspaces/service.js';
import { pullQuery, pushBody } from './model.js';
import { pull } from './pull.js';
import { applyPush } from './push.js';

export async function syncRoutes(app: FastifyInstance): Promise<void> {
  const { db, events } = app.ctx;
  app.addHook('onRequest', app.authenticate);

  app.post('/sync/push', { bodyLimit: 10 * 1024 * 1024 }, async (req) => {
    const body = parse(pushBody, req.body);
    const outcome = await applyPush(db, req.user.id, body.ops);

    if (outcome.touchedWorkspaces.size > 0) {
      const members = await workspaceMemberIds(db, [...outcome.touchedWorkspaces]);
      events.publish(members, { type: 'sync.hint', seq: outcome.serverSeq }, { exceptSessionId: req.user.sessionId });
    }
    return { results: outcome.results, serverSeq: outcome.serverSeq };
  });

  app.get('/sync/pull', async (req) => {
    const q = parse(pullQuery, req.query);
    return pull(db, req.user.id, q.since, q.limit);
  });
}
