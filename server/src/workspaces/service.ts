import type { Db } from '../db/db.js';
import { uuidv7 } from '../ids.js';
import type { WorkspaceRole } from '../policy/policy.js';
import { appendChange } from '../sync/changelog.js';

export interface Workspace {
  id: string;
  name: string;
  kind: 'private' | 'shared';
  members: { userId: string; role: WorkspaceRole }[];
}

/** Loads workspaces with their members, keyed by id. No access check: callers filter first. */
export async function loadWorkspaces(db: Db, ids: string[]): Promise<Map<string, Workspace>> {
  const out = new Map<string, Workspace>();
  if (ids.length === 0) return out;
  const { rows } = await db.query<{ id: string; name: string; kind: Workspace['kind'] }>(
    'SELECT id, name, kind FROM workspaces WHERE id = ANY($1::text[]) ORDER BY created_at, id',
    [ids],
  );
  for (const r of rows) out.set(r.id, { id: r.id, name: r.name, kind: r.kind, members: [] });
  const members = await db.query<{ workspace_id: string; user_id: string; role: WorkspaceRole }>(
    `SELECT workspace_id, user_id, role FROM workspace_members
     WHERE workspace_id = ANY($1::text[]) ORDER BY joined_at, user_id`,
    [ids],
  );
  for (const m of members.rows) out.get(m.workspace_id)?.members.push({ userId: m.user_id, role: m.role });
  return out;
}

export async function loadWorkspace(db: Db, id: string): Promise<Workspace | undefined> {
  return (await loadWorkspaces(db, [id])).get(id);
}

export async function workspaceMemberIds(db: Db, workspaceIds: string[]): Promise<string[]> {
  if (workspaceIds.length === 0) return [];
  const { rows } = await db.query<{ user_id: string }>(
    'SELECT DISTINCT user_id FROM workspace_members WHERE workspace_id = ANY($1::text[])',
    [workspaceIds],
  );
  return rows.map((r) => r.user_id);
}

/** Creates the user's private workspace. Call inside `db.tx`. */
export async function createPrivateWorkspace(db: Db, userId: string): Promise<string> {
  const id = uuidv7();
  await db.query(`INSERT INTO workspaces (id, name, kind) VALUES ($1, 'Private', 'private')`, [id]);
  await db.query(`INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'owner')`, [
    id,
    userId,
  ]);
  await appendChange(db, 'workspace', id, id);
  return id;
}
