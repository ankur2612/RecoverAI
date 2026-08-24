import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { getPool, closePool } from '../src/db/pool.ts';
import { runMigrations } from '../src/db/migrate.ts';
import { buildApp } from '../src/app.ts';
import { loadConfig } from '../src/config/index.ts';
import { insertPayment, findPaymentById } from '../src/payments/repository.ts';
import { insertRecoveryCase, findCaseById } from '../src/recovery/repository.ts';
import { listActionsForCase } from '../src/recovery/action-repository.ts';
import { listAuditEventsForPayment } from '../src/audit/repository.ts';
import { executeRecoveryCase } from '../src/recovery/execute-service.ts';
import { verifyRecoveryCase } from '../src/recovery/verify-service.ts';
import { MockRecoveryProvider } from '../src/payments/providers/mock.ts';
import { MockAIProvider } from '../src/agents/diagnosis/providers/mock.ts';
import type { ObservedPaymentState } from '../src/payments/provider.ts';

/**
 * Outcome verification against REAL PostgreSQL.
 * Skips when RECOVERAI_TEST_DATABASE_URL is unset.
 */
const TEST_DB_URL = process.env.RECOVERAI_TEST_DATABASE_URL;
const dbAvailable = TEST_DB_URL !== undefined && TEST_DB_URL.length > 0;
if (dbAvailable) process.env.DATABASE_URL = TEST_DB_URL;

const skip = dbAvailable
  ? false
  : 'RECOVERAI_TEST_DATABASE_URL is not set; skipping live verification tests';

const MERCHANT = 'merchant_ver';
const CUSTOMER = 'cust_ver';
const CONFIG = loadConfig();

async function cleanFixtures(): Promise<void> {
  const pool = getPool();
  await pool.query(`DELETE FROM recovery_actions WHERE recovery_case_id LIKE 'rc_vr_%'`);
  await pool.query(`DELETE FROM recovery_cases WHERE id LIKE 'rc_vr_%'`);
  await pool.query(`DELETE FROM payments WHERE id LIKE 'pay_vr_%'`);
}

async function seedCase(caseId: string, paymentId: string, amount = 249_900): Promise<void> {
  await insertPayment({
    id: paymentId, merchantId: MERCHANT, customerId: CUSTOMER, orderId: `ord_${paymentId}`,
    amount, currency: 'INR', status: 'failed', failureReason: 'gateway_timeout',
    attemptCount: 0, isSubscription: false, createdAt: new Date('2026-08-22T10:00:00.000Z'),
  });
  await insertRecoveryCase({
    id: caseId, paymentId, riskScore: 0.5, recoverabilityScore: 0.8,
    classification: 'TEMPORARY_FAILURE', recommendedAction: 'RETRY', confidence: 0.92,
    revenueAtRisk: amount, reason: 'seeded for verification test', status: 'OPEN',
  });
}

/** Execute then verify, with independently controlled provider behaviour. */
async function executeThenVerify(
  caseId: string,
  executionOutcome: 'SUCCESS' | 'FAILED' | 'UNKNOWN',
  observedState: ObservedPaymentState,
) {
  const provider = new MockRecoveryProvider({ defaultOutcome: executionOutcome, observedState });
  const execution = await executeRecoveryCase(caseId, { provider, config: CONFIG });
  const verification = await verifyRecoveryCase(caseId, { provider });
  return { provider, execution, verification };
}

