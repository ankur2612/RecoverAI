import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { getPool, closePool } from '../src/db/pool.ts';
import { runMigrations } from '../src/db/migrate.ts';
import { buildApp } from '../src/app.ts';
import { loadConfig } from '../src/config/index.ts';
import { insertPayment } from '../src/payments/repository.ts';
import { listActionsForCase, findActionById } from '../src/recovery/action-repository.ts';
import { listAuditEventsForPayment } from '../src/audit/repository.ts';
import { runBatchRecovery } from '../src/jobs/batch-recovery.ts';
import { sweepStrandedActions, safeSweepMessage } from '../src/recovery/sweep-service.ts';
import { MockRecoveryProvider } from '../src/payments/providers/mock.ts';
import { MockAIProvider } from '../src/agents/diagnosis/providers/mock.ts';
import type { ObservedPaymentState } from '../src/payments/provider.ts';

/**
 * CRASH RECOVERY against REAL PostgreSQL.
 *
 * The property under test throughout: a stranded action is resolved by
 * OBSERVING the provider, never by executing again. Every test asserts the
 * provider's execute count did not move.
 *
 * All credentials here are fake. No real provider is contacted.
 */
const TEST_DB_URL = process.env.RECOVERAI_TEST_DATABASE_URL;
const dbAvailable = TEST_DB_URL !== undefined && TEST_DB_URL.length > 0;
if (dbAvailable) process.env.DATABASE_URL = TEST_DB_URL;

const skip = dbAvailable
  ? false
  : 'RECOVERAI_TEST_DATABASE_URL is not set; skipping live sweep tests';

const MERCHANT = 'merchant_sweep';
const CUSTOMER = 'cust_sweep';
const CONFIG = loadConfig({});

async function cleanFixtures(): Promise<void> {
  const pool = getPool();
  await pool.query(
    `DELETE FROM recovery_actions WHERE recovery_case_id IN
       (SELECT id FROM recovery_cases WHERE payment_id LIKE 'pay_sw_%')`,
  );
  await pool.query(`DELETE FROM recovery_cases WHERE payment_id LIKE 'pay_sw_%'`);
  // audit_events is append-only; deleting the payment cascades to its events.
  await pool.query(`DELETE FROM payments WHERE id LIKE 'pay_sw_%'`);
}

async function seedPayment(id: string, amount = 249_900): Promise<void> {
  await insertPayment({
    id,
    merchantId: MERCHANT,
    customerId: CUSTOMER,
    orderId: `ord_${id}`,
    amount,
    currency: 'INR',
    status: 'failed',
    failureReason: 'gateway_timeout',
    attemptCount: 0,
    isSubscription: false,
    createdAt: new Date('2026-08-22T10:00:00.000Z'),
  });
}

/**
 * Run one payment through the real pipeline, then force its action into a
 * stranded state — the state a crash would have left behind.
 */
async function strand(
  paymentId: string,
  strandedIn: 'EXECUTING' | 'PENDING',
  provider: MockRecoveryProvider,
): Promise<{ caseId: string; actionId: string }> {
  await seedPayment(paymentId);
  const run = await runBatchRecovery(
    { merchantId: MERCHANT },
    { provider: new MockAIProvider(), recoveryProvider: provider, config: CONFIG },
  );
  const caseId = run.items[0]!.caseId!;
  const actions = await listActionsForCase(caseId);
  const actionId = actions[0]!.id;

  // Simulate the crash window. Also clears the verification the normal run
  // wrote, so the row looks exactly like one abandoned mid-flight.
  await getPool().query(
    `UPDATE recovery_actions
     SET execution_status = $2, completed_at = NULL,
         verification_status = NULL, verified_at = NULL, verification_attempts = 0
     WHERE id = $1`,
    [actionId, strandedIn],
  );
  return { caseId, actionId };
}

/** minAgeSeconds 0 so freshly stranded fixtures are swept immediately. */
const SWEEP_NOW = { minAgeSeconds: 0, limit: 100 };

