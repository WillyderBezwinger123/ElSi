import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { Db } from './db.js';

/**
 * Migrations are plain SQL files `NNN_name.sql` in this directory (copied to dist by the build).
 * Number ranges: core 001-099, chat 100-199, AI 200-299.
 * Each file runs in its own transaction and is recorded in `schema_migrations`.
 */
export const MIGRATIONS_DIR = fileURLToPath(new URL('./migrations/', import.meta.url));

const FILE_RE = /^(\d{3})_[a-z0-9_]+\.sql$/;
// Arbitrary constant key for pg_advisory_xact_lock, so concurrent instances migrate one at a time.
const MIGRATION_LOCK_KEY = 7_123_001;

export async function migrate(db: Db, dir: string = MIGRATIONS_DIR): Promise<string[]> {
  await db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version text PRIMARY KEY,
    name text NOT NULL,
    applied_at timestamptz NOT NULL DEFAULT now()
  )`);

  const files = (await readdir(dir)).filter((f) => FILE_RE.test(f)).sort();
  const seen = new Set<string>();
  for (const f of files) {
    const v = f.slice(0, 3);
    if (seen.has(v)) throw new Error(`Duplicate migration number ${v} (${f})`);
    seen.add(v);
  }

  const applied: string[] = [];
  for (const file of files) {
    const version = file.slice(0, 3);
    const sql = await readFile(`${dir}/${file}`, 'utf8');
    const ran = await db.tx(async (t) => {
      await t.query('SELECT pg_advisory_xact_lock($1)', [MIGRATION_LOCK_KEY]);
      const { rows } = await t.query('SELECT 1 FROM schema_migrations WHERE version = $1', [version]);
      if (rows.length > 0) return false;
      await t.exec(sql);
      await t.query('INSERT INTO schema_migrations (version, name) VALUES ($1, $2)', [version, file]);
      return true;
    });
    if (ran) applied.push(file);
  }
  return applied;
}
