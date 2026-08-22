import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { getPool, closePool } from '../src/db/pool.ts';
import { runMigrations } from '../src/db/migrate.ts';
import { buildApp } from '../src/app.ts';
import { loadConfig } from '../src/config/index.ts';
import { insertPayment } from '../src/payments/repository.ts';
import { insertRecoveryCase } from '../src/recovery/repository.ts';
import { listActionsForCase, findActionByIdempotencyKey } from '../src/recovery/action-repository.ts';
import { listAuditEventsForPayment } from '../src/audit/repository.ts';
import { executeRecoveryCase } from '../src/recovery/execute-service.ts';
import { buildIdempotencyKey } from '../src/recovery/executor.ts';
import { MockRecoveryProvider } from '../src/payments/providers/mock.ts';
import { MockAIProvider } from '../src/agents/diagnosis/providers/mock.ts';
import { POLICY_VERSION } from '../src/policies/types.ts';

/**
 * Executor integration tests against REAL PostgreSQL.
 *
 * These skip when RECOVERAI_TEST_DATABASE_URL is unset. The idempotency
 * guarantee is a database guarantee, so testing it without a database would
 * prove nothing.
 */
const TEST_DB_URL = process.env.RECOVERAI_TEST_DATABASE_URL;
const dbAvailable = TEST_DB_URL !== undefined && TEST_DB_URL.length > 0;
if (dbAvailable) process.env.DATABASE_URL = TEST_DB_URL;

const skip = dbAvailable
  ? false
  : 'RECOVERAI_TEST_DATABASE_URL is not set; skipping live executor tests';

const MERCHANT = 'merchant_exec';
const CUSTOMER = 'cust_exec';
const CONFIG = loadConfig();

async function cleanFixtures(): Promise<void> {
  const pool = getPool();
  await pool.query(`DELETE FROM recovery_actions WHERE recovery_case_id LIKE 'rc_ex_%'`);
  await pool.query(`DELETE FROM recovery_cases WHERE id LIKE 'rc_ex_%'`);
  await pool.query(`DELETE FROM payments WHERE id LIKE 'pay_ex_%'`);
}

/** Seed a payment plus an already-analyzed recovery case. */
async function seedCase(options: {
  caseId: string;
  paymentId: string;
  amount?: number;
  attemptCount?: number;
  status?: string;
  action?: 'RETRY' | 'REMINDER' | 'NO_ACTION' | 'ESCALATE';
  confidence?: number;
  caseStatus?: 'OPEN' | 'ESCALATED' | 'AWAITING_APPROVAL';
}): Promise<void> {
  const amount = options.amount ?? 249_900;
  await insertPayment({
    id: options.paymentId,
    merchantId: MERCHANT,
    customerId: CUSTOMER,
    orderId: `ord_${options.paymentId}`,
    amount,
    currency: 'INR',
    status: (options.status ?? 'failed') as 'failed',
    failureReason: options.status === 'captured' ? null : 'gateway_timeout',
    attemptCount: options.attemptCount ?? 0,
    isSubscription: false,
    createdAt: new Date('2026-08-22T10:00:00.000Z'),
  });
  await insertRecoveryCase({
    id: options.caseId,
    paymentId: options.paymentId,
    riskScore: 0.5,
    recoverabilityScore: 0.8,
    classification: 'TEMPORARY_FAILURE',
    recommendedAction: options.action ?? 'RETRY',
    confidence: options.confidence ?? 0.92,
    revenueAtRisk: amount,
    reason: 'seeded for executor test',
    status: options.caseStatus ?? 'OPEN',
  });
}

