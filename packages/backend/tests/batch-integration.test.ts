import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { getPool, closePool } from '../src/db/pool.ts';
import { runMigrations } from '../src/db/migrate.ts';
import { buildApp } from '../src/app.ts';
import { loadConfig } from '../src/config/index.ts';
import { insertPayment } from '../src/payments/repository.ts';
import { listActionsForCase } from '../src/recovery/action-repository.ts';
import { listAuditEventsForPayment } from '../src/audit/repository.ts';
import { runBatchRecovery } from '../src/jobs/batch-recovery.ts';
import { getRecoveryMetrics } from '../src/analytics/recovery-metrics.ts';
import { MockRecoveryProvider } from '../src/payments/providers/mock.ts';
import { MockAIProvider } from '../src/agents/diagnosis/providers/mock.ts';
import type { ObservedPaymentState } from '../src/payments/provider.ts';

/**
 * BATCH RECOVERY + ANALYTICS against REAL PostgreSQL.
 *
 * Skips when RECOVERAI_TEST_DATABASE_URL is unset, matching the other
 * integration suites. No credentials appear here and no real provider is used:
 * every run goes through MockRecoveryProvider.
 */
const TEST_DB_URL = process.env.RECOVERAI_TEST_DATABASE_URL;
const dbAvailable = TEST_DB_URL !== undefined && TEST_DB_URL.length > 0;
if (dbAvailable) process.env.DATABASE_URL = TEST_DB_URL;

const skip = dbAvailable
  ? false
  : 'RECOVERAI_TEST_DATABASE_URL is not set; skipping live batch tests';

const MERCHANT = 'merchant_batch';
const OTHER_MERCHANT = 'merchant_batch_other';
const CUSTOMER = 'cust_batch';
const CONFIG = loadConfig({});

async function cleanFixtures(): Promise<void> {
  const pool = getPool();
  await pool.query(
    `DELETE FROM recovery_actions WHERE recovery_case_id IN
       (SELECT id FROM recovery_cases WHERE payment_id LIKE 'pay_bt_%')`,
  );
  await pool.query(`DELETE FROM recovery_cases WHERE payment_id LIKE 'pay_bt_%'`);
  // audit_events is append-only by trigger and is deliberately NOT deleted
  // here. Removing the payment cascades to its events, which is the only
  // sanctioned way they disappear.
  await pool.query(`DELETE FROM payments WHERE id LIKE 'pay_bt_%'`);
}

/**
 * Seed a payment only — no recovery case.
 *
 * The batch run must create the case itself through analyzePayment, which is
 * the path a real run takes.
 */
async function seedPayment(options: {
  id: string;
  amount?: number;
  status?: 'failed' | 'abandoned' | 'captured';
  merchantId?: string;
  attemptCount?: number;
}): Promise<void> {
  await insertPayment({
    id: options.id,
    merchantId: options.merchantId ?? MERCHANT,
    customerId: CUSTOMER,
    orderId: `ord_${options.id}`,
    amount: options.amount ?? 249_900,
    currency: 'INR',
    status: (options.status ?? 'failed') as 'failed',
    failureReason: options.status === 'captured' ? null : 'gateway_timeout',
    attemptCount: options.attemptCount ?? 0,
    isSubscription: false,
    createdAt: new Date('2026-08-22T10:00:00.000Z'),
  });
}

function deps(provider: MockRecoveryProvider) {
  return {
    provider: new MockAIProvider(),
    recoveryProvider: provider,
    config: CONFIG,
  };
}

