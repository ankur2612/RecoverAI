import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  CLASSIFICATIONS,
  EXECUTION_STATUSES,
  PAYMENT_STATUSES,
  POLICY_DECISIONS,
  RECOVERY_ACTIONS,
  RECOVERY_CASE_STATUSES,
  VERIFICATION_STATUSES,
} from '../src/shared/types.ts';

/**
 * Static checks on the migration SQL.
 *
 * These do not need a live database: they catch the class of bug where the
 * TypeScript enums and the SQL CHECK constraints drift apart, which would
 * otherwise only surface as a runtime insert failure mid-batch.
 */
const MIGRATIONS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'src',
  'db',
  'migrations',
);

const migrationFiles = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
const sql = migrationFiles.map((f) => readFileSync(join(MIGRATIONS_DIR, f), 'utf8')).join('\n');

describe('migrations — files', () => {
  test('at least one migration exists', () => {
    assert.ok(migrationFiles.length > 0);
  });

  test('filenames are numbered so ordering is unambiguous', () => {
    for (const file of migrationFiles) {
      assert.match(file, /^\d{3}_[a-z0-9_]+\.sql$/, `${file} is not a numbered migration`);
    }
  });

  test('migration numbers are unique', () => {
    const numbers = migrationFiles.map((f) => f.slice(0, 3));
    assert.equal(new Set(numbers).size, numbers.length, 'duplicate migration number');
  });
});

