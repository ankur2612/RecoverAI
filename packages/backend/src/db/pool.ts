import pg from 'pg';
import { loadConfig } from '../config/index.ts';
// Importing this module registers the global BIGINT type parser. Keep this
// import even though no symbol is used: money correctness depends on it.
import './types.ts';

let pool: pg.Pool | undefined;

/**
 * TLS settings derived from the connection string.
 *
 * Managed PostgreSQL (Render, Heroku, Supabase) terminates TLS with a
 * certificate chain that is not in Node's default trust store, so a plain
 * `ssl: true` fails with SELF_SIGNED_CERT_IN_CHAIN. The connection is still
 * encrypted; what is skipped is chain verification.
 *
 * Scoped narrowly on purpose:
 *   - `sslmode=require|prefer` in the URL, or PGSSLMODE set to one of those,
 *     opts in explicitly.
 *   - `sslmode=disable` and localhost/private-network URLs get no SSL at all,
 *     which keeps local development and Render's INTERNAL database URL — an
 *     unroutable private address — working unchanged.
 */
function sslOptions(databaseUrl: string): { ssl?: { rejectUnauthorized: boolean } } {
  const mode = (process.env.PGSSLMODE ?? '').trim().toLowerCase();
  if (mode === 'disable') return {};

  let requested = mode === 'require' || mode === 'prefer' || mode === 'verify-full';
  if (!requested) {
    try {
      requested = new URL(databaseUrl).searchParams.get('sslmode') === 'require';
    } catch {
      requested = false;
    }
  }
  if (!requested) return {};

  // verify-full means the operator supplied a trusted chain; honour it.
  return { ssl: { rejectUnauthorized: mode === 'verify-full' } };
}

/** Lazily-created shared connection pool. */
export function getPool(): pg.Pool {
  if (pool === undefined) {
    const config = loadConfig();
    pool = new pg.Pool({
      connectionString: config.databaseUrl,
      max: 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
      ...sslOptions(config.databaseUrl),
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