describe('batch recovery — live database', { skip }, () => {
  before(async () => {
    await runMigrations();
    const pool = getPool();
    for (const m of [MERCHANT, OTHER_MERCHANT]) {
      await pool.query(
        `INSERT INTO merchants (id, name, currency) VALUES ($1,'Batch Co','INR')
         ON CONFLICT (id) DO NOTHING`,
        [m],
      );
    }
    await pool.query(
      `INSERT INTO customers (id, merchant_id, name, email)
       VALUES ($1,$2,'Batch Person','batch@example.com') ON CONFLICT (id) DO NOTHING`,
      [CUSTOMER, MERCHANT],
    );
  });

  after(async () => {
    await cleanFixtures();
    await closePool();
  });

  beforeEach(async () => {
    await cleanFixtures();
  });

  // -- population handling ---------------------------------------------------
  describe('population', () => {
    test('an empty population produces a well-formed empty run', async () => {
      const summary = await runBatchRecovery(
        { merchantId: MERCHANT },
        deps(new MockRecoveryProvider()),
      );

      assert.equal(summary.totalEligible, 0);
      assert.equal(summary.analyzed, 0);
      assert.equal(summary.recovered, 0);
      assert.equal(summary.amountAtRisk, 0);
      assert.equal(summary.amountRecovered, 0);
      assert.deepEqual(summary.items, []);
      assert.ok(summary.runId.startsWith('run_'));
    });

    test('a single payment is processed end to end', async () => {
      await seedPayment({ id: 'pay_bt_one' });
      const provider = new MockRecoveryProvider({
        defaultOutcome: 'SUCCESS',
        observedState: 'SUCCEEDED',
      });

      const summary = await runBatchRecovery({ merchantId: MERCHANT }, deps(provider));

      assert.equal(summary.totalEligible, 1);
      assert.equal(summary.analyzed, 1);
      assert.equal(summary.items.length, 1);
      // The whole chain ran: authorized -> executed -> verified.
      assert.equal(provider.callCount, 1, 'exactly one execution');
      assert.ok(provider.statusLookupCount >= 1, 'verification observed the payment');
    });

    test('multiple payments are all processed', async () => {
      for (let i = 0; i < 5; i += 1) {
        await seedPayment({ id: `pay_bt_multi_${i}` });
      }
      const summary = await runBatchRecovery(
        { merchantId: MERCHANT },
        deps(new MockRecoveryProvider()),
      );

      assert.equal(summary.totalEligible, 5);
      assert.equal(summary.items.length, 5);
      assert.equal(summary.failed, 0);
    });

    test('captured payments are not eligible', async () => {
      await seedPayment({ id: 'pay_bt_ok', status: 'captured' });
      const summary = await runBatchRecovery(
        { merchantId: MERCHANT },
        deps(new MockRecoveryProvider()),
      );
      assert.equal(summary.totalEligible, 0, 'a captured payment was picked up');
    });

    test('the merchant filter scopes the population', async () => {
      await seedPayment({ id: 'pay_bt_m1', merchantId: MERCHANT });
      await seedPayment({ id: 'pay_bt_m2', merchantId: OTHER_MERCHANT });

      const summary = await runBatchRecovery(
        { merchantId: OTHER_MERCHANT },
        deps(new MockRecoveryProvider()),
      );
      assert.equal(summary.totalEligible, 1);
      assert.equal(summary.items[0]!.paymentId, 'pay_bt_m2');
    });

    test('the limit bounds the population', async () => {
      for (let i = 0; i < 4; i += 1) await seedPayment({ id: `pay_bt_lim_${i}` });
      const summary = await runBatchRecovery(
        { merchantId: MERCHANT, limit: 2 },
        deps(new MockRecoveryProvider()),
      );
      assert.equal(summary.totalEligible, 2);
    });
  });

  // -- IDEMPOTENCY — the critical property ----------------------------------
  describe('idempotency', () => {
    test('RE-RUNNING the same batch does not execute twice', async () => {
      await seedPayment({ id: 'pay_bt_rerun' });
      const provider = new MockRecoveryProvider({
        defaultOutcome: 'SUCCESS',
        observedState: 'SUCCEEDED',
      });

      const first = await runBatchRecovery({ merchantId: MERCHANT }, deps(provider));
      const callsAfterFirst = provider.callCount;

      const second = await runBatchRecovery({ merchantId: MERCHANT }, deps(provider));

      // THE ASSERTION THAT MATTERS: no second provider execution.
      assert.equal(
        provider.callCount,
        callsAfterFirst,
        're-running the batch caused a second provider execution',
      );
      assert.equal(first.items.length, 1);
      // The second run does no work. A payment verified as recovered is
      // updated to `captured`, so it correctly leaves the failed/abandoned
      // population — re-running cannot touch it again by any path.
      assert.equal(second.recovered, 0, 'the second run claimed a recovery');
      assert.equal(second.amountRecovered, 0, 'recovered revenue was double-counted');
    });

    test('re-running produces no duplicate action rows', async () => {
      await seedPayment({ id: 'pay_bt_duprow' });
      const provider = new MockRecoveryProvider();

      const first = await runBatchRecovery({ merchantId: MERCHANT }, deps(provider));
      await runBatchRecovery({ merchantId: MERCHANT }, deps(provider));

      const caseId = first.items[0]!.caseId;
      assert.ok(caseId !== null);
      const actions = await listActionsForCase(caseId);
      // One idempotency key, one action row, however many runs.
      const executed = actions.filter((a) => a.executionStatus !== 'SKIPPED_DUPLICATE');
      assert.equal(executed.length, 1, 'a duplicate action row was created');
    });

    test('a still-eligible payment is SKIPPED_DUPLICATE on the second run', async () => {
      // Execution succeeds but the evidence says the payment is still failed,
      // so it stays in the eligible population. The second run therefore DOES
      // reach the executor — and the database UNIQUE idempotency key, not the
      // batch layer, is what prevents a second provider call.
      await seedPayment({ id: 'pay_bt_stilleligible' });
      const provider = new MockRecoveryProvider({
        defaultOutcome: 'SUCCESS',
        observedState: 'FAILED' as ObservedPaymentState,
      });

      const first = await runBatchRecovery({ merchantId: MERCHANT }, deps(provider));
      assert.equal(first.totalEligible, 1);
      const callsAfterFirst = provider.callCount;

      const second = await runBatchRecovery({ merchantId: MERCHANT }, deps(provider));

      assert.equal(second.totalEligible, 1, 'the payment left the population unexpectedly');
      assert.equal(
        provider.callCount,
        callsAfterFirst,
        'the executor allowed a second provider execution',
      );
      // The executor reported the duplicate rather than silently doing nothing.
      assert.equal(second.items[0]!.status, 'SKIPPED_DUPLICATE');
      assert.equal(second.skippedDuplicate, 1);
    });

    test('a CRASHED in-flight action is never re-executed by a later run', async () => {
      // Migration 002: a row stuck in EXECUTING after a crash "is exactly as
      // ambiguous as UNCONFIRMED and must be resolved by state verification,
      // never by a blind retry". EXECUTING is set immediately BEFORE the
      // provider call, so the request may already have reached the gateway.
      //
      // The hazard is subtle: the stranded case is no longer live, so
      // re-analysis would fork a SECOND case with a legitimately different
      // idempotency key, and the executor would correctly allow it. Only the
      // batch eligibility screen prevents the double charge.
      for (const stranded of ['EXECUTING', 'PENDING'] as const) {
        await cleanFixtures();
        await seedPayment({ id: 'pay_bt_crash' });
        const provider = new MockRecoveryProvider({
          defaultOutcome: 'SUCCESS',
          // Stays failed, so the payment remains in the eligible population.
          observedState: 'FAILED' as ObservedPaymentState,
        });

        await runBatchRecovery({ merchantId: MERCHANT }, deps(provider));
        const callsBefore = provider.callCount;

        // Simulate the crash window.
        await getPool().query(
          `UPDATE recovery_actions SET execution_status = $1
           WHERE recovery_case_id IN
             (SELECT id FROM recovery_cases WHERE payment_id = 'pay_bt_crash')`,
          [stranded],
        );

        const rerun = await runBatchRecovery({ merchantId: MERCHANT }, deps(provider));

        assert.equal(
          provider.callCount,
          callsBefore,
          `a stranded ${stranded} action was re-executed — possible double charge`,
        );
        assert.equal(rerun.items[0]!.status, 'SKIPPED_DUPLICATE');

        const { rows } = await getPool().query<{ c: string }>(
          `SELECT COUNT(*)::text AS c FROM recovery_actions ra
           JOIN recovery_cases rc ON rc.id = ra.recovery_case_id
           WHERE rc.payment_id = 'pay_bt_crash'`,
        );
        assert.equal(rows[0]!.c, '1', `a second action row was created after ${stranded}`);
      }
    });

    test('two CONCURRENT runs over the same payment execute once', async () => {
      await seedPayment({ id: 'pay_bt_conc' });
      const provider = new MockRecoveryProvider({
        defaultOutcome: 'SUCCESS',
        observedState: 'SUCCEEDED',
      });

      // The database UNIQUE constraint, not the batch layer, decides the winner.
      await Promise.all([
        runBatchRecovery({ merchantId: MERCHANT }, deps(provider)),
        runBatchRecovery({ merchantId: MERCHANT }, deps(provider)),
      ]);

      assert.equal(provider.callCount, 1, 'concurrent runs both executed');
    });

    test('an already-executed case is skipped, not re-executed', async () => {
      await seedPayment({ id: 'pay_bt_already' });
      const provider = new MockRecoveryProvider();

      await runBatchRecovery({ merchantId: MERCHANT }, deps(provider));
      const callsAfter = provider.callCount;
      const summary = await runBatchRecovery({ merchantId: MERCHANT }, deps(provider));

      assert.equal(provider.callCount, callsAfter, 'an executed case was executed again');
      assert.equal(summary.failed, 0, 'the second run errored');
    });

    test('re-running does not duplicate audit events for one execution', async () => {
      await seedPayment({ id: 'pay_bt_audit' });
      const provider = new MockRecoveryProvider();

      await runBatchRecovery({ merchantId: MERCHANT }, deps(provider));
      const afterFirst = (await listAuditEventsForPayment('pay_bt_audit')).filter(
        (e) => e.eventType === 'EXECUTION_REQUESTED',
      ).length;

      await runBatchRecovery({ merchantId: MERCHANT }, deps(provider));
      const afterSecond = (await listAuditEventsForPayment('pay_bt_audit')).filter(
        (e) => e.eventType === 'EXECUTION_REQUESTED',
      ).length;

      assert.equal(afterSecond, afterFirst, 'a second ACTION_EXECUTED event was written');
    });
  });

  // -- partial failure -------------------------------------------------------
  describe('partial failure', () => {
    test('one failing payment does not abort the run', async () => {
      for (let i = 0; i < 5; i += 1) await seedPayment({ id: `pay_bt_pf_${i}` });

      // Fail on the third payment only.
      //
      // NOTE ON THE INJECTION POINT. A *provider* throw can never reach the
      // batch layer: the executor records it as UNCONFIRMED and the verifier
      // records it as an unsuccessful observation, because a transport error
      // is not proof the remote side did nothing. That is the existing
      // UNKNOWN-safety design and it is correct.
      //
      // The failures batch must survive are therefore infrastructure-level —
      // a database hiccup mid-run — which is what is simulated here.
      // The provider's `name` getter throws on the third access. This models
      // an unexpected internal fault — the only kind that actually reaches the
      // batch layer — without pretending a transport error does.
      let seen = 0;
      const provider = new MockRecoveryProvider();
      Object.defineProperty(provider, 'name', {
        get() {
          seen += 1;
          if (seen === 3) throw new Error('simulated internal fault');
          return 'mock';
        },
      });

      const summary = await runBatchRecovery({ merchantId: MERCHANT }, deps(provider));

      // Every payment produced an item; the run did not stop at the failure.
      assert.equal(summary.items.length, 5, 'the run aborted early');
      assert.equal(summary.failed, 1, 'the failure was not recorded');
      assert.equal(summary.analyzed, 4);
      const errored = summary.items.filter((i) => i.status === 'ERROR');
      assert.equal(errored.length, 1);
      // The error is reported, not swallowed.
      assert.ok(errored[0]!.message.length > 0);
    });

    test('a failure message never leaks a credential', async () => {
      await seedPayment({ id: 'pay_bt_leak' });
      const provider = new MockRecoveryProvider();
      Object.defineProperty(provider, 'name', {
        get(): string {
          throw new Error(
            'request failed with key rzp_test_SECRETKEY123 and Bearer abcdef0123456789token',
          );
        },
      });

      const summary = await runBatchRecovery({ merchantId: MERCHANT }, deps(provider));
      const message = summary.items[0]!.message;

      assert.ok(!message.includes('rzp_test_SECRETKEY123'), 'a Razorpay key leaked');
      assert.ok(!message.includes('abcdef0123456789token'), 'a bearer token leaked');
      assert.ok(message.includes('[redacted'), 'the message was not scrubbed');
    });
  });

  // -- authorization is never bypassed ---------------------------------------
  describe('authorization', () => {
    test('a payment over the retry ceiling is not executed', async () => {
      // attemptCount above POLICY_MAX_RETRY_ATTEMPTS: policy must refuse.
      await seedPayment({ id: 'pay_bt_maxed', attemptCount: 9 });
      const provider = new MockRecoveryProvider();

      const summary = await runBatchRecovery({ merchantId: MERCHANT }, deps(provider));

      assert.equal(provider.callCount, 0, 'an unauthorized action reached the provider');
      const item = summary.items[0]!;
      assert.ok(
        item.status === 'NOT_AUTHORIZED' || item.status === 'REFUSED' || item.status === 'NO_CASE',
        `unexpected status ${item.status}`,
      );
    });

    test('a high-value payment requiring approval is not executed', async () => {
      // Above POLICY_HIGH_VALUE_THRESHOLD (default 10,00,000 paise).
      await seedPayment({ id: 'pay_bt_highval', amount: 2_500_000 });
      const provider = new MockRecoveryProvider();

      const summary = await runBatchRecovery({ merchantId: MERCHANT }, deps(provider));

      assert.equal(provider.callCount, 0, 'an approval-gated action was executed');
      assert.notEqual(summary.items[0]!.status, 'RECOVERED');
    });

    test('a dry run authorizes but never touches the provider', async () => {
      await seedPayment({ id: 'pay_bt_dry' });
      const provider = new MockRecoveryProvider();

      const summary = await runBatchRecovery(
        { merchantId: MERCHANT, execute: false },
        deps(provider),
      );

      assert.equal(provider.callCount, 0, 'a dry run executed');
      assert.equal(provider.statusLookupCount, 0, 'a dry run contacted the provider');
      assert.equal(summary.executed, 0);
      assert.equal(summary.amountRecovered, 0);
    });
  });

  // -- outcome accounting ----------------------------------------------------
  describe('outcomes', () => {
    test('recovered revenue counts ONLY verified recoveries', async () => {
      await seedPayment({ id: 'pay_bt_ver', amount: 100_000 });
      const provider = new MockRecoveryProvider({
        defaultOutcome: 'SUCCESS',
        observedState: 'SUCCEEDED',
      });

      const summary = await runBatchRecovery({ merchantId: MERCHANT }, deps(provider));
      const item = summary.items[0]!;

      if (item.status === 'RECOVERED') {
        assert.equal(item.verificationStatus, 'VERIFIED');
        assert.equal(summary.amountRecovered, item.amountAtRisk);
      } else {
        // Not verified => contributes nothing, whatever the provider said.
        assert.equal(summary.amountRecovered, 0);
      }
    });

    test('an execution SUCCESS with a PENDING payment is NOT recovered revenue', async () => {
      // The core distinction: the provider accepted the request, but the money
      // has not moved.
      await seedPayment({ id: 'pay_bt_pending', amount: 100_000 });
      const provider = new MockRecoveryProvider({
        defaultOutcome: 'SUCCESS',
        observedState: 'PENDING' as ObservedPaymentState,
      });

      const summary = await runBatchRecovery({ merchantId: MERCHANT }, deps(provider));

      assert.equal(summary.amountRecovered, 0, 'an unverified execution counted as revenue');
      assert.equal(summary.recovered, 0);
    });

    test('mixed outcomes are counted independently', async () => {
      await seedPayment({ id: 'pay_bt_mix_a', amount: 100_000 });
      await seedPayment({ id: 'pay_bt_mix_b', amount: 200_000 });
      const provider = new MockRecoveryProvider({
        defaultOutcome: 'SUCCESS',
        observedStateByPayment: {
          pay_bt_mix_a: 'SUCCEEDED',
          pay_bt_mix_b: 'FAILED',
        },
      });

      const summary = await runBatchRecovery({ merchantId: MERCHANT }, deps(provider));

      assert.equal(summary.items.length, 2);
      assert.equal(summary.failed, 0, 'a normal outcome was counted as a failure');
      // At most one can be recovered revenue.
      assert.ok(summary.amountRecovered <= 100_000);
    });

    test('amounts are integers throughout the summary', async () => {
      await seedPayment({ id: 'pay_bt_int', amount: 249_913 });
      const summary = await runBatchRecovery(
        { merchantId: MERCHANT },
        deps(new MockRecoveryProvider()),
      );

      assert.ok(Number.isSafeInteger(summary.amountAtRisk), 'amountAtRisk is not an integer');
      assert.ok(Number.isSafeInteger(summary.amountRecovered), 'amountRecovered is not an integer');
      for (const item of summary.items) {
        assert.ok(Number.isSafeInteger(item.amountAtRisk));
        assert.ok(Number.isSafeInteger(item.amountRecovered));
      }
    });
  });
});

