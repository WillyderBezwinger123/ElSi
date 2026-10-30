import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../audit/audit.js';
import type { Db } from '../db/db.js';
import { badRequest, parse } from '../errors.js';
import { UUID_RE, uuidv7 } from '../ids.js';
import { assertWorkspaceAccess, visibleWorkspaceIds } from '../policy/policy.js';
import { appendChange, currentSeq, touchWorkspaceContent } from '../sync/changelog.js';
import { loadWorkspace, loadWorkspaces, type Workspace } from './service.js';

const userId = z.string().regex(UUID_RE, 'invalid user id');
const name = z.string().trim().min(1).max(200);

const createBody = z.object({
  name,
  memberIds: z.array(userId).max(500).default([]),
});
const patchBody = z.object({
  name: name.optional(),
  addMemberIds: z.array(userId).max(500).optional(),
  removeMemberIds: z.array(userId).max(500).optional(),
});
const idParam = z.object({ id: z.string().regex(UUID_RE, 'invalid id') });

async function assertUsersExist(db: Db, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const { rows } = await db.query<{ id: string }>('SELECT id FROM users WHERE id = ANY($1::text[])', [ids]);
  if (rows.length !== ids.length) {
    const found = new Set(rows.map((r) => r.id));
    throw badRequest(`Unknown user id(s): ${ids.filter((i) => !found.has(i)).join(', ')}`);
  }
}

export async function workspaceRoutes(app: FastifyInstance): Promise<void> {
  const { db, events } = app.ctx;
  app.addHook('onRequest', app.authenticate);

  const hint = (userIds: Iterable<string>, seq: number, exceptSessionId: string) =>
    events.publish(userIds, { type: 'sync.hint', seq }, { exceptSessionId });

  app.get('/workspaces', async (req) => {
    const ids = await visibleWorkspaceIds(db, req.user.id);
    return [...(await loadWorkspaces(db, ids)).values()];
  });

  app.post('/workspaces', async (req) => {
    const body = parse(createBody, req.body);
    const memberIds = [...new Set(body.memberIds)].filter((id) => id !== req.user.id);
    const { ws, seq } = await db.tx(async (t) => {
      await assertUsersExist(t, memberIds);
      const id = uuidv7();
      await t.query(`INSERT INTO workspaces (id, name, kind) VALUES ($1, $2, 'shared')`, [id, body.name]);
      await t.query(`INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'owner')`, [
        id,
        req.user.id,
      ]);
      for (const m of memberIds) {
        await t.query(
          `INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'member')`,
          [id, m],
        );
      }
      const seq = await appendChange(t, 'workspace', id, id);
      await audit(t, {
        actorId: req.user.id,
        action: 'workspace.create',
        resourceType: 'workspace',
        resourceId: id,
        detail: { name: body.name, memberIds },
      });
      return { ws: (await loadWorkspace(t, id))!, seq };
    });
    hint([req.user.id, ...memberIds], seq, req.user.sessionId);
    return ws;
  });

  app.patch('/workspaces/:id', async (req) => {
    const { id } = parse(idParam, req.params);
    const body = parse(patchBody, req.body);

    const { ws, seq, notify } = await db.tx(async (t) => {
      await assertWorkspaceAccess(t, req.user.id, id, 'owner');
      const before = (await loadWorkspace(t, id))!;
      const current = new Set(before.members.map((m) => m.userId));
      const add = [...new Set(body.addMemberIds ?? [])].filter((u) => !current.has(u));
      const remove = [...new Set(body.removeMemberIds ?? [])].filter((u) => current.has(u));

      if ((add.length > 0 || remove.length > 0) && before.kind === 'private') {
        throw badRequest('Members of a private workspace cannot be changed');
      }
      const owners = new Set(before.members.filter((m) => m.role === 'owner').map((m) => m.userId));
      if (remove.some((u) => owners.has(u))) throw badRequest('The owner cannot be removed');
      await assertUsersExist(t, add);

      if (body.name !== undefined) {
        await t.query('UPDATE workspaces SET name = $2, updated_at = now() WHERE id = $1', [id, body.name]);
      }
      for (const u of add) {
        await t.query(`INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'member')`, [
          id,
          u,
        ]);
      }
      if (remove.length > 0) {
        await t.query('DELETE FROM workspace_members WHERE workspace_id = $1 AND user_id = ANY($2::text[])', [
          id,
          remove,
        ]);
      }

      await appendChange(t, 'workspace', id, id);
      // New members' pull cursors are past the existing content: announce it again.
      if (add.length > 0) await touchWorkspaceContent(t, id);
      // Removed members can no longer see workspace entries, so address a notice to each.
      for (const u of remove) await appendChange(t, 'workspace', id, id, u);

      await audit(t, {
        actorId: req.user.id,
        action: 'workspace.update',
        resourceType: 'workspace',
        resourceId: id,
        detail: { name: body.name, added: add, removed: remove },
      });
      const ws: Workspace = (await loadWorkspace(t, id))!;
      return { ws, seq: await currentSeq(t), notify: [...current, ...add] };
    });

    hint(notify, seq, req.user.sessionId);
    return ws;
  });
}