describe('crash recovery — live database', { skip }, () => {
  before(async () => {
    await runMigrations();
    const pool = getPool();
    await pool.query(
      `INSERT INTO merchants (id, name, currency) VALUES ($1,'Sweep Co','INR')
       ON CONFLICT (id) DO NOTHING`,
      [MERCHANT],
    );
    await pool.query(
      `INSERT INTO customers (id, merchant_id, name, email)
       VALUES ($1,$2,'Sweep Person','sweep@example.com') ON CONFLICT (id) DO NOTHING`,
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

  // -- 1-5: resolution by observation ---------------------------------------
  describe('resolution by provider observation', () => {
    test('EXECUTING + provider says SUCCEEDED -> resolved, no second execution', async () => {
      const provider = new MockRecoveryProvider({
        defaultOutcome: 'SUCCESS',
        observedState: 'SUCCEEDED',
      });
      const { actionId } = await strand('pay_sw_exec_ok', 'EXECUTING', provider);
      const executesBefore = provider.callCount;

      const summary = await sweepStrandedActions(SWEEP_NOW, { provider });

      assert.equal(provider.callCount, executesBefore, 'the sweeper RE-EXECUTED the action');
      assert.equal(summary.found, 1);
      assert.equal(summary.resolvedSuccess, 1);
      const action = await findActionById(actionId);
      assert.equal(action!.executionStatus, 'SUCCESS');
      assert.equal(summary.items[0]!.observedState, 'SUCCEEDED');
    });

    test('EXECUTING + provider says FAILED -> resolved, no second execution', async () => {
      const provider = new MockRecoveryProvider({
        defaultOutcome: 'SUCCESS',
        observedState: 'FAILED' as ObservedPaymentState,
      });
      const { actionId } = await strand('pay_sw_exec_fail', 'EXECUTING', provider);
      const executesBefore = provider.callCount;

      const summary = await sweepStrandedActions(SWEEP_NOW, { provider });

      assert.equal(provider.callCount, executesBefore, 'the sweeper RE-EXECUTED the action');
      assert.equal(summary.resolvedFailed, 1);
      const action = await findActionById(actionId);
      assert.equal(action!.executionStatus, 'FAILED');
    });

    test('EXECUTING + provider says PENDING -> stays UNCONFIRMED, never retried', async () => {
      // The safety case: the outcome is still genuinely unknown.
      const provider = new MockRecoveryProvider({
        defaultOutcome: 'SUCCESS',
        observedState: 'PENDING' as ObservedPaymentState,
      });
      const { actionId } = await strand('pay_sw_exec_unk', 'EXECUTING', provider);
      const executesBefore = provider.callCount;

      const summary = await sweepStrandedActions(SWEEP_NOW, { provider });

      assert.equal(provider.callCount, executesBefore, 'an ambiguous action was re-executed');
      assert.equal(summary.stillUnconfirmed, 1);
      const action = await findActionById(actionId);
      assert.equal(action!.executionStatus, 'UNCONFIRMED');
      // And it must NOT be recorded as recovered revenue.
      assert.notEqual(action!.verificationStatus, 'VERIFIED');
    });

    test('EXECUTING + provider says UNKNOWN -> stays UNCONFIRMED', async () => {
      const provider = new MockRecoveryProvider({
        defaultOutcome: 'SUCCESS',
        observedState: 'UNKNOWN' as ObservedPaymentState,
      });
      const { actionId } = await strand('pay_sw_exec_u2', 'EXECUTING', provider);
      const executesBefore = provider.callCount;

      const summary = await sweepStrandedActions(SWEEP_NOW, { provider });

      assert.equal(provider.callCount, executesBefore);
      assert.equal(summary.stillUnconfirmed, 1);
      assert.equal((await findActionById(actionId))!.executionStatus, 'UNCONFIRMED');
    });

    test('PENDING + provider says SUCCEEDED -> resolved without executing', async () => {
      const provider = new MockRecoveryProvider({
        defaultOutcome: 'SUCCESS',
        observedState: 'SUCCEEDED',
      });
      const { actionId } = await strand('pay_sw_pend_ok', 'PENDING', provider);
      const executesBefore = provider.callCount;

      const summary = await sweepStrandedActions(SWEEP_NOW, { provider });

      assert.equal(provider.callCount, executesBefore, 'a PENDING action was executed');
      assert.equal(summary.resolvedSuccess, 1);
      assert.equal((await findActionById(actionId))!.executionStatus, 'SUCCESS');
    });

    test('PENDING + provider says FAILED -> resolved without executing', async () => {
      const provider = new MockRecoveryProvider({
        defaultOutcome: 'SUCCESS',
        observedState: 'FAILED' as ObservedPaymentState,
      });
      const { actionId } = await strand('pay_sw_pend_fail', 'PENDING', provider);
      const executesBefore = provider.callCount;

      const summary = await sweepStrandedActions(SWEEP_NOW, { provider });

      assert.equal(provider.callCount, executesBefore);
      assert.equal(summary.resolvedFailed, 1);
      assert.equal((await findActionById(actionId))!.executionStatus, 'FAILED');
    });
  });

  // -- 6: lookup failure ----------------------------------------------------
  describe('provider lookup failure', () => {
    test('a thrown lookup leaves the action safely UNCONFIRMED, never executed', async () => {
      const provider = new MockRecoveryProvider({ defaultOutcome: 'SUCCESS' });
      const { actionId } = await strand('pay_sw_lookupfail', 'EXECUTING', provider);
      const executesBefore = provider.callCount;
      provider.getPaymentStatus = async () => {
        throw new Error('lookup exploded');
      };

      const summary = await sweepStrandedActions(SWEEP_NOW, { provider });

      assert.equal(provider.callCount, executesBefore, 'a failed lookup triggered an execution');
      assert.equal(summary.stillUnconfirmed, 1);
      const action = await findActionById(actionId);
      assert.equal(action!.executionStatus, 'UNCONFIRMED');
    });

    test('a lookup failure message never leaks a credential', async () => {
      const provider = new MockRecoveryProvider({ defaultOutcome: 'SUCCESS' });
      await strand('pay_sw_leak', 'EXECUTING', provider);
      provider.getPaymentStatus = async () => {
        throw new Error('failed with rzp_test_SECRETVALUE1 and Bearer abcdef0123456789tok');
      };

      const summary = await sweepStrandedActions(SWEEP_NOW, { provider });
      const message = summary.items[0]!.message;

      assert.ok(!message.includes('rzp_test_SECRETVALUE1'), 'a Razorpay key leaked');
      assert.ok(!message.includes('abcdef0123456789tok'), 'a bearer token leaked');
      assert.ok(message.includes('[redacted'), 'the message was not scrubbed');
    });

    test('safeSweepMessage scrubs every credential shape', () => {
      for (const raw of [
        'key rzp_test_ABC123xyz',
        'key rzp_live_DEADBEEF1',
        'AIzaSyDUMMYKEY1234567890',
        'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.body.sig',
        'Authorization: Basic dXNlcjpwYXNzd29yZA==',
        '{"api_key":"supersecretvalue"}',
      ]) {
        const out = safeSweepMessage(new Error(raw));
        assert.ok(
          !/rzp_(test|live)_[A-Za-z0-9]{6,}|AIzaSy[A-Za-z0-9]{6,}|eyJhbGciOi|dXNlcjpwYXNz|supersecretvalue/.test(
            out,
          ),
          `credential survived scrubbing: ${out}`,
        );
      }
      assert.equal(safeSweepMessage(new Error('x'.repeat(5000))).length, 300);
    });
  });

  // -- 7-8: idempotency and concurrency -------------------------------------
  describe('sweeper idempotency', () => {
    test('repeated sweeps are idempotent', async () => {
      const provider = new MockRecoveryProvider({
        defaultOutcome: 'SUCCESS',
        observedState: 'SUCCEEDED',
      });
      const { actionId } = await strand('pay_sw_repeat', 'EXECUTING', provider);
      const executesBefore = provider.callCount;

      const first = await sweepStrandedActions(SWEEP_NOW, { provider });
      const second = await sweepStrandedActions(SWEEP_NOW, { provider });
      const third = await sweepStrandedActions(SWEEP_NOW, { provider });

      assert.equal(provider.callCount, executesBefore, 'a repeated sweep executed something');
      assert.equal(first.found, 1);
      // Once resolved, the action is no longer stranded, so later passes find
      // nothing — the sweep is naturally self-limiting.
      assert.equal(second.found, 0);
      assert.equal(third.found, 0);
      assert.equal((await findActionById(actionId))!.executionStatus, 'SUCCESS');
    });

    test('CONCURRENT sweeps resolve an action exactly once', async () => {
      const provider = new MockRecoveryProvider({
        defaultOutcome: 'SUCCESS',
        observedState: 'SUCCEEDED',
      });
      const { actionId, caseId } = await strand('pay_sw_conc', 'EXECUTING', provider);
      const executesBefore = provider.callCount;

      // The state-pinned UPDATE, not the sweeper, arbitrates.
      const results = await Promise.all([
        sweepStrandedActions(SWEEP_NOW, { provider }),
        sweepStrandedActions(SWEEP_NOW, { provider }),
        sweepStrandedActions(SWEEP_NOW, { provider }),
      ]);

      assert.equal(provider.callCount, executesBefore, 'concurrent sweeps executed something');
      const resolvedCount = results.reduce((n, r) => n + r.resolvedSuccess + r.resolvedFailed, 0);
      assert.equal(resolvedCount, 1, 'more than one sweep claimed the resolution');
      assert.equal((await findActionById(actionId))!.executionStatus, 'SUCCESS');
      // No duplicate action rows were created.
      assert.equal((await listActionsForCase(caseId)).length, 1);
    });

    test('an already-terminal action is never swept', async () => {
      // A normal, healthy execution must be invisible to the sweeper.
      const provider = new MockRecoveryProvider({
        defaultOutcome: 'SUCCESS',
        observedState: 'SUCCEEDED',
      });
      await seedPayment('pay_sw_healthy');
      await runBatchRecovery(
        { merchantId: MERCHANT },
        { provider: new MockAIProvider(), recoveryProvider: provider, config: CONFIG },
      );
      const executesBefore = provider.callCount;

      const summary = await sweepStrandedActions(SWEEP_NOW, { provider });

      assert.equal(summary.found, 0, 'the sweeper picked up a completed action');
      assert.equal(provider.callCount, executesBefore);
    });

    test('the age floor protects an in-flight execution', async () => {
      // A row younger than minAgeSeconds may belong to a live execution.
      const provider = new MockRecoveryProvider({ observedState: 'SUCCEEDED' });
      await strand('pay_sw_young', 'EXECUTING', provider);

      const summary = await sweepStrandedActions({ minAgeSeconds: 3600, limit: 100 }, { provider });

      assert.equal(summary.found, 0, 'a freshly stranded action was swept');
    });
  });

  // -- 9-11: no regressions -------------------------------------------------
  describe('existing behaviour is unchanged', () => {
    test('a normal execution still completes and verifies', async () => {
      const provider = new MockRecoveryProvider({
        defaultOutcome: 'SUCCESS',
        observedState: 'SUCCEEDED',
      });
      await seedPayment('pay_sw_normal');
      const run = await runBatchRecovery(
        { merchantId: MERCHANT },
        { provider: new MockAIProvider(), recoveryProvider: provider, config: CONFIG },
      );

      assert.equal(provider.callCount, 1, 'the normal path stopped executing');
      assert.equal(run.items[0]!.status, 'RECOVERED');
      assert.equal(run.items[0]!.verificationStatus, 'VERIFIED');
    });

    test('batch re-run protection still holds after a sweep', async () => {
      // The sweeper resolves the action to a terminal state; the batch layer's
      // eligibility screen must still treat the payment as already attempted.
      const provider = new MockRecoveryProvider({
        defaultOutcome: 'SUCCESS',
        observedState: 'FAILED' as ObservedPaymentState,
      });
      await strand('pay_sw_rerun', 'EXECUTING', provider);
      await sweepStrandedActions(SWEEP_NOW, { provider });
      const executesBefore = provider.callCount;

      const rerun = await runBatchRecovery(
        { merchantId: MERCHANT },
        { provider: new MockAIProvider(), recoveryProvider: provider, config: CONFIG },
      );

      assert.equal(provider.callCount, executesBefore, 'batch re-executed a swept payment');
      assert.equal(rerun.items[0]!.status, 'SKIPPED_DUPLICATE');
    });

    test('audit events are written once per resolution, not duplicated', async () => {
      const provider = new MockRecoveryProvider({
        defaultOutcome: 'SUCCESS',
        observedState: 'SUCCEEDED',
      });
      await strand('pay_sw_audit', 'EXECUTING', provider);

      // Scoped by TIMESTAMP, not just payment id. audit_events is append-only
      // and deliberately has no cascading delete, so events from earlier runs
      // of this suite survive cleanFixtures and would inflate a naive count.
      const since = new Date();
      const sweeperEvents = async () =>
        (await listAuditEventsForPayment('pay_sw_audit')).filter(
          (e) => e.actor === 'recoverai-sweeper' && e.createdAt >= since,
        );

      await sweepStrandedActions(SWEEP_NOW, { provider });
      const afterFirst = await sweeperEvents();
      await sweepStrandedActions(SWEEP_NOW, { provider });
      const afterSecond = await sweeperEvents();

      assert.equal(afterFirst.length, 1, 'the sweep did not write exactly one audit event');
      assert.equal(
        afterSecond.length,
        afterFirst.length,
        'a second sweep duplicated the audit event',
      );
      // The event records HOW it was resolved, so an auditor can distinguish a
      // swept resolution from a live execution.
      assert.equal(afterFirst[0]!.metadata['resolvedBy'], 'state_observation');
      assert.equal(afterFirst[0]!.metadata['note'], 'provider_not_re_executed');
    });

    test('an empty sweep is a well-formed no-op', async () => {
      const summary = await sweepStrandedActions(SWEEP_NOW, {
        provider: new MockRecoveryProvider(),
      });
      assert.equal(summary.found, 0);
      assert.deepEqual(summary.items, []);
      assert.equal(summary.failed, 0);
    });

    test('one failing action does not abort the sweep', async () => {
      const provider = new MockRecoveryProvider({ observedState: 'SUCCEEDED' });
      await strand('pay_sw_multi_a', 'EXECUTING', provider);
      await strand('pay_sw_multi_b', 'EXECUTING', provider);
      await strand('pay_sw_multi_c', 'EXECUTING', provider);

      // Fail the lookup for ONE payment only. Targeting by payment id rather
      // than by call count, because verifyRecoveryCase also calls
      // getPaymentStatus — a positional counter would hit the wrong call.
      const original = provider.getPaymentStatus.bind(provider);
      provider.getPaymentStatus = async (id) => {
        if (id === 'pay_sw_multi_b') throw new Error('transient blip');
        return original(id);
      };
      const executesBefore = provider.callCount;

      const summary = await sweepStrandedActions(SWEEP_NOW, { provider });

      assert.equal(summary.found, 3, 'the sweep aborted early');
      assert.equal(summary.items.length, 3, 'not every action produced an item');
      assert.equal(provider.callCount, executesBefore, 'the sweep executed something');
      // The failing lookup is caught inside resolveOne as UNKNOWN ->
      // UNCONFIRMED, which is the safe outcome; the other two still resolve.
      assert.equal(summary.stillUnconfirmed, 1, 'the failed lookup was not left unconfirmed');
      assert.equal(summary.resolvedSuccess, 2, 'the healthy actions did not resolve');
    });
  });
});

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

describe('sweep HTTP — live database', { skip }, () => {
  let app: FastifyInstance;

  before(async () => {
    await runMigrations();
    app = await buildApp({
      provider: new MockAIProvider(),
      recoveryProvider: new MockRecoveryProvider({ observedState: 'SUCCEEDED' }),
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

  test('POST /api/recovery/sweep returns a summary', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/recovery/sweep',
      payload: { min_age_seconds: 0 },
    });

    assert.equal(response.statusCode, 200);
    const body = JSON.parse(response.body) as Record<string, unknown>;
    for (const field of ['found', 'resolved_success', 'still_unconfirmed', 'items']) {
      assert.ok(field in body, `missing field ${field}`);
    }
  });

  test('POST /api/recovery/sweep accepts an empty body', async () => {
    const response = await app.inject({ method: 'POST', url: '/api/recovery/sweep' });
    assert.equal(response.statusCode, 200);
  });

  test('the sweep endpoint rejects an unknown field', async () => {
    // A "force" or "retry" typo must 400, never silently widen behaviour.
    for (const payload of [{ force: true }, { retry: true }, { execute: true }]) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/recovery/sweep',
        payload,
      });
      assert.equal(response.statusCode, 400, `${JSON.stringify(payload)} was accepted`);
    }
  });

  test('the sweep endpoint rejects an out-of-range limit', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/recovery/sweep',
      payload: { limit: 99_999 },
    });
    assert.equal(response.statusCode, 400);
  });

  test('the sweep response leaks no credential', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/recovery/sweep',
      payload: { min_age_seconds: 0 },
    });
    for (const forbidden of ['rzp_test_', 'rzp_live_', 'AIza', 'API_AUTH_TOKEN', 'Bearer ']) {
      assert.ok(!response.body.includes(forbidden), `response leaked "${forbidden}"`);
    }
  });
});

describe('sweep HTTP — authentication', () => {
  const TOKEN = 'sweep-token-0123456789abcdef';

  test('the sweep endpoint requires authentication', async () => {
    const provider = new MockRecoveryProvider();
    let executes = 0;
    const original = provider.executeAction.bind(provider);
    provider.executeAction = async (r) => {
      executes += 1;
      return original(r);
    };

    const app = await buildApp({
      config: loadConfig({ AUTH_ENABLED: 'true', API_AUTH_TOKEN: TOKEN }),
      provider: new MockAIProvider(),
      recoveryProvider: provider,
    });
    await app.ready();

    for (const headers of [{}, { authorization: 'Bearer wrongwrongwrongwrong' }]) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/recovery/sweep',
        headers,
        payload: {},
      });
      assert.equal(response.statusCode, 401, 'the sweep endpoint was reachable unauthenticated');
      assert.ok(!response.body.includes(TOKEN), 'the 401 leaked the token');
    }

    assert.equal(executes, 0, 'an unauthenticated sweep reached the provider');
    await app.close();
  });
});