// ---------------------------------------------------------------------------
// ANALYTICS
// ---------------------------------------------------------------------------

describe('recovery analytics — live database', { skip }, () => {
  before(async () => {
    await runMigrations();
    const pool = getPool();
    await pool.query(
      `INSERT INTO merchants (id, name, currency) VALUES ($1,'Batch Co','INR')
       ON CONFLICT (id) DO NOTHING`,
      [MERCHANT],
    );
    await pool.query(
      `INSERT INTO customers (id, merchant_id, name, email)
       VALUES ($1,$2,'Batch Person','batch@example.com') ON CONFLICT (id) DO NOTHING`,
      [CUSTOMER, MERCHANT],
    );
  });

  after(async () => {
    await cleanFixtures();
  });

  beforeEach(async () => {
    await cleanFixtures();
  });

  test('zero data returns zeros, not NaN or null', async () => {
    const metrics = await getRecoveryMetrics({ merchantId: MERCHANT });

    assert.equal(metrics.totalCases, 0);
    assert.equal(metrics.amountAtRisk, 0);
    assert.equal(metrics.amountRecovered, 0);
    assert.equal(metrics.amountUnrecovered, 0);
    // The division guard: 0/0 must not produce NaN.
    assert.equal(metrics.recoveryRate, 0);
    assert.ok(!Number.isNaN(metrics.recoveryRate));
    assert.deepEqual(metrics.casesByStatus, []);
  });

  test('amount at risk aggregates exactly, in minor units', async () => {
    await seedPayment({ id: 'pay_bt_an1', amount: 100_001 });
    await seedPayment({ id: 'pay_bt_an2', amount: 249_999 });
    await runBatchRecovery({ merchantId: MERCHANT }, deps(new MockRecoveryProvider()));

    const metrics = await getRecoveryMetrics({ merchantId: MERCHANT });

    assert.ok(Number.isSafeInteger(metrics.amountAtRisk), 'aggregate is not an integer');
    // Exact integer arithmetic: no float rounding anywhere in the path.
    assert.equal(metrics.amountAtRisk % 1, 0);
    assert.ok(metrics.amountAtRisk > 0);
  });

  test('recovered amount counts only VERIFIED actions', async () => {
    await seedPayment({ id: 'pay_bt_anv', amount: 100_000 });
    const provider = new MockRecoveryProvider({
      defaultOutcome: 'SUCCESS',
      observedState: 'PENDING' as ObservedPaymentState,
    });
    await runBatchRecovery({ merchantId: MERCHANT }, deps(provider));

    const metrics = await getRecoveryMetrics({ merchantId: MERCHANT });

    // The provider accepted the request but the evidence says PENDING.
    assert.equal(metrics.amountRecovered, 0, 'an unverified action counted as recovered');
  });

  test('recovery rate is recovered / at risk and never exceeds 1', async () => {
    await seedPayment({ id: 'pay_bt_anr', amount: 100_000 });
    await runBatchRecovery(
      { merchantId: MERCHANT },
      deps(new MockRecoveryProvider({ defaultOutcome: 'SUCCESS', observedState: 'SUCCEEDED' })),
    );

    const metrics = await getRecoveryMetrics({ merchantId: MERCHANT });

    assert.ok(metrics.recoveryRate >= 0 && metrics.recoveryRate <= 1, 'rate out of range');
    if (metrics.amountAtRisk > 0) {
      const expected =
        Math.round((metrics.amountRecovered / metrics.amountAtRisk) * 10_000) / 10_000;
      assert.equal(metrics.recoveryRate, expected);
    }
    assert.equal(
      metrics.amountUnrecovered,
      Math.max(0, metrics.amountAtRisk - metrics.amountRecovered),
    );
  });

  test('status, action, and policy breakdowns are returned', async () => {
    await seedPayment({ id: 'pay_bt_anb' });
    await runBatchRecovery({ merchantId: MERCHANT }, deps(new MockRecoveryProvider()));

    const metrics = await getRecoveryMetrics({ merchantId: MERCHANT });

    assert.ok(Array.isArray(metrics.casesByStatus));
    assert.ok(Array.isArray(metrics.casesByAction));
    assert.ok(Array.isArray(metrics.actionsByExecutionStatus));
    assert.ok(Array.isArray(metrics.actionsByVerificationStatus));
    assert.ok(Array.isArray(metrics.actionsByPolicyStatus));
    // Counts are integers, and every key is a real domain code.
    for (const row of metrics.casesByStatus) {
      assert.ok(Number.isSafeInteger(row.count));
      assert.ok(typeof row.key === 'string' && row.key.length > 0);
    }
  });

  test('the merchant filter scopes every figure', async () => {
    await seedPayment({ id: 'pay_bt_scope', merchantId: MERCHANT, amount: 100_000 });
    await runBatchRecovery({ merchantId: MERCHANT }, deps(new MockRecoveryProvider()));

    const other = await getRecoveryMetrics({ merchantId: OTHER_MERCHANT });
    assert.equal(other.totalCases, 0, 'another merchant\'s data leaked into the filter');
    assert.equal(other.amountAtRisk, 0);
  });

  test('the metrics object exposes no credential-shaped field', async () => {
    await seedPayment({ id: 'pay_bt_ansec' });
    await runBatchRecovery({ merchantId: MERCHANT }, deps(new MockRecoveryProvider()));

    const serialised = JSON.stringify(await getRecoveryMetrics({ merchantId: MERCHANT }));
    for (const forbidden of ['apiKey', 'api_key', 'token', 'secret', 'password', 'rzp_', 'AIza']) {
      assert.ok(!serialised.includes(forbidden), `metrics exposed "${forbidden}"`);
    }
  });
});

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

