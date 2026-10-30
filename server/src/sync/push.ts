import type { Db } from '../db/db.js';
import { badRequest, forbidden } from '../errors.js';
import { uuidFromKey } from '../ids.js';
import { canAccessWorkspace } from '../policy/policy.js';
import { appendChange, currentSeq, touchPageBlocks } from './changelog.js';
import { canonicalJson, clampHlc, hlcDevice } from './hlc.js';
import type { BlockData, BlockRow, PageData, PageRow, SyncOp } from './model.js';

export interface OpResult {
  id: string;
  status: 'applied' | 'stale' | 'conflict';
  conflictCopyId?: string;
}

export interface PushOutcome {
  results: OpResult[];
  serverSeq: number;
  /** Workspaces whose content changed (old and new side of moves). */
  touchedWorkspaces: Set<string>;
}

/**
 * Applies a push atomically. Policy is checked per op; any violation throws 403 and rolls back
 * the whole push. LWW by `hlc` (plain string comparison) after clamping it to now + 60 s.
 */
export async function applyPush(db: Db, userId: string, ops: SyncOp[], now = Date.now()): Promise<PushOutcome> {
  return db.tx(async (t) => {
    const touched = new Set<string>();
    const access = new Map<string, boolean>();
    const assertMember = async (workspaceId: string) => {
      let ok = access.get(workspaceId);
      if (ok === undefined) access.set(workspaceId, (ok = await canAccessWorkspace(t, userId, workspaceId)));
      if (!ok) throw forbidden(`No access to workspace ${workspaceId}`);
    };

    const results: OpResult[] = [];
    for (const op of ops) {
      if (op.id !== op.data.id) throw badRequest(`Op id ${op.id} does not match data.id`);
      results.push(
        op.entity === 'page'
          ? await applyPage(t, op.data, now, assertMember, touched)
          : await applyBlock(t, op.data, op.baseHlc, now, assertMember, touched),
      );
    }
    return { results, serverSeq: await currentSeq(t), touchedWorkspaces: touched };
  });
}

type AssertMember = (workspaceId: string) => Promise<void>;

/** Locks and returns the row; inserts it first if missing. Returns null when we inserted. */
async function lockOrInsert<R>(db: Db, select: string, id: string, insert: () => Promise<boolean>): Promise<R | null> {
  const existing = (await db.query<R>(select, [id])).rows[0];
  if (existing) return existing;
  if (await insert()) return null;
  // Lost an insert race with a concurrent push: compare against the winner.
  return (await db.query<R>(select, [id])).rows[0]!;
}

async function applyPage(
  t: Db,
  d: PageData,
  now: number,
  assertMember: AssertMember,
  touched: Set<string>,
): Promise<OpResult> {
  const hlc = clampHlc(d.hlc, now);
  await assertMember(d.workspaceId);

  const existing = await lockOrInsert<PageRow>(
    t,
    'SELECT * FROM pages WHERE id = $1 FOR UPDATE',
    d.id,
    async () => {
      const { rows } = await t.query(
        `INSERT INTO pages (id, workspace_id, parent_id, title, icon, position, tags, ai_visible, hlc, deleted)
         VALUES ($1, $2, $3, $4, $5, $6, $7::text[], $8, $9, $10)
         ON CONFLICT (id) DO NOTHING RETURNING id`,
        [d.id, d.workspaceId, d.parentId, d.title, d.icon, d.position, d.tags, d.aiVisible, hlc, d.deleted],
      );
      return rows.length > 0;
    },
  );

  if (!existing) {
    await appendChange(t, 'page', d.id, d.workspaceId);
    touched.add(d.workspaceId);
    return { id: d.id, status: 'applied' };
  }

  // Moving a page between workspaces requires membership in both.
  if (existing.workspace_id !== d.workspaceId) await assertMember(existing.workspace_id);

  // Pages are plain LWW: no conflict copies.
  if (hlc <= existing.hlc) return { id: d.id, status: 'stale' };

  await t.query(
    `UPDATE pages SET workspace_id = $2, parent_id = $3, title = $4, icon = $5, position = $6,
       tags = $7::text[], ai_visible = $8, hlc = $9, deleted = $10, updated_at = now()
     WHERE id = $1`,
    [d.id, d.workspaceId, d.parentId, d.title, d.icon, d.position, d.tags, d.aiVisible, hlc, d.deleted],
  );
  await appendChange(t, 'page', d.id, d.workspaceId);
  touched.add(d.workspaceId);
  if (existing.workspace_id !== d.workspaceId) {
    // Old-workspace members learn the page left; both sides re-sync its blocks.
    await appendChange(t, 'page', d.id, existing.workspace_id);
    await touchPageBlocks(t, d.id, [existing.workspace_id, d.workspaceId]);
    touched.add(existing.workspace_id);
  }
  return { id: d.id, status: 'applied' };
}

