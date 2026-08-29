import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * ARCHITECTURAL TESTS FOR THE BATCH AND ANALYTICS BOUNDARIES
 *
 * The batch layer's entire value depends on it being an ORCHESTRATOR. The
 * moment it can reach a provider, evaluate a policy, or implement its own
 * idempotency, RecoverAI has two recovery pipelines that can disagree — and
 * the safety properties proven about the first say nothing about the second.
 *
 * Enforced at the import level rather than by convention.
 */

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const BATCH = join(SRC, 'jobs', 'batch-recovery.ts');
const ANALYTICS = join(SRC, 'analytics', 'recovery-metrics.ts');

const batchSource = readFileSync(BATCH, 'utf8');
const analyticsSource = readFileSync(ANALYTICS, 'utf8');

/** Source with comments stripped, so prose about a rule is not read as a violation. */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const batchCode = code(batchSource);
const analyticsCode = code(analyticsSource);

describe('batch architecture — the batch layer is an orchestrator', () => {
  test('batch calls the existing pipeline services', () => {
    // The positive assertion: it must actually delegate.
    assert.ok(/analyzePayment/.test(batchCode), 'batch does not call analyzePayment');
    assert.ok(/executeRecoveryCase/.test(batchCode), 'batch does not call executeRecoveryCase');
    assert.ok(/verifyRecoveryCase/.test(batchCode), 'batch does not call verifyRecoveryCase');
  });

  test('batch NEVER calls a payment provider directly', () => {
    // The single most important constraint here. Money moves through the
    // executor or not at all.
    assert.ok(
      !/\.executeAction\(/.test(batchCode),
      'batch calls provider.executeAction directly, bypassing the executor',
    );
    assert.ok(
      !/\.getPaymentStatus\(/.test(batchCode),
      'batch calls provider.getPaymentStatus directly, bypassing the verifier',
    );
  });

  test('batch imports no concrete provider implementation', () => {
    assert.ok(!/from ['"].*providers\/razorpay/.test(batchCode), 'batch imports Razorpay');
    assert.ok(!/from ['"].*providers\/mock/.test(batchCode), 'batch imports a mock provider');
    assert.ok(!/from ['"].*providers\/gemini/.test(batchCode), 'batch imports Gemini');
    assert.ok(!/from ['"]razorpay['"]/.test(batchCode), 'batch imports the Razorpay SDK');
    assert.ok(!/\bfetch\(/.test(batchCode), 'batch calls fetch()');
  });

  test('batch does not evaluate policy or re-derive authorization', () => {
    // It may READ policy.authorized from a result, but it must not compute one.
    assert.ok(!/evaluatePolicy/.test(batchCode), 'batch calls evaluatePolicy');
    assert.ok(!/buildPolicyInput/.test(batchCode), 'batch builds a policy input');
    assert.ok(!/from ['"].*policies\//.test(batchCode), 'batch imports the policy engine');
  });

  test('batch does not call the raw executor, only the execute SERVICE', () => {
    // executeRecoveryAction takes a caller-supplied authorization. Calling it
    // directly would let batch pass an authorization it invented.
    assert.ok(
      !/executeRecoveryAction/.test(batchCode),
      'batch calls the raw executor instead of the execute service',
    );
    assert.ok(!/from ['"].*recovery\/executor/.test(batchCode), 'batch imports the executor');
  });

  test('batch implements no competing idempotency mechanism', () => {
    // The database UNIQUE constraint is the only idempotency authority.
    assert.ok(
      !/buildIdempotencyKey/.test(batchCode),
      'batch derives its own idempotency key',
    );
    assert.ok(!/claimAction/.test(batchCode), 'batch claims actions itself');
    assert.ok(!/INSERT INTO/i.test(batchCode), 'batch writes rows directly');
    assert.ok(!/UPDATE /i.test(batchCode), 'batch updates rows directly');
  });

  test('batch writes no audit events of its own', () => {
    // Each service already audits its own decision. A second writer would
    // produce duplicate events for one decision.
    assert.ok(!/appendAuditEvent/.test(batchCode), 'batch writes audit events directly');
  });

  test('batch never touches ground truth or evaluation data', () => {
    assert.ok(!batchCode.includes('payment_ground_truth'), 'batch reads the labels table');
    assert.ok(!/from ['"].*datasets\//.test(batchCode), 'batch imports datasets');
    for (const label of ['groundTruth', 'idealAction', 'evaluationLabel', 'recoveryProbability']) {
      assert.ok(!batchCode.includes(label), `batch references "${label}"`);
    }
  });

  test('batch reads no environment variable and no auth credential', () => {
    assert.ok(!/process\.env/.test(batchCode), 'batch reads process.env');
    assert.ok(!batchCode.includes('API_AUTH_TOKEN'), 'batch reads the auth token');
    assert.ok(!/authenticateRequest|isPublicPath/.test(batchCode), 'batch performs authentication');
  });

  test('batch introduces no uncontrolled parallelism', () => {
    // Sequential by design: Promise.all over the population would fan out
    // provider calls with no bound.
    assert.ok(
      !/Promise\.all|Promise\.allSettled|Promise\.race/.test(batchCode),
      'batch fans out concurrently over the population',
    );
  });

  test('batch adds no external queue or scheduler dependency', () => {
    for (const dep of ['bullmq', 'ioredis', 'redis', 'node-cron', 'agenda', 'bee-queue']) {
      assert.ok(!batchSource.includes(dep), `batch depends on ${dep}`);
    }
    assert.ok(!/setInterval|setTimeout\(/.test(batchCode), 'batch schedules its own work');
  });
});

describe('analytics architecture — read-only reporting', () => {
  test('analytics never contacts a provider', () => {
    // A metric is a report, never a cause. Querying a gateway to build a
    // dashboard would also turn a refresh into outbound API traffic.
    assert.ok(!/\.executeAction\(/.test(analyticsCode), 'analytics executes an action');
    assert.ok(!/\.getPaymentStatus\(/.test(analyticsCode), 'analytics calls a provider');
    assert.ok(!/from ['"].*payments\/provider/.test(analyticsCode), 'analytics imports a provider');
    assert.ok(!/from ['"].*providers\//.test(analyticsCode), 'analytics imports a provider impl');
    assert.ok(!/\bfetch\(/.test(analyticsCode), 'analytics calls fetch()');
  });

  test('analytics only READS', () => {
    for (const write of ['INSERT INTO', 'UPDATE ', 'DELETE FROM', 'DROP ', 'ALTER ']) {
      assert.ok(
        !new RegExp(write, 'i').test(analyticsCode),
        `analytics issues a ${write.trim()} statement`,
      );
    }
  });

  test('analytics never reads ground truth', () => {
    assert.ok(
      !analyticsCode.includes('payment_ground_truth'),
      'analytics reads the evaluation labels table',
    );
    for (const label of ['groundTruth', 'idealAction', 'recoveryProbability']) {
      assert.ok(!analyticsCode.includes(label), `analytics references "${label}"`);
    }
  });

  test('recovered revenue is defined ONLY by a VERIFIED verdict', () => {
    // The definition that keeps the headline number honest.
    assert.ok(
      /verification_status = 'VERIFIED'/.test(analyticsCode),
      'analytics does not gate recovered revenue on a VERIFIED verdict',
    );
    // And must not fall back to the provider's own claim of success.
    const recoveredQuery = analyticsCode.slice(
      analyticsCode.indexOf('amount_recovered'),
      analyticsCode.indexOf('const totals'),
    );
    assert.ok(
      !/execution_status\s*=\s*'SUCCESS'/.test(recoveredQuery),
      'recovered revenue counts an accepted execution rather than verified evidence',
    );
  });

  test('money is aggregated as integers, never floats', () => {
    // parseFloat/toFixed on an amount would silently lose paise.
    assert.ok(!/parseFloat/.test(analyticsCode), 'analytics parses an amount as a float');
    assert.ok(!/toFixed\(/.test(analyticsCode), 'analytics formats money with toFixed');
    // Sums are cast to ::text and range-checked rather than trusted.
    assert.ok(/::text/.test(analyticsCode), 'aggregates are not cast to text');
    assert.ok(/isSafeInteger/.test(analyticsCode), 'aggregate parsing is not range-checked');
  });

  test('analytics never reads a credential', () => {
    assert.ok(!/process\.env/.test(analyticsCode), 'analytics reads process.env');
    assert.ok(!analyticsCode.includes('API_AUTH_TOKEN'));
    assert.ok(!/apiKey|keySecret|razorpayKey/.test(analyticsCode), 'analytics references a key');
  });
});

describe('batch/analytics architecture — route wiring', () => {
  const appSource = readFileSync(join(SRC, 'app.ts'), 'utf8');
  const routeSource = code(readFileSync(join(SRC, 'api', 'analytics.ts'), 'utf8'));

  test('the routes are registered after the auth hook', () => {
    const authIndex = appSource.indexOf('registerAuth(');
    const routesIndex = appSource.indexOf('registerAnalyticsRoutes(');
    assert.ok(routesIndex > 0, 'analytics routes are never registered');
    assert.ok(authIndex > 0 && authIndex < routesIndex, 'routes registered before auth');
  });

  test('the routes perform no authentication of their own', () => {
    assert.ok(!/headers\.authorization|x-api-key/.test(routeSource), 'a route reads a credential');
    assert.ok(!routeSource.includes('API_AUTH_TOKEN'));
    assert.ok(!/authenticateRequest/.test(routeSource), 'a route authenticates itself');
  });

  test('the batch route delegates to the batch runner, not the pipeline directly', () => {
    assert.ok(/runBatchRecovery/.test(routeSource), 'the route does not call the batch runner');
    assert.ok(
      !/\.executeAction\(/.test(routeSource),
      'the route calls a provider directly',
    );
    assert.ok(!/evaluatePolicy/.test(routeSource), 'the route evaluates policy');
  });
});
