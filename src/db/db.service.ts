import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { Pool, PoolClient, QueryResultRow } from 'pg';

export type Queryable = Pick<PoolClient, 'query'>;

@Injectable()
export class DbService implements OnModuleDestroy {
  readonly pool: Pool;

  constructor() {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error('DATABASE_URL is not set');
    const local = /localhost|127\.0\.0\.1/.test(url);
    this.pool = new Pool({
      connectionString: url,
      max: Number(process.env.DB_POOL_MAX ?? 10),
      ssl: local ? undefined : { rejectUnauthorized: false },
    });
  }

  async query<T extends QueryResultRow = any>(text: string, params: unknown[] = []): Promise<T[]> {
    const res = await this.pool.query<T>(text, params);
    return res.rows;
  }

  async one<T extends QueryResultRow = any>(text: string, params: unknown[] = []): Promise<T | null> {
    const rows = await this.query<T>(text, params);
    return rows[0] ?? null;
  }

  /** Runs fn inside a transaction; rolls back on any throw. */
  async tx<R>(fn: (client: PoolClient) => Promise<R>): Promise<R> {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      const result = await fn(client);
      await client.query('commit');
      return result;
    } catch (err) {
      await client.query('rollback').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async onModuleDestroy() {
    await this.pool.end();
  }
}