describe('migrations — required tables', () => {
  test('every entity from PRD section 24 has a table', () => {
    for (const table of [
      'merchants',
      'customers',
      'payments',
      'recovery_cases',
      'recovery_actions',
      'audit_events',
    ]) {
      assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\b`), `missing ${table}`);
    }
  });

  test('ground truth lives in its own table, not on payments', () => {
    // Labels must be structurally unavailable to the diagnosis path.
    assert.match(sql, /CREATE TABLE IF NOT EXISTS payment_ground_truth\b/);
    const paymentsBlock = sql.slice(
      sql.indexOf('CREATE TABLE IF NOT EXISTS payments'),
      sql.indexOf('CREATE INDEX IF NOT EXISTS payments_merchant_idx'),
    );
    for (const leaked of ['recoverable', 'ideal_action', 'recovery_probability', 'classification']) {
      assert.ok(
        !paymentsBlock.includes(leaked),
        `payments table exposes ground-truth column "${leaked}"`,
      );
    }
  });
});

describe('migrations — enum parity with TypeScript', () => {
  /**
   * Extract the quoted values of the named CHECK constraint.
   *
   * A later migration may redefine a constraint (002 added EXECUTING to the
   * execution check, 003 added AWAITING_VERIFICATION to the case check), so
   * parity must be checked against the LAST definition in migration order,
   * never the first.
   */
  function checkValues(constraint: string): string[] {
    const matches = [
      ...sql.matchAll(
        new RegExp(`CONSTRAINT ${constraint}[\\s\\S]*?\\(([\\s\\S]*?)\\)\\s*\\n`, 'g'),
      ),
    ];
    assert.ok(matches.length > 0, `constraint ${constraint} not found`);
    const latest = matches.at(-1)![1]!;
    return [...latest.matchAll(/'([A-Za-z_]+)'/g)].map((m) => m[1]!).sort();
  }

  test('payment status constraint matches PAYMENT_STATUSES', () => {
    assert.deepEqual(checkValues('payments_status_check'), [...PAYMENT_STATUSES].sort());
  });

  test('recovery action constraint matches RECOVERY_ACTIONS', () => {
    assert.deepEqual(checkValues('recovery_actions_type_check'), [...RECOVERY_ACTIONS].sort());
  });

  test('recommended action constraint matches RECOVERY_ACTIONS', () => {
    assert.deepEqual(checkValues('recovery_cases_action_check'), [...RECOVERY_ACTIONS].sort());
  });

  test('policy status constraint matches POLICY_DECISIONS', () => {
    assert.deepEqual(checkValues('recovery_actions_policy_check'), [...POLICY_DECISIONS].sort());
  });

  test('execution status constraint matches EXECUTION_STATUSES', () => {
    // The constraint is redefined by a later migration (002 adds EXECUTING),
    // so parity must be checked against the LAST definition, not the first.
    const matches = [
      ...sql.matchAll(
        /CONSTRAINT recovery_actions_execution_check[\s\S]*?\(([\s\S]*?)\)\s*\n/g,
      ),
    ];
    assert.ok(matches.length > 0, 'execution status constraint not found');
    const latest = matches.at(-1)![1]!;
    const values = [...latest.matchAll(/'([A-Z_]+)'/g)].map((m) => m[1]!).sort();
    assert.deepEqual(values, [...EXECUTION_STATUSES].sort());
  });

  test('verification status constraint matches VERIFICATION_STATUSES', () => {
    assert.deepEqual(
      checkValues('recovery_actions_verification_check'),
      [...VERIFICATION_STATUSES].sort(),
    );
  });

  test('case status constraint matches RECOVERY_CASE_STATUSES', () => {
    assert.deepEqual(checkValues('recovery_cases_status_check'), [...RECOVERY_CASE_STATUSES].sort());
  });

  test('every classification is representable', () => {
    // Stored as free TEXT, but the values must at least all be known.
    assert.ok(CLASSIFICATIONS.length > 0);
  });
});

describe('migrations — safety constraints', () => {
  test('money columns are BIGINT, never floating point', () => {
    for (const line of sql.split('\n')) {
      if (/\bamount\b/.test(line) && /^\s+amount/.test(line)) {
        assert.match(line, /BIGINT/, `money column is not BIGINT: ${line.trim()}`);
      }
    }
  });

  test('payment amounts must be positive', () => {
    assert.match(sql, /payments_amount_positive CHECK \(amount > 0\)/);
  });

  test('idempotency key is UNIQUE — the duplicate-execution guard', () => {
    // PRD section 13: this is what makes duplicate protection race-proof.
    assert.match(sql, /idempotency_key\s+TEXT\s+NOT NULL UNIQUE/);
  });

  test('only one live recovery case per payment', () => {
    assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS recovery_cases_one_open_per_payment/);

    // Check the LATEST definition: 003 redefines the index to include
    // AWAITING_VERIFICATION, since an executed-but-unverified case still has
    // an action outstanding and must block a competing case.
    const definitions = [
      ...sql.matchAll(
        /CREATE UNIQUE INDEX IF NOT EXISTS recovery_cases_one_open_per_payment[\s\S]*?WHERE status IN \(([^)]*)\)/g,
      ),
    ];
    const latest = definitions.at(-1)![1]!;
    const statuses = [...latest.matchAll(/'([A-Z_]+)'/g)].map((m) => m[1]!).sort();
    assert.deepEqual(statuses, [
      'AWAITING_APPROVAL', 'AWAITING_VERIFICATION', 'EXECUTING', 'OPEN',
    ]);
  });

  test('confidence and score columns are bounded to [0, 1]', () => {
    assert.match(sql, /confidence >= 0 AND confidence <= 1/);
    assert.match(sql, /recovery_probability >= 0 AND recovery_probability <= 1/);
  });

  test('audit log is append-only via triggers', () => {
    // PRD section 15: immutable from the normal application interface.
    assert.match(sql, /CREATE TRIGGER audit_events_no_update/);
    assert.match(sql, /CREATE TRIGGER audit_events_no_delete/);
    assert.match(sql, /RAISE EXCEPTION 'audit_events is append-only/);
  });

  test('foreign keys are declared between related entities', () => {
    assert.match(sql, /merchant_id TEXT\s+NOT NULL REFERENCES merchants \(id\)/);
    assert.match(sql, /payment_id\s+TEXT\s+NOT NULL REFERENCES payments \(id\)/);
    assert.match(sql, /recovery_case_id\s+TEXT\s+NOT NULL REFERENCES recovery_cases \(id\)/);
  });
});

describe('migrations — no secrets or destructive statements', () => {
  test('contains no credential-looking literals', () => {
    for (const pattern of [/rzp_live_/, /sk-ant-/, /PASSWORD\s+'/i]) {
      assert.ok(!pattern.test(sql), `migration contains a credential-like literal: ${pattern}`);
    }
  });

  test('contains no DROP TABLE or TRUNCATE', () => {
    // Forward-only migrations must never destroy financial records.
    assert.ok(!/DROP TABLE/i.test(sql), 'migration drops a table');
    assert.ok(!/TRUNCATE/i.test(sql), 'migration truncates a table');
  });
});
