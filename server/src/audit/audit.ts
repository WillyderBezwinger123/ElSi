import type { Db } from '../db/db.js';

export type AuditVia = 'human' | 'ai';

export interface AuditEntry {
  actorId: string | null;
  /** Dotted verb, e.g. `auth.login`, `workspace.update`, `file.upload`, `ai.retrieve`. */
  action: string;
  resourceType: string;
  resourceId?: string | null;
  via?: AuditVia;
  detail?: Record<string, unknown>;
}

/** Appends one row to `audit_log`. Pass the transaction handle when called inside `db.tx`. */
export async function audit(db: Db, e: AuditEntry): Promise<void> {
  await db.query(
    `INSERT INTO audit_log (actor_id, action, resource_type, resource_id, via, detail)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
    [
      e.actorId,
      e.action,
      e.resourceType,
      e.resourceId ?? null,
      e.via ?? 'human',
      JSON.stringify(e.detail ?? {}),
    ],
  );
}