describe('outcome verification — live database', { skip }, () => {
  let app: FastifyInstance;

  before(async () => {
    await runMigrations();
    const pool = getPool();
    await pool.query(
      `INSERT INTO merchants (id, name, currency) VALUES ($1,'Verify Co','INR')
       ON CONFLICT (id) DO NOTHING`, [MERCHANT],
    );
    await pool.query(
      `INSERT INTO customers (id, merchant_id, name, email)
       VALUES ($1,$2,'Verify Person','ver@example.com') ON CONFLICT (id) DO NOTHING`,
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

  describe('migration', () => {
    test('re-running migrations is a no-op', async () => {
      assert.deepEqual(await runMigrations(), []);
    });

    test('verification columns exist', async () => {
      const { rows } = await getPool().query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns WHERE table_name = 'recovery_actions'`,
      );
      const cols = rows.map((r) => r.column_name);
      for (const expected of [
        'verification_status', 'verification_reason', 'verified_at',
        'observed_payment_status', 'verification_evidence', 'verification_attempts',
      ]) {
        assert.ok(cols.includes(expected), `missing column ${expected}`);
      }
    });

    test('AWAITING_VERIFICATION is an accepted case status', async () => {
      const { rows } = await getPool().query<{ d: string }>(
        `SELECT pg_get_constraintdef(oid) d FROM pg_constraint
         WHERE conname = 'recovery_cases_status_check'`,
      );
      assert.ok(rows[0]!.d.includes('AWAITING_VERIFICATION'));
    });

    test('the verification status constraint rejects an invalid value', async () => {
      await seedCase('rc_vr_cons', 'pay_vr_cons');
      await executeThenVerify('rc_vr_cons', 'SUCCESS', 'SUCCEEDED');
      const actions = await listActionsForCase('rc_vr_cons');
      await assert.rejects(
        () => getPool().query(
          `UPDATE recovery_actions SET verification_status = 'PROBABLY_RECOVERED' WHERE id = $1`,
          [actions[0]!.id],
        ),
        (error: { code?: string }) => error.code === '23514',
      );
    });
  });

  describe('execution is not outcome', () => {
    test('execution SUCCESS + payment SUCCEEDED -> VERIFIED', async () => {
      await seedCase('rc_vr_ok', 'pay_vr_ok');
      const { verification, provider } = await executeThenVerify('rc_vr_ok', 'SUCCESS', 'SUCCEEDED');

      assert.equal(verification.verification!.status, 'VERIFIED');
      assert.equal(verification.verification!.recovered, true);
      assert.equal(provider.callCount, 1, 'exactly one execution');
      assert.equal(provider.statusLookupCount, 1, 'exactly one observation');

      const actions = await listActionsForCase('rc_vr_ok');
      assert.equal(actions[0]!.verificationStatus, 'VERIFIED');
      assert.ok(actions[0]!.verifiedAt !== null);
      assert.ok(actions[0]!.verificationEvidence.length >= 2);
    });

    test('execution SUCCESS + payment PENDING -> UNCONFIRMED, not recovered', async () => {
      await seedCase('rc_vr_pending', 'pay_vr_pending');
      const { verification } = await executeThenVerify('rc_vr_pending', 'SUCCESS', 'PENDING');

      assert.equal(verification.verification!.status, 'UNCONFIRMED');
      assert.equal(verification.verification!.recovered, false);

      // The critical assertion: a provider SUCCESS did NOT become recovery.
      assert.equal((await findPaymentById('pay_vr_pending'))!.status, 'failed');
      assert.notEqual((await findCaseById('rc_vr_pending'))!.status, 'RECOVERED');
    });

    test('execution SUCCESS + payment FAILED -> NOT_RECOVERED', async () => {
      await seedCase('rc_vr_sf', 'pay_vr_sf');
      const { verification } = await executeThenVerify('rc_vr_sf', 'SUCCESS', 'FAILED');
      assert.equal(verification.verification!.status, 'NOT_RECOVERED');
      assert.equal((await findCaseById('rc_vr_sf'))!.status, 'FAILED');
    });

    test('a case is AWAITING_VERIFICATION between execution and verification', async () => {
      await seedCase('rc_vr_await', 'pay_vr_await');
      const provider = new MockRecoveryProvider({ defaultOutcome: 'SUCCESS' });
      await executeRecoveryCase('rc_vr_await', { provider, config: CONFIG });

      const mid = await findCaseById('rc_vr_await');
      assert.equal(mid!.status, 'AWAITING_VERIFICATION');
      assert.notEqual(mid!.status, 'RECOVERED', 'execution must not imply recovery');
    });
  });

  describe('UNKNOWN resolution', () => {
    test('UNCONFIRMED execution + payment SUCCEEDED resolves to VERIFIED', async () => {
      await seedCase('rc_vr_unkok', 'pay_vr_unkok');
      const { verification, provider } = await executeThenVerify(
        'rc_vr_unkok', 'UNKNOWN', 'SUCCEEDED',
      );

      assert.equal((await listActionsForCase('rc_vr_unkok'))[0]!.executionStatus, 'UNCONFIRMED');
      assert.equal(verification.verification!.status, 'VERIFIED');
      // Resolved WITHOUT re-executing.
      assert.equal(provider.callCount, 1, 'verification must not re-execute');
      assert.equal(provider.statusLookupCount, 1);
    });

    test('UNCONFIRMED execution + payment PENDING stays UNCONFIRMED', async () => {
      await seedCase('rc_vr_unkpend', 'pay_vr_unkpend');
      const { verification, provider } = await executeThenVerify(
        'rc_vr_unkpend', 'UNKNOWN', 'PENDING',
      );
      assert.equal(verification.verification!.status, 'UNCONFIRMED');
      assert.equal(provider.callCount, 1, 'an ambiguous outcome must not trigger a retry');
      assert.equal((await findCaseById('rc_vr_unkpend'))!.status, 'AWAITING_VERIFICATION');
    });

    test('an unresolvable payment stays UNCONFIRMED and can be revisited', async () => {
      await seedCase('rc_vr_revisit', 'pay_vr_revisit');
      const provider = new MockRecoveryProvider({
        defaultOutcome: 'UNKNOWN', observedState: 'PENDING',
      });
      await executeRecoveryCase('rc_vr_revisit', { provider, config: CONFIG });
      assert.equal((await verifyRecoveryCase('rc_vr_revisit', { provider })).verification!.status, 'UNCONFIRMED');

      // The payment settles later; a second verification resolves it.
      provider.setObservedState('SUCCEEDED');
      const second = await verifyRecoveryCase('rc_vr_revisit', { provider });
      assert.equal(second.verification!.status, 'VERIFIED');
      assert.equal(provider.callCount, 1, 'still no re-execution');

      const actions = await listActionsForCase('rc_vr_revisit');
      assert.equal(actions[0]!.verificationStatus, 'VERIFIED');
      assert.equal(actions[0]!.verificationAttempts, 2);
    });
  });

  describe('failed execution', () => {
    test('a FAILED execution is NOT_RECOVERED and never claims recovery', async () => {
      await seedCase('rc_vr_fail', 'pay_vr_fail');
      // Even with the payment observably succeeded, a rejected request is not
      // a recovery BY THIS ACTION.
      const { verification, provider } = await executeThenVerify(
        'rc_vr_fail', 'FAILED', 'SUCCEEDED',
      );

      assert.equal(verification.verification!.status, 'NOT_RECOVERED');
      assert.equal(verification.verification!.recovered, false);
      assert.equal(provider.statusLookupCount, 0, 'no pointless lookup for a failed execution');
      assert.equal((await findPaymentById('pay_vr_fail'))!.status, 'failed');
    });
  });

  describe('persistence', () => {
    test('evidence persists as structured JSON', async () => {
      await seedCase('rc_vr_ev', 'pay_vr_ev');
      await executeThenVerify('rc_vr_ev', 'SUCCESS', 'SUCCEEDED');

      const evidence = (await listActionsForCase('rc_vr_ev'))[0]!.verificationEvidence;
      assert.ok(Array.isArray(evidence));
      assert.ok(evidence.some((e) => e.type === 'EXECUTION_RESULT'));
      assert.ok(evidence.some((e) => e.type === 'OBSERVED_PAYMENT_STATE'));
      for (const item of evidence) {
        assert.ok(item.observedAt, 'evidence lacks a timestamp');
        assert.ok(item.detail, 'evidence lacks a detail');
      }
    });

    test('verified_at, reason and observed status persist', async () => {
      await seedCase('rc_vr_fields', 'pay_vr_fields');
      await executeThenVerify('rc_vr_fields', 'SUCCESS', 'SUCCEEDED');

      const action = (await listActionsForCase('rc_vr_fields'))[0]!;
      assert.ok(action.verifiedAt instanceof Date);
      assert.ok((action.verificationReason ?? '').length > 0);
      assert.equal(action.observedPaymentStatus, 'captured');
    });

    test('a VERIFIED outcome refreshes the stale payment record', async () => {
      await seedCase('rc_vr_refresh', 'pay_vr_refresh');
      assert.equal((await findPaymentById('pay_vr_refresh'))!.status, 'failed');
      await executeThenVerify('rc_vr_refresh', 'SUCCESS', 'SUCCEEDED');
      assert.equal((await findPaymentById('pay_vr_refresh'))!.status, 'captured');
    });

    test('evidence contains no secrets', async () => {
      await seedCase('rc_vr_sec', 'pay_vr_sec');
      await executeThenVerify('rc_vr_sec', 'SUCCESS', 'SUCCEEDED');
      const serialised = JSON.stringify(
        (await listActionsForCase('rc_vr_sec'))[0]!.verificationEvidence,
      );
      for (const secret of ['rzp_live', 'rzp_test', 'sk-ant-', 'password', 'recoverai_test_pw']) {
        assert.ok(!serialised.includes(secret), `evidence leaked "${secret}"`);
      }
    });
  });

  describe('idempotency', () => {
    test('repeating verification returns the same verdict with no provider I/O', async () => {
      await seedCase('rc_vr_idem', 'pay_vr_idem');
      const provider = new MockRecoveryProvider({
        defaultOutcome: 'SUCCESS', observedState: 'SUCCEEDED',
      });
      await executeRecoveryCase('rc_vr_idem', { provider, config: CONFIG });

      const first = await verifyRecoveryCase('rc_vr_idem', { provider });
      const lookupsAfterFirst = provider.statusLookupCount;
      const second = await verifyRecoveryCase('rc_vr_idem', { provider });

      assert.equal(first.verification!.status, second.verification!.status);
      assert.equal(second.alreadyVerified, true);
      // A terminal verdict short-circuits: no further provider I/O at all.
      assert.equal(provider.statusLookupCount, lookupsAfterFirst, 'repeat caused a provider call');
    });

    test('repeating verification does not duplicate evidence or attempts', async () => {
      await seedCase('rc_vr_nodup', 'pay_vr_nodup');
      const provider = new MockRecoveryProvider({
        defaultOutcome: 'SUCCESS', observedState: 'SUCCEEDED',
      });
      await executeRecoveryCase('rc_vr_nodup', { provider, config: CONFIG });
      await verifyRecoveryCase('rc_vr_nodup', { provider });
      const afterFirst = (await listActionsForCase('rc_vr_nodup'))[0]!;

      await verifyRecoveryCase('rc_vr_nodup', { provider });
      await verifyRecoveryCase('rc_vr_nodup', { provider });
      const afterThird = (await listActionsForCase('rc_vr_nodup'))[0]!;

      assert.equal(afterThird.verificationEvidence.length, afterFirst.verificationEvidence.length);
      assert.equal(afterThird.verificationAttempts, afterFirst.verificationAttempts);
      assert.equal((await listActionsForCase('rc_vr_nodup')).length, 1);
    });

    test('repeating verification does not duplicate audit events', async () => {
      await seedCase('rc_vr_audup', 'pay_vr_audup');
      const provider = new MockRecoveryProvider({
        defaultOutcome: 'SUCCESS', observedState: 'SUCCEEDED',
      });
      await executeRecoveryCase('rc_vr_audup', { provider, config: CONFIG });
      await verifyRecoveryCase('rc_vr_audup', { provider });
      const first = (await listAuditEventsForPayment('pay_vr_audup'))
        .filter((e) => e.eventType.startsWith('OUTCOME_')).length;

      await verifyRecoveryCase('rc_vr_audup', { provider });
      const second = (await listAuditEventsForPayment('pay_vr_audup'))
        .filter((e) => e.eventType.startsWith('OUTCOME_')).length;

      assert.equal(second, first, 'a repeat verification wrote extra audit events');
    });

    test('a VERIFIED outcome never regresses', async () => {
      await seedCase('rc_vr_noreg', 'pay_vr_noreg');
      const provider = new MockRecoveryProvider({
        defaultOutcome: 'SUCCESS', observedState: 'SUCCEEDED',
      });
      await executeRecoveryCase('rc_vr_noreg', { provider, config: CONFIG });
      await verifyRecoveryCase('rc_vr_noreg', { provider });

      // A flaky later lookup must not undo an evidenced outcome.
      provider.setObservedState('FAILED');
      const again = await verifyRecoveryCase('rc_vr_noreg', { provider });

      assert.equal(again.verification!.status, 'VERIFIED');
      assert.equal((await listActionsForCase('rc_vr_noreg'))[0]!.verificationStatus, 'VERIFIED');
    });
  });

  describe('audit trail', () => {
    test('the full chain is reconstructable', async () => {
      await seedCase('rc_vr_chain', 'pay_vr_chain');
      await executeThenVerify('rc_vr_chain', 'SUCCESS', 'SUCCEEDED');

      const types: string[] = (await listAuditEventsForPayment('pay_vr_chain')).map(
        (e) => e.eventType,
      );
      for (const expected of [
        'EXECUTION_REQUESTED', 'EXECUTION_SUCCEEDED',
        'OUTCOME_VERIFICATION_STARTED', 'OUTCOME_VERIFIED',
      ]) {
        assert.ok(types.includes(expected), `missing ${expected}`);
      }
      assert.ok(
        types.indexOf('EXECUTION_SUCCEEDED') < types.indexOf('OUTCOME_VERIFIED'),
        'verification must be audited after execution',
      );
    });

    test('the verification event records the recovered fact and its basis', async () => {
      await seedCase('rc_vr_meta', 'pay_vr_meta');
      await executeThenVerify('rc_vr_meta', 'SUCCESS', 'SUCCEEDED');

      const event = (await listAuditEventsForPayment('pay_vr_meta'))
        .find((e) => e.eventType === 'OUTCOME_VERIFIED')!;
      assert.equal(event.actor, 'recoverai-verifier');
      assert.equal(event.decision, 'VERIFIED');
      assert.equal(event.metadata.recovered, true);
      assert.equal(event.metadata.observedPaymentState, 'SUCCEEDED');
      assert.ok(event.metadata.actionId);
      assert.ok(event.metadata.reason);
    });

    test('an unconfirmed outcome is audited as unconfirmed', async () => {
      await seedCase('rc_vr_aunk', 'pay_vr_aunk');
      await executeThenVerify('rc_vr_aunk', 'UNKNOWN', 'PENDING');
      const types: string[] = (await listAuditEventsForPayment('pay_vr_aunk')).map(
        (e) => e.eventType,
      );
      assert.ok(types.includes('OUTCOME_UNCONFIRMED'));
      assert.ok(!types.includes('OUTCOME_VERIFIED'));
    });
  });

  describe('POST /api/recovery/:caseId/verify', () => {
    test('returns 200 with a VERIFIED outcome', async () => {
      await seedCase('rc_vr_api', 'pay_vr_api');
      await app.inject({ method: 'POST', url: '/api/recovery/rc_vr_api/execute' });

      const response = await app.inject({ method: 'POST', url: '/api/recovery/rc_vr_api/verify' });
      assert.equal(response.statusCode, 200);
      const body = response.json();
      assert.equal(body.verification_status, 'VERIFIED');
      assert.equal(body.recovered, true);
      assert.equal(body.case_status, 'RECOVERED');
      assert.ok(Array.isArray(body.evidence) && body.evidence.length >= 2);
      assert.ok(body.verified_at);
    });

    test('returns 409 when nothing has been executed', async () => {
      await seedCase('rc_vr_apinoexec', 'pay_vr_apinoexec');
      const response = await app.inject({
        method: 'POST', url: '/api/recovery/rc_vr_apinoexec/verify',
      });
      assert.equal(response.statusCode, 409);
      assert.equal(response.json().error, 'no_execution_to_verify');
    });

    test('returns 404 for an unknown case', async () => {
      const response = await app.inject({ method: 'POST', url: '/api/recovery/rc_vr_nosuch/verify' });
      assert.equal(response.statusCode, 404);
    });

    test('rejects a malformed case id', async () => {
      const response = await app.inject({ method: 'POST', url: '/api/recovery/bad%20id/verify' });
      assert.equal(response.statusCode, 400);
    });

    test('a repeated request reports already_verified', async () => {
      await seedCase('rc_vr_apidup', 'pay_vr_apidup');
      await app.inject({ method: 'POST', url: '/api/recovery/rc_vr_apidup/execute' });
      await app.inject({ method: 'POST', url: '/api/recovery/rc_vr_apidup/verify' });

      const second = await app.inject({ method: 'POST', url: '/api/recovery/rc_vr_apidup/verify' });
      assert.equal(second.statusCode, 200);
      assert.equal(second.json().already_verified, true);
    });

    test('verification never executes anything', async () => {
      await seedCase('rc_vr_apinoexec2', 'pay_vr_apinoexec2');
      await app.inject({ method: 'POST', url: '/api/recovery/rc_vr_apinoexec2/verify' });
      assert.equal((await listActionsForCase('rc_vr_apinoexec2')).length, 0);
    });
  });

  describe('business metrics are computable', () => {
    test('verified recoveries are distinguishable from executions', async () => {
      await seedCase('rc_vr_m1', 'pay_vr_m1');
      await seedCase('rc_vr_m2', 'pay_vr_m2');
      await seedCase('rc_vr_m3', 'pay_vr_m3');

      await executeThenVerify('rc_vr_m1', 'SUCCESS', 'SUCCEEDED'); // recovered
      await executeThenVerify('rc_vr_m2', 'SUCCESS', 'PENDING');   // unresolved
      await executeThenVerify('rc_vr_m3', 'SUCCESS', 'FAILED');    // not recovered

      const { rows } = await getPool().query<{
        executions: string; verified: string; not_recovered: string;
        unresolved: string; recovered_amount: string;
      }>(
        `SELECT
           COUNT(*) FILTER (WHERE execution_status = 'SUCCESS')::text AS executions,
           COUNT(*) FILTER (WHERE verification_status = 'VERIFIED')::text AS verified,
           COUNT(*) FILTER (WHERE verification_status = 'NOT_RECOVERED')::text AS not_recovered,
           COUNT(*) FILTER (WHERE verification_status = 'UNCONFIRMED')::text AS unresolved,
           COALESCE(SUM(amount) FILTER (WHERE verification_status = 'VERIFIED'), 0)::text
             AS recovered_amount
         FROM recovery_actions WHERE recovery_case_id LIKE 'rc_vr_m%'`,
      );

      const m = rows[0]!;
      assert.equal(Number(m.executions), 3, 'three provider successes');
      // The whole point: 3 successful executions, only 1 recovery.
      assert.equal(Number(m.verified), 1);
      assert.equal(Number(m.not_recovered), 1);
      assert.equal(Number(m.unresolved), 1);
      assert.equal(Number(m.recovered_amount), 249_900, 'only verified money counts');
    });
  });
});
