import type { Db } from '../db/db.js';
import { sqlWorkspaceVisible, visibleWorkspaceIds } from '../policy/policy.js';
import { loadWorkspaces, type Workspace } from '../workspaces/service.js';
import type { ChangeEntity } from './changelog.js';
import { blockToApi, pageToApi, type BlockData, type BlockRow, type PageData, type PageRow } from './model.js';

/** A workspace the user lost access to arrives with `deleted: true`. */
export type WorkspaceChange = Workspace & { deleted?: true };

export type Change =
  | { seq: number; entity: 'page'; data: PageData }
  | { seq: number; entity: 'block'; data: BlockData }
  | { seq: number; entity: 'workspace'; data: WorkspaceChange };

export interface PullResult {
  changes: Change[];
  nextSeq: number;
  hasMore: boolean;
}

interface LogRow {
  seq: number;
  entity: ChangeEntity;
  entity_id: string;
  workspace_id: string;
}

const ENTITY_ORDER: Record<ChangeEntity, number> = { workspace: 0, page: 1, block: 2 };

/**
 * Returns the current state of every row changed after `since` in the user's workspaces.
 * Each entity appears once per response (at its first seq); within a response workspaces come
 * before pages and pages before blocks. Rows that moved out of the user's workspaces are sent as
 * tombstones (`deleted: true`) so clients drop them.
 */
export async function pull(db: Db, userId: string, since: number, limit: number): Promise<PullResult> {
  // Upper bound first: everything <= maxSeq is committed (writers hold a lock while allocating),
  // so the cursor can safely fast-forward to it when nothing more is visible.
  const maxSeq =
    (await db.query<{ seq: number | null }>('SELECT max(seq) AS seq FROM change_log')).rows[0]?.seq ?? 0;

  const { rows: log } = await db.query<LogRow>(
    `SELECT seq, entity, entity_id, workspace_id FROM change_log
     WHERE seq > $2 AND seq <= $3
       AND ((user_id IS NULL AND ${sqlWorkspaceVisible('$1', 'workspace_id')}) OR user_id = $1)
     ORDER BY seq LIMIT $4`,
    [userId, since, maxSeq, limit + 1],
  );
  const hasMore = log.length > limit;
  const batch = hasMore ? log.slice(0, limit) : log;
  const nextSeq = hasMore ? batch[batch.length - 1]!.seq : Math.max(maxSeq, 0);

  // First occurrence of each entity wins its position; data is the current row anyway.
  const seen = new Set<string>();
  const entries = batch.filter((e) => {
    const k = `${e.entity}:${e.entity_id}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  const visible = new Set(await visibleWorkspaceIds(db, userId));
  const idsOf = (entity: ChangeEntity) => entries.filter((e) => e.entity === entity).map((e) => e.entity_id);

  const pages = new Map<string, PageRow>();
  const pageIds = idsOf('page');
  if (pageIds.length > 0) {
    const { rows } = await db.query<PageRow>('SELECT * FROM pages WHERE id = ANY($1::text[])', [pageIds]);
    for (const r of rows) pages.set(r.id, r);
  }
  const blocks = new Map<string, BlockRow & { workspace_id: string }>();
  const blockIds = idsOf('block');
  if (blockIds.length > 0) {
    const { rows } = await db.query<BlockRow & { workspace_id: string }>(
      `SELECT b.*, p.workspace_id FROM blocks b JOIN pages p ON p.id = b.page_id WHERE b.id = ANY($1::text[])`,
      [blockIds],
    );
    for (const r of rows) blocks.set(r.id, r);
  }
  const workspaces = await loadWorkspaces(db, idsOf('workspace'));

  const changes: Change[] = [];
  for (const e of entries) {
    if (e.entity === 'page') {
      const row = pages.get(e.entity_id);
      if (!row) continue;
      const data = visible.has(row.workspace_id)
        ? pageToApi(row)
        : { ...pageToApi(row), workspaceId: e.workspace_id, title: '', icon: null, tags: [], deleted: true };
      changes.push({ seq: e.seq, entity: 'page', data });
    } else if (e.entity === 'block') {
      const row = blocks.get(e.entity_id);
      if (!row) continue;
      const data = visible.has(row.workspace_id) ? blockToApi(row) : { ...blockToApi(row), content: {}, deleted: true };
      changes.push({ seq: e.seq, entity: 'block', data });
    } else {
      const ws = workspaces.get(e.entity_id);
      if (!ws) continue;
      const data: WorkspaceChange = visible.has(ws.id) ? ws : { ...ws, members: [], deleted: true };
      changes.push({ seq: e.seq, entity: 'workspace', data });
    }
  }
  changes.sort((a, b) => ENTITY_ORDER[a.entity] - ENTITY_ORDER[b.entity] || a.seq - b.seq);

  return { changes, nextSeq, hasMore };
}