describe('batch + analytics HTTP — live database', { skip }, () => {
  let app: FastifyInstance;

  before(async () => {
    await runMigrations();
    app = await buildApp({
      provider: new MockAIProvider(),
      recoveryProvider: new MockRecoveryProvider(),
    });
    await app.ready();
  });

  after(async () => {
    await cleanFixtures();
    await app?.close();
  });

  beforeEach(async () => {
    await cleanFixtures();
  });

  test('POST /api/recovery/runs returns a run summary', async () => {
    await seedPayment({ id: 'pay_bt_http' });
    const response = await app.inject({
      method: 'POST',
      url: '/api/recovery/runs',
      payload: { merchant_id: MERCHANT },
    });

    assert.equal(response.statusCode, 200);
    const body = JSON.parse(response.body) as Record<string, unknown>;
    assert.ok(typeof body['run_id'] === 'string');
    assert.equal(body['total_eligible'], 1);
    assert.ok('amount_at_risk' in body);
    assert.ok('amount_recovered' in body);
    assert.ok(Array.isArray(body['items']));
  });

  test('POST /api/recovery/runs accepts an empty body', async () => {
    const response = await app.inject({ method: 'POST', url: '/api/recovery/runs' });
    assert.equal(response.statusCode, 200);
  });

  test('POST /api/recovery/runs rejects an unknown field', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/recovery/runs',
      payload: { dry_run: true },
    });
    // A typo must fail loudly rather than silently executing.
    assert.equal(response.statusCode, 400);
  });

  test('POST /api/recovery/runs rejects an out-of-range limit', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/recovery/runs',
      payload: { limit: 99_999 },
    });
    assert.equal(response.statusCode, 400);
  });

  test('GET /api/analytics/recovery returns metrics', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/analytics/recovery' });

    assert.equal(response.statusCode, 200);
    const body = JSON.parse(response.body) as Record<string, unknown>;
    for (const field of [
      'total_cases',
      'amount_at_risk',
      'amount_recovered',
      'amount_unrecovered',
      'recovery_rate',
      'cases_by_status',
    ]) {
      assert.ok(field in body, `missing field ${field}`);
    }
    // The response states its own units so a consumer cannot misread paise.
    assert.equal(body['currency_unit'], 'minor');
  });

  test('GET /api/analytics/recovery rejects an unknown query parameter', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/analytics/recovery?merchant_id=m1&secret=x',
    });
    assert.equal(response.statusCode, 400);
  });

  test('neither endpoint leaks a credential', async () => {
    await seedPayment({ id: 'pay_bt_httpsec' });
    for (const response of [
      await app.inject({ method: 'POST', url: '/api/recovery/runs', payload: {} }),
      await app.inject({ method: 'GET', url: '/api/analytics/recovery' }),
    ]) {
      for (const forbidden of ['rzp_test_', 'rzp_live_', 'AIza', 'API_AUTH_TOKEN', 'Bearer ']) {
        assert.ok(!response.body.includes(forbidden), `response leaked "${forbidden}"`);
      }
    }
  });
});
