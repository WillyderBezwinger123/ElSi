/**
 * The single authorization layer. Every REST route, WebSocket handler and AI tool asks here.
 *
 * Two flavours:
 * - async checks (`canAccessWorkspace`, `assertPageAccess`, ...) for single resources;
 * - SQL fragment builders (`sqlWorkspaceVisible`, `sqlChunkVisible`, ...) to put the same rule
 *   inside a query, so list/search endpoints filter in the database. Fragments take the
 *   placeholder that holds the user id (e.g. `'$1'`) and the column/alias to test, and return a
 *   boolean SQL expression.
 *
 * Membership is the rule: a workspace member sees every page and block in it; a conversation
 * member sees its messages. AI retrieval additionally requires `ai_visible` on the source.
 */
import type { Db } from '../db/db.js';
import { forbidden, notFound } from '../errors.js';

export type WorkspaceRole = 'owner' | 'member';

// ------------------------------------------------------------------ SQL fragments

/** `<wsColumn>` is a workspace the user (placeholder `userParam`) belongs to. */
export function sqlWorkspaceVisible(userParam: string, wsColumn: string): string {
  return `${wsColumn} IN (SELECT wm.workspace_id FROM workspace_members wm WHERE wm.user_id = ${userParam})`;
}

/** `<pageIdColumn>` is a page in one of the user's workspaces (tombstones included). */
export function sqlPageVisible(userParam: string, pageIdColumn: string): string {
  return `EXISTS (SELECT 1 FROM pages vp JOIN workspace_members vwm ON vwm.workspace_id = vp.workspace_id
    WHERE vp.id = ${pageIdColumn} AND vwm.user_id = ${userParam})`;
}

/** `<convColumn>` is a conversation the user is a member of. */
export function sqlConversationVisible(userParam: string, convColumn: string): string {
  return `${convColumn} IN (SELECT cm.conversation_id FROM conversation_members cm WHERE cm.user_id = ${userParam})`;
}

/**
 * Row filter for AI retrieval over `chunks` (aliased `alias`): the chunk and its live source must
 * be `ai_visible`, the source must not be deleted, and the user must be a member of the source's
 * workspace / conversation. Checked against the live source rows, not only the chunk copy.
 */
export function sqlChunkVisible(userParam: string, alias = 'c'): string {
  return `(${alias}.ai_visible AND (
    (${alias}.source_type = 'page' AND EXISTS (
      SELECT 1 FROM pages sp JOIN workspace_members swm ON swm.workspace_id = sp.workspace_id
      WHERE sp.id = ${alias}.source_id AND sp.ai_visible AND NOT sp.deleted AND swm.user_id = ${userParam}))
    OR
    (${alias}.source_type = 'conversation' AND EXISTS (
      SELECT 1 FROM conversations sc JOIN conversation_members scm ON scm.conversation_id = sc.id
      WHERE sc.id = ${alias}.source_id AND sc.ai_visible AND scm.user_id = ${userParam}))
  ))`;
}

// ------------------------------------------------------------------ workspaces

export async function visibleWorkspaceIds(db: Db, userId: string): Promise<string[]> {
  const { rows } = await db.query<{ workspace_id: string }>(
    'SELECT workspace_id FROM workspace_members WHERE user_id = $1',
    [userId],
  );
  return rows.map((r) => r.workspace_id);
}

export async function workspaceRole(
  db: Db,
  userId: string,
  workspaceId: string,
): Promise<WorkspaceRole | null> {
  const { rows } = await db.query<{ role: WorkspaceRole }>(
    'SELECT role FROM workspace_members WHERE workspace_id = $1 AND user_id = $2',
    [workspaceId, userId],
  );
  return rows[0]?.role ?? null;
}

export async function canAccessWorkspace(db: Db, userId: string, workspaceId: string): Promise<boolean> {
  return (await workspaceRole(db, userId, workspaceId)) !== null;
}

/** Throws 404 for non-members (no existence leak) and 403 if `role` is required but missing. */
export async function assertWorkspaceAccess(
  db: Db,
  userId: string,
  workspaceId: string,
  required: 'member' | 'owner' = 'member',
): Promise<WorkspaceRole> {
  const role = await workspaceRole(db, userId, workspaceId);
  if (!role) throw notFound('Workspace not found');
  if (required === 'owner' && role !== 'owner') throw forbidden('Only the workspace owner can do this');
  return role;
}

// ------------------------------------------------------------------ pages

export async function canAccessPage(db: Db, userId: string, pageId: string): Promise<boolean> {
  const { rows } = await db.query(
    `SELECT 1 FROM pages p JOIN workspace_members wm ON wm.workspace_id = p.workspace_id
     WHERE p.id = $1 AND wm.user_id = $2`,
    [pageId, userId],
  );
  return rows.length > 0;
}

export async function assertPageAccess(db: Db, userId: string, pageId: string): Promise<void> {
  if (!(await canAccessPage(db, userId, pageId))) throw notFound('Page not found');
}

// ------------------------------------------------------------------ conversations

export async function visibleConversationIds(db: Db, userId: string): Promise<string[]> {
  const { rows } = await db.query<{ conversation_id: string }>(
    'SELECT conversation_id FROM conversation_members WHERE user_id = $1',
    [userId],
  );
  return rows.map((r) => r.conversation_id);
}

export async function canAccessConversation(
  db: Db,
  userId: string,
  conversationId: string,
): Promise<boolean> {
  const { rows } = await db.query(
    'SELECT 1 FROM conversation_members WHERE conversation_id = $1 AND user_id = $2',
    [conversationId, userId],
  );
  return rows.length > 0;
}

export async function assertConversationAccess(
  db: Db,
  userId: string,
  conversationId: string,
): Promise<void> {
  if (!(await canAccessConversation(db, userId, conversationId))) {
    throw notFound('Conversation not found');
  }
}

// ------------------------------------------------------------------ files

/**
 * A file is readable by its uploader, by members of a conversation with a message that has it
 * attached, and by members of a workspace with a block whose content mentions its sha256.
 */
export async function canReadFile(
  db: Db,
  userId: string,
  file: { id: string; sha256: string; uploader_id: string | null },
): Promise<boolean> {
  if (file.uploader_id === userId) return true;
  const { rows } = await db.query(
    `SELECT 1 WHERE EXISTS (
       SELECT 1 FROM message_attachments ma
       JOIN messages m ON m.id = ma.message_id
       JOIN conversation_members cm ON cm.conversation_id = m.conversation_id
       WHERE ma.file_id = $1 AND cm.user_id = $2
     ) OR EXISTS (
       SELECT 1 FROM blocks b
       JOIN pages p ON p.id = b.page_id
       JOIN workspace_members wm ON wm.workspace_id = p.workspace_id
       WHERE wm.user_id = $2 AND NOT b.deleted AND strpos(b.content::text, $3) > 0
     )`,
    [file.id, userId, file.sha256],
  );
  return rows.length > 0;
}
