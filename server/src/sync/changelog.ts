import type { Db } from '../db/db.js';

export type ChangeEntity = 'page' | 'block' | 'workspace';

// Advisory lock key that serializes change_log writers, so seq order equals commit order and a
// reader can never skip a seq that commits later.
const CHANGE_LOG_LOCK = 7_123_002;

async function lock(db: Db): Promise<void> {
  await db.query('SELECT pg_advisory_xact_lock($1)', [CHANGE_LOG_LOCK]);
}

/**
 * Appends a change and returns its seq. MUST be called inside `db.tx`.
 * `userId` addresses the entry to a single user (e.g. a removal notice); otherwise it is seen by
 * every member of `workspaceId`.
 */
export async function appendChange(
  db: Db,
  entity: ChangeEntity,
  entityId: string,
  workspaceId: string,
  userId: string | null = null,
): Promise<number> {
  await lock(db);
  const { rows } = await db.query<{ seq: number }>(
    `INSERT INTO change_log (entity, entity_id, workspace_id, user_id) VALUES ($1, $2, $3, $4) RETURNING seq`,
    [entity, entityId, workspaceId, userId],
  );
  return rows[0]!.seq;
}

/** Re-announces every block of a page under the given workspaces (after a page moved). */
export async function touchPageBlocks(db: Db, pageId: string, workspaceIds: string[]): Promise<void> {
  await lock(db);
  for (const ws of workspaceIds) {
    await db.query(
      `INSERT INTO change_log (entity, entity_id, workspace_id)
       SELECT 'block', id, $2 FROM blocks WHERE page_id = $1 ORDER BY id`,
      [pageId, ws],
    );
  }
}

/** Re-announces every page and block of a workspace (after members were added). */
export async function touchWorkspaceContent(db: Db, workspaceId: string): Promise<void> {
  await lock(db);
  await db.query(
    `INSERT INTO change_log (entity, entity_id, workspace_id)
     SELECT 'page', id, workspace_id FROM pages WHERE workspace_id = $1 ORDER BY id`,
    [workspaceId],
  );
  await db.query(
    `INSERT INTO change_log (entity, entity_id, workspace_id)
     SELECT 'block', b.id, p.workspace_id FROM blocks b JOIN pages p ON p.id = b.page_id
     WHERE p.workspace_id = $1 ORDER BY b.id`,
    [workspaceId],
  );
}

export async function currentSeq(db: Db): Promise<number> {
  const { rows } = await db.query<{ seq: number | null }>('SELECT max(seq) AS seq FROM change_log');
  return rows[0]?.seq ?? 0;
}
