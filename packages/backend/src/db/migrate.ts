/**
 * Forward-only migration runner.
 *
 * Each .sql file in ./migrations runs once, in filename order, inside a
 * transaction, and is recorded in schema_migrations. Applied files are never
 * re-run and are never edited in place — add a new numbered file instead.
 */
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { getPool, closePool } from './pool.ts';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'migrations');

async function ensureMigrationsTable(): Promise<void> {
  await getPool().query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename   TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
}

async function appliedMigrations(): Promise<Set<string>> {
  const { rows } = await getPool().query<{ filename: string }>(
    'SELECT filename FROM schema_migrations',
  );
  return new Set(rows.map((row) => row.filename));
}

export async function runMigrations(): Promise<string[]> {
  await ensureMigrationsTable();
  const applied = await appliedMigrations();

  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();

  const newlyApplied: string[] = [];
  for (const file of files) {
    if (applied.has(file)) continue;

    const sql = await readFile(join(MIGRATIONS_DIR, file), 'utf8');
    const client = await getPool().connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file]);
      await client.query('COMMIT');
      newlyApplied.push(file);
      console.log(`applied ${file}`);
    } catch (error) {
      await client.query('ROLLBACK');
      throw new Error(`migration ${file} failed: ${(error as Error).message}`, { cause: error });
    } finally {
      client.release();
    }
  }
  return newlyApplied;
}

// Run directly: `npm run migrate`.
// Compare as file URLs rather than strings: process.argv[1] is a native path
// (backslashes on Windows) while import.meta.url is always a file:// URL, so a
// plain endsWith() comparison silently never matches on Windows and the
// migration becomes a no-op.
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  try {
    const applied = await runMigrations();
    console.log(applied.length === 0 ? 'schema already up to date' : `${applied.length} migration(s) applied`);
  } catch (error) {
    console.error(`migration failed: ${(error as Error).message}`);
    process.exitCode = 1;
  } finally {
    await closePool();
  }
}
