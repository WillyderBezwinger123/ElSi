import pg from 'pg';
import type { Db } from './db.js';

const INT8_OID = 20;

// Parse bigint as number (sequence values stay far below 2^53) to match PGlite.
const types = {
  getTypeParser: ((oid: number, format?: 'text' | 'binary') =>
    oid === INT8_OID
      ? (v: string) => Number(v)
      : pg.types.getTypeParser(oid, format as 'text')) as typeof pg.types.getTypeParser,
};

class PgClientDb implements Db {
  readonly kind = 'pg' as const;
  constructor(private readonly client: pg.PoolClient) {}

  async query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }> {
    const r = await this.client.query(sql, params as unknown[]);
    return { rows: r.rows as T[] };
  }

  async exec(sql: string): Promise<void> {
    await this.client.query(sql);
  }

  tx<T>(fn: (db: Db) => Promise<T>): Promise<T> {
    return fn(this);
  }

  async close(): Promise<void> {
    throw new Error('cannot close a transaction handle');
  }
}

export class PgDb implements Db {
  readonly kind = 'pg' as const;
  private readonly pool: pg.Pool;

  constructor(connectionString: string) {
    this.pool = new pg.Pool({ connectionString, types, max: 10 });
  }

  async query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }> {
    const r = await this.pool.query(sql, params as unknown[]);
    return { rows: r.rows as T[] };
  }

  async exec(sql: string): Promise<void> {
    await this.pool.query(sql);
  }

  async tx<T>(fn: (db: Db) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(new PgClientDb(client));
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
