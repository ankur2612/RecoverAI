import pg from 'pg';

/**
 * Global node-postgres type parser registration.
 *
 * Postgres returns BIGINT as a string to avoid silent precision loss. Every
 * BIGINT in our schema is a money amount in minor units, comfortably inside
 * Number.MAX_SAFE_INTEGER, so we parse them to numbers — but we assert the
 * bound rather than assuming it, so an out-of-range value fails loudly instead
 * of silently losing paise.
 *
 * This lives in its own module, separate from the pool, because the
 * registration is process-global and must happen before ANY query runs.
 * A script that constructs its own pg.Client without touching the pool would
 * otherwise silently receive strings where the code expects numbers.
 */

const PG_INT8_OID = 20;

let registered = false;

export function registerPgTypeParsers(): void {
  if (registered) return;
  pg.types.setTypeParser(PG_INT8_OID, (value: string) => {
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed)) {
      throw new RangeError(
        `BIGINT value ${value} exceeds Number.MAX_SAFE_INTEGER and cannot be used as a money amount`,
      );
    }
    return parsed;
  });
  registered = true;
}

// Register on import so merely importing this module is sufficient.
registerPgTypeParsers();