describe('executor — live database', { skip }, () => {
  let app: FastifyInstance;

  before(async () => {
    await runMigrations();
    const pool = getPool();
    await pool.query(
      `INSERT INTO merchants (id, name, currency) VALUES ($1,'Executor Co','INR')
       ON CONFLICT (id) DO NOTHING`,
      [MERCHANT],
    );
    await pool.query(
      `INSERT INTO customers (id, merchant_id, name, email)
       VALUES ($1,$2,'Exec Person','exec@example.com') ON CONFLICT (id) DO NOTHING`,
      [CUSTOMER, MERCHANT],
    );
    app = await buildApp({
      provider: new MockAIProvider(),
      recoveryProvider: new MockRecoveryProvider(),
    });
    await app.ready();
  });

  after(async () => {
    await cleanFixtures();
    await app?.close();
    await closePool();
  });

  beforeEach(async () => {
    await cleanFixtures();
  });

  // -- successful execution ------------------------------------------------
  describe('authorized execution', () => {
    test('an authorized RETRY reaches the provider and persists SUCCESS', async () => {
      await seedCase({ caseId: 'rc_ex_ok', paymentId: 'pay_ex_ok' });
      const provider = new MockRecoveryProvider({ defaultOutcome: 'SUCCESS' });

      const result = await executeRecoveryCase('rc_ex_ok', { provider, config: CONFIG });

      assert.equal(result.failure, null);
      assert.equal(provider.callCount, 1, 'the provider should have been called exactly once');
      assert.equal(result.execution!.executed, true);
      assert.equal(result.execution!.outcome, 'EXECUTION_SUCCEEDED');

      const actions = await listActionsForCase('rc_ex_ok');
      assert.equal(actions.length, 1);
      assert.equal(actions[0]!.executionStatus, 'SUCCESS');
      assert.equal(actions[0]!.provider, 'mock');
      assert.equal(actions[0]!.policyVersion, POLICY_VERSION);
      assert.ok(actions[0]!.providerReference);
      assert.ok(actions[0]!.executedAt !== null && actions[0]!.completedAt !== null);
    });

    test('the persisted idempotency key matches the documented design', async () => {
      await seedCase({ caseId: 'rc_ex_key', paymentId: 'pay_ex_key' });
      await executeRecoveryCase('rc_ex_key', {
        provider: new MockRecoveryProvider(), config: CONFIG,
      });

      const expected = buildIdempotencyKey('rc_ex_key', 'RETRY', POLICY_VERSION);
      const action = await findActionByIdempotencyKey(expected);
      assert.ok(action, `no action stored under key ${expected}`);
      assert.equal(action.recoveryCaseId, 'rc_ex_key');
    });

    test('the amount is persisted as an exact integer in minor units', async () => {
      await seedCase({ caseId: 'rc_ex_money', paymentId: 'pay_ex_money', amount: 249_901 });
      await executeRecoveryCase('rc_ex_money', {
        provider: new MockRecoveryProvider(), config: CONFIG,
      });
      const actions = await listActionsForCase('rc_ex_money');
      assert.equal(actions[0]!.amount, 249_901);
      assert.equal(typeof actions[0]!.amount, 'number');
      assert.ok(Number.isInteger(actions[0]!.amount));
    });

    test('SUCCESS does not mark the payment recovered', async () => {
      // Provider acknowledgement is not recovery evidence.
      await seedCase({ caseId: 'rc_ex_norec', paymentId: 'pay_ex_norec' });
      const result = await executeRecoveryCase('rc_ex_norec', {
        provider: new MockRecoveryProvider({ defaultOutcome: 'SUCCESS' }), config: CONFIG,
      });

      assert.equal(result.execution!.verified, false, 'nothing may claim verification yet');

      const { rows } = await getPool().query<{ status: string }>(
        `SELECT status FROM payments WHERE id = 'pay_ex_norec'`,
      );
      assert.equal(rows[0]!.status, 'failed', 'the payment status must not have been mutated');

      const { rows: caseRows } = await getPool().query<{ status: string }>(
        `SELECT status FROM recovery_cases WHERE id = 'rc_ex_norec'`,
      );
      assert.notEqual(caseRows[0]!.status, 'RECOVERED');
    });
  });

  // -- refusals -------------------------------------------------------------
  describe('authorization boundary', () => {
    test('a high-value case is refused with zero provider calls', async () => {
      await seedCase({
        caseId: 'rc_ex_hv', paymentId: 'pay_ex_hv',
        amount: 2_500_000, caseStatus: 'AWAITING_APPROVAL',
      });
      const provider = new MockRecoveryProvider();

      const result = await executeRecoveryCase('rc_ex_hv', { provider, config: CONFIG });

      assert.equal(result.execution!.executed, false);
      assert.equal(result.execution!.outcome, 'REFUSED');
      assert.equal(result.execution!.refusalReason, 'REQUIRES_HUMAN_APPROVAL');
      assert.equal(provider.callCount, 0, 'the provider must never be called');

      // No action row implying money movement may exist.
      const actions = await listActionsForCase('rc_ex_hv');
      assert.equal(actions.length, 0);
    });

    test('a blocked case is refused with zero provider calls', async () => {
      await seedCase({
        caseId: 'rc_ex_blocked', paymentId: 'pay_ex_blocked',
        attemptCount: 5, caseStatus: 'ESCALATED',
      });
      const provider = new MockRecoveryProvider();

      const result = await executeRecoveryCase('rc_ex_blocked', { provider, config: CONFIG });

      assert.equal(result.execution!.executed, false);
      assert.equal(result.execution!.outcome, 'REFUSED');
      assert.equal(provider.callCount, 0);
      assert.equal((await listActionsForCase('rc_ex_blocked')).length, 0);
    });

    test('a low-confidence case is refused', async () => {
      await seedCase({
        caseId: 'rc_ex_lowconf', paymentId: 'pay_ex_lowconf', confidence: 0.4,
      });
      const provider = new MockRecoveryProvider();
      const result = await executeRecoveryCase('rc_ex_lowconf', { provider, config: CONFIG });

      assert.equal(result.execution!.executed, false);
      assert.equal(provider.callCount, 0);
    });

    test('a non-executable action is refused even when policy allows it', async () => {
      // NO_ACTION is authorized by policy but no provider can perform it.
      await seedCase({
        caseId: 'rc_ex_noact', paymentId: 'pay_ex_noact', action: 'NO_ACTION',
      });
      const provider = new MockRecoveryProvider();
      const result = await executeRecoveryCase('rc_ex_noact', { provider, config: CONFIG });

      assert.equal(result.execution!.executed, false);
      assert.equal(provider.callCount, 0);
    });

    test('a captured payment cannot be executed against', async () => {
      await seedCase({
        caseId: 'rc_ex_cap', paymentId: 'pay_ex_cap', status: 'captured',
      });
      const provider = new MockRecoveryProvider();
      const result = await executeRecoveryCase('rc_ex_cap', { provider, config: CONFIG });

      assert.equal(result.execution!.executed, false);
      assert.equal(provider.callCount, 0);
    });

    test('a refusal is audited without implying money moved', async () => {
      await seedCase({
        caseId: 'rc_ex_refaudit', paymentId: 'pay_ex_refaudit', amount: 2_500_000,
      });
      await executeRecoveryCase('rc_ex_refaudit', {
        provider: new MockRecoveryProvider(), config: CONFIG,
      });

      const events = await listAuditEventsForPayment('pay_ex_refaudit');
      const refusal = events.find((e) => e.eventType === 'EXECUTION_REFUSED');
      assert.ok(refusal, 'no EXECUTION_REFUSED audit event');
      assert.equal(refusal.metadata.providerCalled, false);
      assert.equal(refusal.metadata.executed, false);
      assert.ok(!events.some((e) => e.eventType === 'EXECUTION_SUCCEEDED'));
    });
  });

  // -- provider failure modes ----------------------------------------------
  describe('provider outcomes', () => {
    test('provider FAILED persists FAILED and records the error', async () => {
      await seedCase({ caseId: 'rc_ex_fail', paymentId: 'pay_ex_fail' });
      const provider = new MockRecoveryProvider({ defaultOutcome: 'FAILED' });

      const result = await executeRecoveryCase('rc_ex_fail', { provider, config: CONFIG });

      assert.equal(result.execution!.executed, true, 'a request WAS sent');
      assert.equal(result.execution!.outcome, 'EXECUTION_FAILED');
      assert.equal(result.execution!.verified, false);

      const actions = await listActionsForCase('rc_ex_fail');
      assert.equal(actions[0]!.executionStatus, 'FAILED');
      assert.ok(actions[0]!.errorMessage);
    });

    test('provider UNKNOWN persists UNCONFIRMED, never FAILED', async () => {
      await seedCase({ caseId: 'rc_ex_unk', paymentId: 'pay_ex_unk' });
      const provider = new MockRecoveryProvider({ defaultOutcome: 'UNKNOWN' });

      const result = await executeRecoveryCase('rc_ex_unk', { provider, config: CONFIG });

      assert.equal(result.execution!.outcome, 'EXECUTION_UNKNOWN');
      assert.equal(result.execution!.executed, true, 'the request was sent');
      assert.equal(result.execution!.verified, false, 'nothing is verified');

      const actions = await listActionsForCase('rc_ex_unk');
      assert.equal(actions.length, 1);
      // The distinction that matters: UNKNOWN is not FAILED.
      assert.equal(actions[0]!.executionStatus, 'UNCONFIRMED');
      assert.notEqual(actions[0]!.executionStatus, 'FAILED');
    });

    test('a thrown provider error is classified UNKNOWN, not FAILED', async () => {
      // A transport error does not prove the remote side did nothing.
      await seedCase({ caseId: 'rc_ex_throw', paymentId: 'pay_ex_throw' });
      const provider = new MockRecoveryProvider({ throwOnCall: true });

      const result = await executeRecoveryCase('rc_ex_throw', { provider, config: CONFIG });

      assert.equal(result.execution!.outcome, 'EXECUTION_UNKNOWN');
      const actions = await listActionsForCase('rc_ex_throw');
      assert.equal(actions[0]!.executionStatus, 'UNCONFIRMED');
      assert.ok(actions[0]!.errorMessage?.includes('provider threw'));
    });

    test('UNKNOWN is never automatically retried', async () => {
      await seedCase({ caseId: 'rc_ex_unkretry', paymentId: 'pay_ex_unkretry' });
      const provider = new MockRecoveryProvider({ defaultOutcome: 'UNKNOWN' });

      await executeRecoveryCase('rc_ex_unkretry', { provider, config: CONFIG });
      assert.equal(provider.callCount, 1);

      // A second attempt must NOT re-send: the key is already owned.
      const second = await executeRecoveryCase('rc_ex_unkretry', { provider, config: CONFIG });
      assert.equal(provider.callCount, 1, 'UNKNOWN must not trigger another provider call');
      assert.equal(second.execution!.executed, false);

      const actions = await listActionsForCase('rc_ex_unkretry');
      assert.equal(actions.length, 1, 'no second action row may be created');
      assert.equal(actions[0]!.executionStatus, 'UNCONFIRMED');
    });

    test('UNKNOWN never claims recovery', async () => {
      await seedCase({ caseId: 'rc_ex_unkclaim', paymentId: 'pay_ex_unkclaim' });
      const result = await executeRecoveryCase('rc_ex_unkclaim', {
        provider: new MockRecoveryProvider({ defaultOutcome: 'UNKNOWN' }), config: CONFIG,
      });
      assert.equal(result.execution!.verified, false);
      const { rows } = await getPool().query<{ status: string }>(
        `SELECT status FROM payments WHERE id = 'pay_ex_unkclaim'`,
      );
      assert.equal(rows[0]!.status, 'failed');
    });
  });

  // -- idempotency ----------------------------------------------------------
  describe('idempotency', () => {
    test('a sequential duplicate does not call the provider twice', async () => {
      await seedCase({ caseId: 'rc_ex_dup', paymentId: 'pay_ex_dup' });
      const provider = new MockRecoveryProvider({ defaultOutcome: 'SUCCESS' });

      const first = await executeRecoveryCase('rc_ex_dup', { provider, config: CONFIG });
      const second = await executeRecoveryCase('rc_ex_dup', { provider, config: CONFIG });

      assert.equal(first.execution!.executed, true);
      assert.equal(second.execution!.executed, false);
      assert.equal(provider.callCount, 1, 'the provider must be called exactly once');
      assert.equal((await listActionsForCase('rc_ex_dup')).length, 1);
    });

    test('the duplicate attempt is audited as skipped', async () => {
      await seedCase({ caseId: 'rc_ex_dupaudit', paymentId: 'pay_ex_dupaudit' });
      const provider = new MockRecoveryProvider();
      await executeRecoveryCase('rc_ex_dupaudit', { provider, config: CONFIG });
      await executeRecoveryCase('rc_ex_dupaudit', { provider, config: CONFIG });

      const events = await listAuditEventsForPayment('pay_ex_dupaudit');
      // The second attempt is refused by policy's DUPLICATE_ACTION rule before
      // it reaches the claim, which is itself correct duplicate protection.
      const blocked =
        events.some((e) => e.eventType === 'EXECUTION_SKIPPED_DUPLICATE') ||
        events.some((e) => e.eventType === 'EXECUTION_REFUSED');
      assert.ok(blocked, 'the duplicate attempt left no audit trace');
      assert.equal(provider.callCount, 1);
    });

    /**
     * THE CONCURRENCY TEST.
     *
     * Two genuinely simultaneous execution attempts for the same logical
     * action. Not sequential, not faked: both promises are created before
     * either is awaited, and the provider is given a delay so both requests
     * are in flight at once.
     *
     * Exactly one may reach the provider. The database's UNIQUE constraint on
     * idempotency_key is the only thing that can guarantee this — application
     * logic cannot, because both callers can read "no existing action".
     */
    test('concurrent duplicate attempts produce exactly one provider call', async () => {
      await seedCase({ caseId: 'rc_ex_conc', paymentId: 'pay_ex_conc' });
      const provider = new MockRecoveryProvider({ defaultOutcome: 'SUCCESS', delayMs: 60 });

      const [a, b] = await Promise.all([
        executeRecoveryCase('rc_ex_conc', { provider, config: CONFIG }),
        executeRecoveryCase('rc_ex_conc', { provider, config: CONFIG }),
      ]);

      assert.equal(provider.callCount, 1, `provider called ${provider.callCount} times, expected 1`);

      const actions = await listActionsForCase('rc_ex_conc');
      assert.equal(actions.length, 1, `${actions.length} action rows created, expected 1`);

      // Exactly one caller executed; the other was stopped.
      const executed = [a, b].filter((r) => r.execution!.executed);
      assert.equal(executed.length, 1, 'exactly one attempt should report executed');

      // The loser must not report success it did not cause.
      const loser = [a, b].find((r) => !r.execution!.executed)!;
      assert.notEqual(loser.execution!.outcome, 'EXECUTION_SUCCEEDED');
    });

    test('higher-concurrency attempts still produce exactly one provider call', async () => {
      await seedCase({ caseId: 'rc_ex_conc5', paymentId: 'pay_ex_conc5' });
      const provider = new MockRecoveryProvider({ defaultOutcome: 'SUCCESS', delayMs: 50 });

      const results = await Promise.all(
        Array.from({ length: 5 }, () =>
          executeRecoveryCase('rc_ex_conc5', { provider, config: CONFIG }),
        ),
      );

      assert.equal(provider.callCount, 1, `provider called ${provider.callCount} times`);
      assert.equal((await listActionsForCase('rc_ex_conc5')).length, 1);
      assert.equal(results.filter((r) => r.execution!.executed).length, 1);
    });
  });

  // -- audit ---------------------------------------------------------------
  describe('audit trail', () => {
    test('a successful execution writes REQUESTED then SUCCEEDED', async () => {
      await seedCase({ caseId: 'rc_ex_audit', paymentId: 'pay_ex_audit' });
      await executeRecoveryCase('rc_ex_audit', {
        provider: new MockRecoveryProvider({ defaultOutcome: 'SUCCESS' }), config: CONFIG,
      });

      const events = await listAuditEventsForPayment('pay_ex_audit');
      const types = events.map((e) => e.eventType);
      assert.ok(types.includes('EXECUTION_REQUESTED'));
      assert.ok(types.includes('EXECUTION_SUCCEEDED'));
      assert.ok(
        types.indexOf('EXECUTION_REQUESTED') < types.indexOf('EXECUTION_SUCCEEDED'),
        'the request must be audited before its result',
      );
    });

    test('audit events carry enough to reconstruct the attempt', async () => {
      await seedCase({ caseId: 'rc_ex_auditmeta', paymentId: 'pay_ex_auditmeta' });
      await executeRecoveryCase('rc_ex_auditmeta', {
        provider: new MockRecoveryProvider(), config: CONFIG,
      });

      const events = await listAuditEventsForPayment('pay_ex_auditmeta');
      const succeeded = events.find((e) => e.eventType === 'EXECUTION_SUCCEEDED')!;
      assert.equal(succeeded.actor, 'recoverai-executor');
      assert.equal(succeeded.metadata.action, 'RETRY');
      assert.equal(succeeded.metadata.policyVersion, POLICY_VERSION);
      assert.equal(succeeded.metadata.provider, 'mock');
      assert.ok(succeeded.metadata.idempotencyKey);
      assert.ok(succeeded.metadata.actionId);
      // The success event must state plainly that recovery is not verified.
      assert.equal(succeeded.metadata.verified, false);
    });

    test('an UNKNOWN execution is audited as UNKNOWN', async () => {
      await seedCase({ caseId: 'rc_ex_auditunk', paymentId: 'pay_ex_auditunk' });
      await executeRecoveryCase('rc_ex_auditunk', {
        provider: new MockRecoveryProvider({ defaultOutcome: 'UNKNOWN' }), config: CONFIG,
      });

      const events = await listAuditEventsForPayment('pay_ex_auditunk');
      const unknown = events.find((e) => e.eventType === 'EXECUTION_UNKNOWN');
      assert.ok(unknown, 'no EXECUTION_UNKNOWN event');
      assert.ok(String(unknown.metadata.note).includes('no_automatic_retry'));
    });

    test('audit events contain no secrets', async () => {
      await seedCase({ caseId: 'rc_ex_auditsec', paymentId: 'pay_ex_auditsec' });
      await executeRecoveryCase('rc_ex_auditsec', {
        provider: new MockRecoveryProvider(), config: CONFIG,
      });
      const events = await listAuditEventsForPayment('pay_ex_auditsec');
      const serialised = JSON.stringify(events);
      for (const secret of ['rzp_live', 'rzp_test', 'sk-ant-', 'password', 'recoverai_test_pw']) {
        assert.ok(!serialised.includes(secret), `audit leaked "${secret}"`);
      }
    });
  });

  // -- API ------------------------------------------------------------------
  describe('POST /api/recovery/:caseId/execute', () => {
    test('returns 200 and an execution result for an authorized case', async () => {
      await seedCase({ caseId: 'rc_ex_api', paymentId: 'pay_ex_api' });

      const response = await app.inject({
        method: 'POST', url: '/api/recovery/rc_ex_api/execute',
      });

      assert.equal(response.statusCode, 200);
      const body = response.json();
      assert.equal(body.executed, true);
      assert.equal(body.outcome, 'EXECUTION_SUCCEEDED');
      assert.equal(body.verified, false, 'the API must not claim verified recovery');
      assert.ok(body.idempotency_key);
      assert.equal(body.action.execution_status, 'SUCCESS');
    });

    test('returns 403 when human approval is required', async () => {
      await seedCase({
        caseId: 'rc_ex_api403', paymentId: 'pay_ex_api403',
        amount: 2_500_000, caseStatus: 'AWAITING_APPROVAL',
      });

      const response = await app.inject({
        method: 'POST', url: '/api/recovery/rc_ex_api403/execute',
      });

      assert.equal(response.statusCode, 403);
      const body = response.json();
      assert.equal(body.executed, false);
      assert.equal(body.refusal_reason, 'REQUIRES_HUMAN_APPROVAL');
      assert.equal(body.action, null);
    });

    test('returns 409 when policy blocks the action', async () => {
      await seedCase({
        caseId: 'rc_ex_api409', paymentId: 'pay_ex_api409',
        attemptCount: 5, caseStatus: 'ESCALATED',
      });

      const response = await app.inject({
        method: 'POST', url: '/api/recovery/rc_ex_api409/execute',
      });

      assert.equal(response.statusCode, 409);
      assert.equal(response.json().executed, false);
    });

    test('returns 404 for an unknown case', async () => {
      const response = await app.inject({
        method: 'POST', url: '/api/recovery/rc_does_not_exist/execute',
      });
      assert.equal(response.statusCode, 404);
    });

    test('rejects a malformed case id', async () => {
      const response = await app.inject({
        method: 'POST', url: '/api/recovery/not%20a%20valid%20id/execute',
      });
      assert.equal(response.statusCode, 400);
    });

    test('a repeated API request does not execute twice', async () => {
      await seedCase({ caseId: 'rc_ex_apidup', paymentId: 'pay_ex_apidup' });

      const first = await app.inject({ method: 'POST', url: '/api/recovery/rc_ex_apidup/execute' });
      const second = await app.inject({ method: 'POST', url: '/api/recovery/rc_ex_apidup/execute' });

      assert.equal(first.json().executed, true);
      assert.equal(second.json().executed, false);
      assert.equal((await listActionsForCase('rc_ex_apidup')).length, 1);
    });

    test('GET /api/recovery/:caseId/actions lists the execution history', async () => {
      await seedCase({ caseId: 'rc_ex_apilist', paymentId: 'pay_ex_apilist' });
      await app.inject({ method: 'POST', url: '/api/recovery/rc_ex_apilist/execute' });

      const response = await app.inject({
        method: 'GET', url: '/api/recovery/rc_ex_apilist/actions',
      });
      assert.equal(response.statusCode, 200);
      const body = response.json();
      assert.equal(body.actions.length, 1);
      assert.equal(body.actions[0].action_type, 'RETRY');
      assert.ok(body.actions[0].idempotency_key);
    });

    test('the API response never leaks a stack trace or credential', async () => {
      await seedCase({ caseId: 'rc_ex_apisec', paymentId: 'pay_ex_apisec' });
      const response = await app.inject({
        method: 'POST', url: '/api/recovery/rc_ex_apisec/execute',
      });
      const raw = response.body;
      assert.ok(!raw.includes('at Object.'));
      assert.ok(!raw.includes('node_modules'));
      assert.ok(!raw.includes('recoverai_test_pw'));
    });
  });
});
