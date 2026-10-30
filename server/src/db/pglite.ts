import { PGlite, type Transaction } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite-pgvector';
import type { Db } from './db.js';

class PgliteTxDb implements Db {
  readonly kind = 'pglite' as const;
  constructor(private readonly t: Transaction) {}

  async query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }> {
    const r = await this.t.query<T>(sql, params as unknown[]);
    return { rows: r.rows };
  }

  async exec(sql: string): Promise<void> {
    await this.t.exec(sql);
  }

  tx<T>(fn: (db: Db) => Promise<T>): Promise<T> {
    return fn(this);
  }

  async close(): Promise<void> {
    throw new Error('cannot close a transaction handle');
  }
}

/** In-process WASM Postgres (with pgvector). Single connection: queries are serialized. */
export class PgliteDb implements Db {
  readonly kind = 'pglite' as const;
  private constructor(private readonly pg: PGlite) {}

  /** `dataDir` undefined = in memory. */
  static async create(dataDir?: string): Promise<PgliteDb> {
    const pg = await PGlite.create({ dataDir, extensions: { vector } });
    return new PgliteDb(pg);
  }

  async query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }> {
    const r = await this.pg.query<T>(sql, params as unknown[]);
    return { rows: r.rows };
  }

  async exec(sql: string): Promise<void> {
    await this.pg.exec(sql);
  }

  tx<T>(fn: (db: Db) => Promise<T>): Promise<T> {
    return this.pg.transaction((t) => fn(new PgliteTxDb(t)));
  }

  async close(): Promise<void> {
    await this.pg.close();
  }
}
