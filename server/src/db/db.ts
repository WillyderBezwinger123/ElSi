/**
 * Minimal database interface shared by the `pg` (production) and PGlite (tests, zero-setup dev)
 * implementations.
 *
 * Conventions every module should follow so both backends behave the same:
 * - Use `$1, $2, ...` placeholders. Pass jsonb values as `JSON.stringify(x)` (pg would turn JS
 *   arrays into Postgres arrays). JS string arrays map to `text[]`.
 * - `bigint`/`bigserial` columns come back as JS numbers, timestamptz as `Date`, jsonb as objects.
 * - Inside `db.tx(fn)` use ONLY the handle passed to `fn`. Using the outer handle inside a
 *   transaction deadlocks on PGlite (single connection) and escapes the transaction on pg.
 */
export interface Db {
  readonly kind: 'pg' | 'pglite';
  query<T = Record<string, any>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
  /** Runs a multi-statement SQL script without parameters (used by migrations). */
  exec(sql: string): Promise<void>;
  /** Runs `fn` in a transaction. Nested calls reuse the outer transaction. */
  tx<T>(fn: (db: Db) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/** Convenience: first row or undefined. */
export async function one<T = Record<string, any>>(
  db: Db,
  sql: string,
  params?: unknown[],
): Promise<T | undefined> {
  const { rows } = await db.query<T>(sql, params);
  return rows[0];
}
