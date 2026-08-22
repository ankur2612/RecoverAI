import pg from 'pg';
import { loadConfig } from '../config/index.ts';
// Importing this module registers the global BIGINT type parser. Keep this
// import even though no symbol is used: money correctness depends on it.
import './types.ts';

let pool: pg.Pool | undefined;

/** Lazily-created shared connection pool. */
export function getPool(): pg.Pool {
  if (pool === undefined) {
    const config = loadConfig();
    pool = new pg.Pool({
      connectionString: config.databaseUrl,
      max: 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
    });
    // An error on an idle client is not fatal to the process; log and continue.
    pool.on('error', (error) => {
      console.error(JSON.stringify({ level: 'error', msg: 'idle pg client error', error: error.message }));
    });
  }
  return pool;
}

export async function closePool(): Promise<void> {
  if (pool !== undefined) {
    await pool.end();
    pool = undefined;
  }
}

/** Run a function inside a transaction, rolling back on any throw. */
export async function withTransaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
