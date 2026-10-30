import type { Db } from './db.js';
import { PgDb } from './pg.js';
import { PgliteDb } from './pglite.js';

export type { Db } from './db.js';
export { one } from './db.js';
export { migrate } from './migrate.js';

/**
 * Opens a database from a URL:
 * - `postgres://...` / `postgresql://...`: connection pool (production).
 * - `pglite://memory`: in-memory PGlite (tests, throwaway dev).
 * - `pglite:///abs/path` or `pglite://./rel/path`: PGlite persisted to a directory.
 */
export async function createDb(url: string): Promise<Db> {
  if (url.startsWith('postgres://') || url.startsWith('postgresql://')) {
    return new PgDb(url);
  }
  if (url.startsWith('pglite://')) {
    let rest = url.slice('pglite://'.length);
    if (rest === '' || rest === 'memory') return PgliteDb.create();
    // pglite:///C:/data -> C:/data on Windows
    if (/^\/[A-Za-z]:[\\/]/.test(rest)) rest = rest.slice(1);
    return PgliteDb.create(rest);
  }
  throw new Error(`Unsupported DATABASE_URL scheme: ${url.split(':')[0]}`);
}