async function insertBlockCopy(
  t: Db,
  copyId: string,
  b: { pageId: string; parentId: string | null; position: string; type: string; content: unknown; hlc: string },
  originalId: string,
  workspaceId: string,
): Promise<void> {
  const { rows } = await t.query(
    `INSERT INTO blocks (id, page_id, parent_id, position, type, content, hlc, deleted, conflict_of)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, false, $8)
     ON CONFLICT (id) DO NOTHING RETURNING id`,
    [copyId, b.pageId, b.parentId, b.position, b.type, JSON.stringify(b.content), b.hlc, originalId],
  );
  if (rows.length > 0) await appendChange(t, 'block', copyId, workspaceId);
}

async function applyBlock(
  t: Db,
  d: BlockData,
  baseHlc: string | null,
  now: number,
  assertMember: AssertMember,
  touched: Set<string>,
): Promise<OpResult> {
  const hlc = clampHlc(d.hlc, now);

  const page = (await t.query<{ workspace_id: string }>('SELECT workspace_id FROM pages WHERE id = $1', [d.pageId]))
    .rows[0];
  if (!page) throw forbidden(`Page ${d.pageId} is not accessible (push the page before its blocks)`);
  await assertMember(page.workspace_id);
  const ws = page.workspace_id;

  const existing = await lockOrInsert<BlockRow & { workspace_id: string }>(
    t,
    `SELECT b.*, p.workspace_id FROM blocks b JOIN pages p ON p.id = b.page_id WHERE b.id = $1 FOR UPDATE OF b`,
    d.id,
    async () => {
      const { rows } = await t.query(
        `INSERT INTO blocks (id, page_id, parent_id, position, type, content, hlc, deleted, conflict_of)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9)
         ON CONFLICT (id) DO NOTHING RETURNING id`,
        [d.id, d.pageId, d.parentId, d.position, d.type, JSON.stringify(d.content), hlc, d.deleted, d.conflictOf],
      );
      return rows.length > 0;
    },
  );

  if (!existing) {
    await appendChange(t, 'block', d.id, ws);
    touched.add(ws);
    return { id: d.id, status: 'applied' };
  }

  if (existing.workspace_id !== ws) await assertMember(existing.workspace_id);

  // A concurrent edit: the client did not see the stored version, it came from another device,
  // and the content really differs. Deletions never produce copies.
  const concurrent =
    baseHlc !== existing.hlc &&
    hlcDevice(existing.hlc) !== hlcDevice(d.hlc) &&
    !existing.deleted &&
    !d.deleted &&
    canonicalJson(existing.content) !== canonicalJson(d.content);

  if (hlc > existing.hlc) {
    let conflictCopyId: string | undefined;
    if (concurrent) {
      // Incoming wins; keep the overwritten version as a sibling copy.
      conflictCopyId = uuidFromKey(`conflict:${existing.id}:${existing.hlc}`);
      await insertBlockCopy(
        t,
        conflictCopyId,
        {
          pageId: existing.page_id,
          parentId: existing.parent_id,
          position: existing.position,
          type: existing.type,
          content: existing.content,
          hlc: existing.hlc,
        },
        existing.id,
        existing.workspace_id,
      );
    }
    await t.query(
      `UPDATE blocks SET page_id = $2, parent_id = $3, position = $4, type = $5, content = $6::jsonb,
         hlc = $7, deleted = $8, conflict_of = $9, updated_at = now()
       WHERE id = $1`,
      [d.id, d.pageId, d.parentId, d.position, d.type, JSON.stringify(d.content), hlc, d.deleted, d.conflictOf],
    );
    await appendChange(t, 'block', d.id, ws);
    touched.add(ws);
    if (existing.workspace_id !== ws) {
      await appendChange(t, 'block', d.id, existing.workspace_id);
      touched.add(existing.workspace_id);
    }
    return conflictCopyId ? { id: d.id, status: 'applied', conflictCopyId } : { id: d.id, status: 'applied' };
  }

  if (concurrent) {
    // Incoming loses; keep it as a sibling copy. The id is derived from the op, so retries
    // of the same op map to the same copy.
    const conflictCopyId = uuidFromKey(`conflict:${d.id}:${d.hlc}`);
    await insertBlockCopy(t, conflictCopyId, { ...d, hlc }, d.id, ws);
    touched.add(ws);
    return { id: d.id, status: 'conflict', conflictCopyId };
  }
  return { id: d.id, status: 'stale' };
}
