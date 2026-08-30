import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

/**
 * ARCHITECTURAL TESTS FOR THE APPROVAL BOUNDARY
 *
 * Approval is the one place where a human's intent enters a system that moves
 * money. Its safety rests on a distinction that is easy to erode:
 *
 *   APPROVAL     "a person said yes"        <- this module
 *   AUTHORIZATION "the rules permit it"     <- the policy engine, always
 *
 * If approval could execute, or could set `authorized`, or could reach a
 * provider, a single API call would become a money-movement primitive. These
 * tests make that structurally impossible rather than merely discouraged.
 */

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');

function walk(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, acc);
    else if (entry.endsWith('.ts')) acc.push(full);
  }
  return acc;
}

/** Source with comments stripped, so prose about a rule is not a violation. */
function code(file: string): string {
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const SERVICE = join(SRC, 'recovery', 'approval-service.ts');
const REPO = join(SRC, 'recovery', 'approval-repository.ts');
const ROUTES = join(SRC, 'api', 'recovery.ts');
const ENGINE = join(SRC, 'policies', 'engine.ts');

const serviceCode = code(SERVICE);
const repoCode = code(REPO);
const routeCode = code(ROUTES);
const engineCode = code(ENGINE);

describe('approval architecture — approval cannot execute', () => {
  test('the approval service NEVER calls a payment provider', () => {
    // The single most important assertion here.
    assert.ok(
      !/\.executeAction\(/.test(serviceCode),
      'the approval service calls provider.executeAction — approval would move money',
    );
    assert.ok(!/executeAction/.test(serviceCode), 'the approval service references executeAction');
    assert.ok(
      !/getPaymentStatus/.test(serviceCode),
      'the approval service contacts a provider at all',
    );
  });

  test('the approval service imports no provider, executor, or execute service', () => {
    assert.ok(!/from ['"].*payments\/provider/.test(serviceCode), 'imports the provider interface');
    assert.ok(!/from ['"].*providers\//.test(serviceCode), 'imports a provider implementation');
    assert.ok(!/from ['"].*recovery\/executor/.test(serviceCode), 'imports the executor');
    assert.ok(!/from ['"].*execute-service/.test(serviceCode), 'imports the execute service');
    assert.ok(!/executeRecoveryAction/.test(serviceCode), 'can execute an action');
    assert.ok(!/executeRecoveryCase/.test(serviceCode), 'can execute a case');
    assert.ok(!/\bfetch\(/.test(serviceCode), 'calls fetch()');
  });

  test('the approval service does not evaluate policy', () => {
    // It must not be able to compute — or fake — an authorization.
    assert.ok(!/evaluatePolicy/.test(serviceCode), 'the approval service evaluates policy');
    assert.ok(!/buildPolicyInput/.test(serviceCode), 'the approval service builds a policy input');
    assert.ok(
      !/from ['"].*policies\/engine/.test(serviceCode),
      'the approval service imports the policy engine',
    );
    assert.ok(!/authorized/.test(serviceCode), 'the approval service references authorization');
  });

  test('the approval service claims no idempotency key and creates no action', () => {
    assert.ok(!/claimAction/.test(serviceCode), 'approval claims an execution action');
    assert.ok(!/buildIdempotencyKey/.test(serviceCode), 'approval derives an idempotency key');
    assert.ok(!/action-repository/.test(serviceCode), 'approval reaches the action repository');
    assert.ok(!/markExecuting|completeAction/.test(serviceCode), 'approval moves an action');
  });

  test('the approval service never touches ground truth', () => {
    assert.ok(!serviceCode.includes('payment_ground_truth'), 'approval reads the labels table');
    for (const label of ['groundTruth', 'idealAction', 'recoveryProbability']) {
      assert.ok(!serviceCode.includes(label), `approval references "${label}"`);
    }
  });

  test('the approval service reads no environment variable or credential', () => {
    assert.ok(!/process\.env/.test(serviceCode), 'approval reads process.env');
    assert.ok(!serviceCode.includes('API_AUTH_TOKEN'), 'approval reads the auth token');
    assert.ok(!/apiKey|keySecret|razorpayKey/.test(serviceCode), 'approval references a key');
    assert.ok(
      !/headers\.authorization|x-api-key/.test(serviceCode),
      'approval reads a credential header',
    );
  });
});

describe('approval architecture — approval cannot grant authorization', () => {
  test('a granted approval satisfies gates but never clears a FAILURE', () => {
    // The asymmetry that keeps a human from authorising a rule violation.
    // hasFailure must be computed WITHOUT reference to the approval flag.
    const summarise = engineCode.slice(
      engineCode.indexOf('function summarise'),
      engineCode.indexOf('export function evaluatePolicy'),
    );
    assert.ok(summarise.length > 0, 'summarise was not found');

    const failureLine = summarise
      .split('\n')
      .find((line) => line.includes('const hasFailure'));
    assert.ok(failureLine !== undefined, 'hasFailure was not found');
    assert.ok(
      !failureLine.includes('humanApprovalGranted'),
      'a human approval can clear a policy FAILURE — a human could authorise a rule violation',
    );

    // And authorization must still require the absence of both.
    assert.ok(
      /const authorized = !hasFailure && !needsApproval/.test(summarise),
      'authorization no longer requires the absence of failures and gates',
    );
  });

  test('the policy engine reads approval only as a boolean input', () => {
    // The engine must not import the approval layer to find out.
    assert.ok(
      !/from ['"].*approval-repository/.test(engineCode),
      'the policy engine reads the approval table directly',
    );
    assert.ok(
      !/from ['"].*approval-service/.test(engineCode),
      'the policy engine imports the approval service',
    );
    assert.ok(!/\bawait\b/.test(engineCode), 'the policy engine performs async work');
  });

  test('no route lets a client assert its own authorization', () => {
    // A client-supplied `authorized` or `force` would be a bypass.
    const schemaCode = code(join(SRC, 'api', 'schemas.ts'));
    const fn = schemaCode.slice(
      schemaCode.indexOf('export const approvalDecisionSchema'),
      schemaCode.indexOf('export const analyticsQuerySchema'),
    );
    assert.ok(fn.length > 0, 'approvalDecisionSchema was not found');
    for (const forbidden of ['authorized', 'force', 'override', 'amount', 'skip', 'bypass']) {
      assert.ok(!fn.includes(forbidden), `the approval schema exposes a "${forbidden}" field`);
    }
    assert.ok(/\.strict\(\)/.test(fn), 'the approval schema is not strict');
  });

  test('the approval route cannot reach a provider or the executor', () => {
    // The route file also hosts /execute, so scope to the decision handler.
    const handler = routeCode.slice(
      routeCode.indexOf('const decisionHandler'),
      routeCode.indexOf("'/api/recovery/:caseId/execute'"),
    );
    assert.ok(handler.length > 0, 'the decision handler was not found');
    assert.ok(!/\.executeAction\(/.test(handler), 'the decision handler calls a provider');
    assert.ok(!/executeRecoveryCase/.test(handler), 'the decision handler executes the case');
    assert.ok(!/evaluatePolicy/.test(handler), 'the decision handler evaluates policy');
  });
});

describe('approval architecture — the executor stays unaware', () => {
  const executorCode = code(join(SRC, 'recovery', 'executor.ts'));

  test('the executor does not know approval exists', () => {
    // It acts on the POLICY verdict alone. If it could read an approval, it
    // would have a second source of permission.
    assert.ok(
      !/from ['"].*approval-repository/.test(executorCode),
      'the executor imports the approval repository',
    );
    assert.ok(
      !/from ['"].*approval-service/.test(executorCode),
      'the executor imports the approval service',
    );
    assert.ok(!/approveRecoveryCase|rejectRecoveryCase/.test(executorCode));
    assert.ok(!/hasApproval|findDecisionForCase/.test(executorCode));
  });

  test('the executor still refuses an approval-gated policy verdict', () => {
    // Unchanged Phase-1 behaviour: requiresHumanApproval is a hard refusal.
    assert.ok(
      /requiresHumanApproval/.test(executorCode),
      'the executor no longer checks requiresHumanApproval',
    );
    assert.ok(
      /REQUIRES_HUMAN_APPROVAL/.test(executorCode),
      'the executor no longer has an approval refusal reason',
    );
  });

  test('the executor knows nothing about HTTP authentication', () => {
    assert.ok(!/from ['"].*api\/auth/.test(executorCode), 'the executor imports auth');
    assert.ok(!executorCode.includes('API_AUTH_TOKEN'));
    assert.ok(!/headers\.authorization/.test(executorCode));
  });

  test('the verifier remains independent of approval', () => {
    const verifierCode = code(join(SRC, 'recovery', 'verifier.ts'));
    assert.ok(!/approval/i.test(verifierCode), 'the verifier references approval');
  });

  test('no payment provider knows about approval', () => {
    for (const file of walk(join(SRC, 'payments'))) {
      const source = code(file);
      const rel = relative(SRC, file).replace(/\\/g, '/');
      assert.ok(!/from ['"].*approval/.test(source), `${rel} imports the approval layer`);
      assert.ok(!/approveRecoveryCase|hasApproval/.test(source), `${rel} references approval`);
    }
  });
});

describe('approval architecture — the decision record is immutable', () => {
  test('the repository has no update or delete', () => {
    // A decision is a historical fact. Changing it would destroy the audit
    // answer to "who approved this, and when".
    for (const write of ['UPDATE ', 'DELETE FROM', 'DROP ', 'TRUNCATE']) {
      assert.ok(
        !new RegExp(write, 'i').test(repoCode),
        `the approval repository issues a ${write.trim()} statement`,
      );
    }
  });

  test('one decision per case is enforced by the database', () => {
    // Not by a read-then-write check, which cannot survive concurrency.
    assert.ok(
      /ON CONFLICT \(recovery_case_id\) DO NOTHING/.test(repoCode),
      'the approval insert does not rely on a unique index to arbitrate',
    );
    const migration = readFileSync(
      join(SRC, 'db', 'migrations', '004_approvals.sql'),
      'utf8',
    );
    assert.ok(
      /CREATE UNIQUE INDEX[\s\S]*?recovery_approvals[\s\S]*?\(recovery_case_id\)/.test(migration),
      'the migration has no one-decision-per-case unique index',
    );
  });

  test('the migration is forward-only and idempotent', () => {
    const migration = readFileSync(
      join(SRC, 'db', 'migrations', '004_approvals.sql'),
      'utf8',
    );
    assert.ok(/CREATE TABLE IF NOT EXISTS/.test(migration), 'table creation is not idempotent');
    assert.ok(
      /CREATE UNIQUE INDEX IF NOT EXISTS/.test(migration),
      'index creation is not idempotent',
    );
    // It may DROP a CONSTRAINT/INDEX to rebuild it (Postgres has no ADD VALUE
    // for a CHECK), but must never drop a TABLE or a COLUMN.
    assert.ok(!/DROP TABLE/i.test(migration), 'the migration drops a table');
    assert.ok(!/DROP COLUMN/i.test(migration), 'the migration drops a column');
  });
});
