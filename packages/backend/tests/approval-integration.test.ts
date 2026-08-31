import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { getPool, closePool } from '../src/db/pool.ts';
import { runMigrations } from '../src/db/migrate.ts';
import { buildApp } from '../src/app.ts';
import { loadConfig } from '../src/config/index.ts';
import { insertPayment } from '../src/payments/repository.ts';
import { insertRecoveryCase, findCaseById } from '../src/recovery/repository.ts';
import { listActionsForCase } from '../src/recovery/action-repository.ts';
import { listAuditEventsForPayment } from '../src/audit/repository.ts';
import {
  approveRecoveryCase,
  rejectRecoveryCase,
} from '../src/recovery/approval-service.ts';
import { findDecisionForCase } from '../src/recovery/approval-repository.ts';
import { executeRecoveryCase } from '../src/recovery/execute-service.ts';
import { MockRecoveryProvider } from '../src/payments/providers/mock.ts';
import { MockAIProvider } from '../src/agents/diagnosis/providers/mock.ts';

/**
 * APPROVAL WORKFLOW against REAL PostgreSQL.
 *
 * The property under test throughout: approving a case NEVER moves money.
 * Almost every test asserts the provider's execute count.
 *
 * All credentials here are fake. No real provider is contacted.
 */
const TEST_DB_URL = process.env.RECOVERAI_TEST_DATABASE_URL;
const dbAvailable = TEST_DB_URL !== undefined && TEST_DB_URL.length > 0;
if (dbAvailable) process.env.DATABASE_URL = TEST_DB_URL;

const skip = dbAvailable
  ? false
  : 'RECOVERAI_TEST_DATABASE_URL is not set; skipping live approval tests';

const MERCHANT = 'merchant_appr';
const CUSTOMER = 'cust_appr';
const CONFIG = loadConfig({});
const ACTOR = { actor: 'test:operator' };

/** Above POLICY_HIGH_VALUE_THRESHOLD, so policy gates it on approval. */
const HIGH_VALUE = 2_500_000;

async function cleanFixtures(): Promise<void> {
  const pool = getPool();
  await pool.query(
    `DELETE FROM recovery_approvals WHERE recovery_case_id IN
       (SELECT id FROM recovery_cases WHERE payment_id LIKE 'pay_ap_%')`,
  );
  await pool.query(
    `DELETE FROM recovery_actions WHERE recovery_case_id IN
       (SELECT id FROM recovery_cases WHERE payment_id LIKE 'pay_ap_%')`,
  );
  await pool.query(`DELETE FROM recovery_cases WHERE payment_id LIKE 'pay_ap_%'`);
  // audit_events is append-only; removing the payment cascades to its events.
  await pool.query(`DELETE FROM payments WHERE id LIKE 'pay_ap_%'`);
}

/**
 * Seed a payment plus a case ALREADY in AWAITING_APPROVAL.
 *
 * Seeded directly rather than via analyze, so each test controls the exact
 * starting state. The amount is high-value, so a later policy re-evaluation
 * genuinely raises the approval gate the human is satisfying.
 */
async function seedAwaitingApproval(options: {
  paymentId: string;
  caseId: string;
  amount?: number;
  status?: 'failed' | 'captured';
  attemptCount?: number;
  action?: 'RETRY' | 'REMINDER';
  caseStatus?: 'AWAITING_APPROVAL' | 'OPEN' | 'RECOVERED';
}): Promise<void> {
  const amount = options.amount ?? HIGH_VALUE;
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
    confidence: 0.92,
    revenueAtRisk: amount,
    reason: 'seeded for approval test',
    status: (options.caseStatus ?? 'AWAITING_APPROVAL') as 'AWAITING_APPROVAL',
  });
}

function execDeps(provider: MockRecoveryProvider) {
  return { provider, config: CONFIG };
}

describe('approval workflow — live database', { skip }, () => {
  before(async () => {
    await runMigrations();
    const pool = getPool();
    await pool.query(
      `INSERT INTO merchants (id, name, currency) VALUES ($1,'Approval Co','INR')
       ON CONFLICT (id) DO NOTHING`,
      [MERCHANT],
    );
    await pool.query(
      `INSERT INTO customers (id, merchant_id, name, email)
       VALUES ($1,$2,'Appr Person','appr@example.com') ON CONFLICT (id) DO NOTHING`,
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

  // -- migration ------------------------------------------------------------
  describe('migration', () => {
    test('re-running migrations is a no-op', async () => {
      assert.deepEqual(await runMigrations(), []);
    });

    test('the approvals table exists with the expected columns', async () => {
      const { rows } = await getPool().query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
         WHERE table_name = 'recovery_approvals'`,
      );
      const cols = rows.map((r) => r.column_name);
      for (const expected of [
        'id', 'recovery_case_id', 'decision', 'actor', 'reason',
        'approved_action', 'policy_version', 'created_at',
      ]) {
        assert.ok(cols.includes(expected), `missing column ${expected}`);
      }
    });

    test('APPROVED and REJECTED are accepted case statuses', async () => {
      const { rows } = await getPool().query<{ d: string }>(
        `SELECT pg_get_constraintdef(oid) d FROM pg_constraint
         WHERE conname = 'recovery_cases_status_check'`,
      );
      assert.ok(rows[0]!.d.includes('APPROVED'));
      assert.ok(rows[0]!.d.includes('REJECTED'));
    });

    test('an invalid decision value is rejected by the database', async () => {
      await seedAwaitingApproval({ paymentId: 'pay_ap_cons', caseId: 'rc_ap_cons' });
      await assert.rejects(
        () =>
          getPool().query(
            `INSERT INTO recovery_approvals (id, recovery_case_id, decision, actor, approved_action)
             VALUES ('rap_bad', 'rc_ap_cons', 'MAYBE', 'x', 'RETRY')`,
          ),
        (error: { code?: string }) => error.code === '23514',
      );
    });

    test('a second decision for one case is rejected by the unique index', async () => {
      await seedAwaitingApproval({ paymentId: 'pay_ap_uniq', caseId: 'rc_ap_uniq' });
      await approveRecoveryCase('rc_ap_uniq', {}, ACTOR);
      await assert.rejects(
        () =>
          getPool().query(
            `INSERT INTO recovery_approvals (id, recovery_case_id, decision, actor, approved_action)
             VALUES ('rap_dup', 'rc_ap_uniq', 'REJECTED', 'x', 'RETRY')`,
          ),
        (error: { code?: string }) => error.code === '23505',
      );
    });
  });

  // -- the decision ---------------------------------------------------------
  describe('recording a decision', () => {
    test('approving a valid AWAITING_APPROVAL case succeeds', async () => {
      await seedAwaitingApproval({ paymentId: 'pay_ap_ok', caseId: 'rc_ap_ok' });

      const result = await approveRecoveryCase('rc_ap_ok', { reason: 'reviewed' }, ACTOR);

      assert.equal(result.failure, null);
      assert.equal(result.recorded, true);
      assert.equal(result.approval!.decision, 'APPROVED');
      assert.equal(result.approval!.actor, 'test:operator');
      assert.equal(result.approval!.reason, 'reviewed');
      // The case moves to a HUMAN-decision state, not an authorization state.
      assert.equal((await findCaseById('rc_ap_ok'))!.status, 'APPROVED');
    });

    test('rejecting a valid case succeeds and is terminal', async () => {
      await seedAwaitingApproval({ paymentId: 'pay_ap_rej', caseId: 'rc_ap_rej' });

      const result = await rejectRecoveryCase('rc_ap_rej', { reason: 'not worth it' }, ACTOR);

      assert.equal(result.failure, null);
      assert.equal(result.approval!.decision, 'REJECTED');
      assert.equal((await findCaseById('rc_ap_rej'))!.status, 'REJECTED');
    });

    test('a missing case is reported, not created', async () => {
      const result = await approveRecoveryCase('rc_ap_nope', {}, ACTOR);
      assert.equal(result.failure, 'CASE_NOT_FOUND');
      assert.equal(result.approval, null);
    });

    test('a case not awaiting approval cannot be decided', async () => {
      for (const status of ['OPEN', 'RECOVERED'] as const) {
        await cleanFixtures();
        await seedAwaitingApproval({
          paymentId: `pay_ap_st_${status}`,
          caseId: `rc_ap_st_${status}`,
          caseStatus: status,
        });
        const result = await approveRecoveryCase(`rc_ap_st_${status}`, {}, ACTOR);
        assert.equal(result.failure, 'CASE_NOT_AWAITING_APPROVAL', `${status} was decidable`);
        assert.equal(await findDecisionForCase(`rc_ap_st_${status}`), null);
      }
    });

    test('rejecting a case not awaiting approval is refused too', async () => {
      await seedAwaitingApproval({
        paymentId: 'pay_ap_rejwrong',
        caseId: 'rc_ap_rejwrong',
        caseStatus: 'OPEN',
      });
      const result = await rejectRecoveryCase('rc_ap_rejwrong', {}, ACTOR);
      assert.equal(result.failure, 'CASE_NOT_AWAITING_APPROVAL');
    });

    test('a decision naming the wrong action is refused', async () => {
      // Guards against an approval meant for one action applying to another.
      await seedAwaitingApproval({
        paymentId: 'pay_ap_mismatch',
        caseId: 'rc_ap_mismatch',
        action: 'RETRY',
      });
      const result = await approveRecoveryCase(
        'rc_ap_mismatch',
        { expectedAction: 'REMINDER' },
        ACTOR,
      );
      assert.equal(result.failure, 'ACTION_MISMATCH');
      assert.equal(await findDecisionForCase('rc_ap_mismatch'), null);
    });
  });

  // -- idempotency and mutual exclusion -------------------------------------
  describe('idempotency', () => {
    test('a duplicate approval does not create a second decision', async () => {
      await seedAwaitingApproval({ paymentId: 'pay_ap_dup', caseId: 'rc_ap_dup' });

      const first = await approveRecoveryCase('rc_ap_dup', { reason: 'one' }, ACTOR);
      const second = await approveRecoveryCase('rc_ap_dup', { reason: 'two' }, ACTOR);

      assert.equal(first.recorded, true);
      assert.equal(second.recorded, false);
      assert.equal(second.failure, 'ALREADY_DECIDED');
      // The FIRST decision stands, with its original reason.
      assert.equal((await findDecisionForCase('rc_ap_dup'))!.reason, 'one');
      const { rows } = await getPool().query<{ c: string }>(
        `SELECT COUNT(*)::text AS c FROM recovery_approvals WHERE recovery_case_id = 'rc_ap_dup'`,
      );
      assert.equal(rows[0]!.c, '1');
    });

    test('a duplicate rejection does not create a second decision', async () => {
      await seedAwaitingApproval({ paymentId: 'pay_ap_dupr', caseId: 'rc_ap_dupr' });
      await rejectRecoveryCase('rc_ap_dupr', {}, ACTOR);
      const second = await rejectRecoveryCase('rc_ap_dupr', {}, ACTOR);
      assert.equal(second.recorded, false);
      assert.equal(second.failure, 'ALREADY_DECIDED');
    });

    test('a rejection cannot be overturned by a later approval', async () => {
      // The safety-relevant direction: "no" must not become "yes" quietly.
      await seedAwaitingApproval({ paymentId: 'pay_ap_flip', caseId: 'rc_ap_flip' });
      await rejectRecoveryCase('rc_ap_flip', { reason: 'no' }, ACTOR);

      const flip = await approveRecoveryCase('rc_ap_flip', { reason: 'actually yes' }, ACTOR);

      assert.equal(flip.recorded, false);
      assert.equal((await findDecisionForCase('rc_ap_flip'))!.decision, 'REJECTED');
      assert.equal((await findCaseById('rc_ap_flip'))!.status, 'REJECTED');
    });

    test('an approval cannot be overturned by a later rejection', async () => {
      await seedAwaitingApproval({ paymentId: 'pay_ap_flip2', caseId: 'rc_ap_flip2' });
      await approveRecoveryCase('rc_ap_flip2', {}, ACTOR);
      const flip = await rejectRecoveryCase('rc_ap_flip2', {}, ACTOR);
      assert.equal(flip.recorded, false);
      assert.equal((await findDecisionForCase('rc_ap_flip2'))!.decision, 'APPROVED');
    });

    test('CONCURRENT approvals record exactly one decision', async () => {
      await seedAwaitingApproval({ paymentId: 'pay_ap_conc', caseId: 'rc_ap_conc' });

      // The database, not the service, arbitrates.
      const results = await Promise.all([
        approveRecoveryCase('rc_ap_conc', { reason: 'a' }, ACTOR),
        approveRecoveryCase('rc_ap_conc', { reason: 'b' }, ACTOR),
        approveRecoveryCase('rc_ap_conc', { reason: 'c' }, ACTOR),
      ]);

      assert.equal(results.filter((r) => r.recorded).length, 1, 'more than one decision recorded');
      const { rows } = await getPool().query<{ c: string }>(
        `SELECT COUNT(*)::text AS c FROM recovery_approvals WHERE recovery_case_id = 'rc_ap_conc'`,
      );
      assert.equal(rows[0]!.c, '1');
    });

    test('CONCURRENT approve and reject resolve to exactly one decision', async () => {
      await seedAwaitingApproval({ paymentId: 'pay_ap_race', caseId: 'rc_ap_race' });

      const results = await Promise.all([
        approveRecoveryCase('rc_ap_race', {}, ACTOR),
        rejectRecoveryCase('rc_ap_race', {}, ACTOR),
      ]);

      assert.equal(results.filter((r) => r.recorded).length, 1);
      const decision = await findDecisionForCase('rc_ap_race');
      assert.ok(decision !== null);
      // Whichever won, the case status must match it — never disagree.
      assert.equal((await findCaseById('rc_ap_race'))!.status, decision.decision);
    });
  });

  // -- APPROVAL PERFORMS NO PROVIDER CALL -----------------------------------
  describe('approval moves no money', () => {
    test('approving performs ZERO provider calls', async () => {
      await seedAwaitingApproval({ paymentId: 'pay_ap_zero', caseId: 'rc_ap_zero' });
      const provider = new MockRecoveryProvider();

      await approveRecoveryCase('rc_ap_zero', { reason: 'go' }, ACTOR);

      assert.equal(provider.callCount, 0, 'approval executed an action');
      assert.equal(provider.statusLookupCount, 0, 'approval contacted the provider');
      // And no action row was created.
      assert.equal((await listActionsForCase('rc_ap_zero')).length, 0);
    });

    test('rejecting performs ZERO provider calls', async () => {
      await seedAwaitingApproval({ paymentId: 'pay_ap_zero2', caseId: 'rc_ap_zero2' });
      const provider = new MockRecoveryProvider();

      await rejectRecoveryCase('rc_ap_zero2', {}, ACTOR);

      assert.equal(provider.callCount, 0);
      assert.equal((await listActionsForCase('rc_ap_zero2')).length, 0);
    });
  });

  // -- REVALIDATION: the heart of the phase ---------------------------------
  describe('execution re-validates after approval', () => {
    test('an approved case CAN execute when current policy allows it', async () => {
      await seedAwaitingApproval({ paymentId: 'pay_ap_exec', caseId: 'rc_ap_exec' });
      await approveRecoveryCase('rc_ap_exec', { reason: 'approved' }, ACTOR);
      const provider = new MockRecoveryProvider({
        defaultOutcome: 'SUCCESS',
        observedState: 'SUCCEEDED',
      });

      const result = await executeRecoveryCase('rc_ap_exec', execDeps(provider));

      assert.equal(result.policyDecision, 'ALLOWED', 'approval did not satisfy the gate');
      assert.equal(provider.callCount, 1, 'the approved action did not execute');
      assert.equal(result.execution!.refusalReason, null);
    });

    test('WITHOUT approval the same case is refused', async () => {
      // The control: the gate is real, and only the human decision clears it.
      await seedAwaitingApproval({ paymentId: 'pay_ap_noappr', caseId: 'rc_ap_noappr' });
      const provider = new MockRecoveryProvider();

      const result = await executeRecoveryCase('rc_ap_noappr', execDeps(provider));

      assert.equal(provider.callCount, 0, 'an unapproved high-value action executed');
      assert.equal(result.execution!.refusalReason, 'REQUIRES_HUMAN_APPROVAL');
    });

    test('a REJECTED case can never execute', async () => {
      await seedAwaitingApproval({ paymentId: 'pay_ap_rejexec', caseId: 'rc_ap_rejexec' });
      await rejectRecoveryCase('rc_ap_rejexec', { reason: 'no' }, ACTOR);
      const provider = new MockRecoveryProvider();

      const result = await executeRecoveryCase('rc_ap_rejexec', execDeps(provider));

      assert.equal(provider.callCount, 0, 'a rejected case executed');
      assert.equal(result.failure, 'CASE_NOT_ACTIONABLE');
      assert.equal((await listActionsForCase('rc_ap_rejexec')).length, 0);
    });

    test('approval does NOT survive the payment becoming captured', async () => {
      // The stale-approval case. A human approved a recovery; the payment has
      // since been collected. Executing would be a duplicate charge.
      await seedAwaitingApproval({ paymentId: 'pay_ap_cap', caseId: 'rc_ap_cap' });
      await approveRecoveryCase('rc_ap_cap', {}, ACTOR);
      await getPool().query(`UPDATE payments SET status = 'captured' WHERE id = 'pay_ap_cap'`);
      const provider = new MockRecoveryProvider();

      const result = await executeRecoveryCase('rc_ap_cap', execDeps(provider));

      assert.equal(provider.callCount, 0, 'an approved but already-captured payment was retried');
      assert.notEqual(result.execution?.refusalReason ?? result.failure, null);
    });

    test('approval does NOT survive an exhausted retry budget', async () => {
      await seedAwaitingApproval({
        paymentId: 'pay_ap_maxed',
        caseId: 'rc_ap_maxed',
        attemptCount: 99,
      });
      await approveRecoveryCase('rc_ap_maxed', {}, ACTOR);
      const provider = new MockRecoveryProvider();

      const result = await executeRecoveryCase('rc_ap_maxed', execDeps(provider));

      assert.equal(provider.callCount, 0, 'an approved retry exceeded the ceiling');
      // BLOCKED, not ALLOWED: a failure rule outranks the human decision.
      assert.equal(result.policyDecision, 'BLOCKED');
    });

    test('approval does NOT survive a duplicate action appearing', async () => {
      await seedAwaitingApproval({ paymentId: 'pay_ap_dupact', caseId: 'rc_ap_dupact' });
      await approveRecoveryCase('rc_ap_dupact', {}, ACTOR);
      const provider = new MockRecoveryProvider({
        defaultOutcome: 'SUCCESS',
        observedState: 'FAILED',
      });

      // First execution creates the action.
      await executeRecoveryCase('rc_ap_dupact', execDeps(provider));
      const callsAfterFirst = provider.callCount;

      // Second attempt: a duplicate now exists.
      const second = await executeRecoveryCase('rc_ap_dupact', execDeps(provider));

      assert.equal(provider.callCount, callsAfterFirst, 'an approved case executed twice');
      assert.equal((await listActionsForCase('rc_ap_dupact')).length, 1);
      assert.notEqual(second.policyDecision, 'ALLOWED');
    });

    test('the approval is not consulted for a DIFFERENT action', async () => {
      // The case is re-analysed into another action; the old approval must not
      // carry over to it.
      await seedAwaitingApproval({
        paymentId: 'pay_ap_switch',
        caseId: 'rc_ap_switch',
        action: 'RETRY',
      });
      await approveRecoveryCase('rc_ap_switch', {}, ACTOR);
      await getPool().query(
        `UPDATE recovery_cases SET recommended_action = 'REMINDER' WHERE id = 'rc_ap_switch'`,
      );
      const provider = new MockRecoveryProvider();

      const result = await executeRecoveryCase('rc_ap_switch', execDeps(provider));

      assert.equal(provider.callCount, 0, 'an approval carried over to a different action');
      assert.notEqual(result.execution?.refusalReason ?? result.failure, null);
    });

    test('the stored policy verdict is never reused — policy re-runs', async () => {
      // Tightening configuration after approval must still take effect.
      await seedAwaitingApproval({ paymentId: 'pay_ap_cfg', caseId: 'rc_ap_cfg' });
      await approveRecoveryCase('rc_ap_cfg', {}, ACTOR);
      const provider = new MockRecoveryProvider();

      const strict = loadConfig({ POLICY_MIN_RECOVERY_CONFIDENCE: '0.99' });
      const result = await executeRecoveryCase('rc_ap_cfg', { provider, config: strict });

      // Case confidence is 0.92, below the new 0.99 floor.
      assert.equal(provider.callCount, 0, 'a stale approval bypassed the new policy');
      assert.equal(result.policyDecision, 'BLOCKED');
    });
  });

  // -- audit ----------------------------------------------------------------
  describe('audit', () => {
    test('an approval writes exactly one audit event with the actor', async () => {
      await seedAwaitingApproval({ paymentId: 'pay_ap_audit', caseId: 'rc_ap_audit' });
      const since = new Date();

      await approveRecoveryCase('rc_ap_audit', { reason: 'looks fine' }, ACTOR);

      const events = (await listAuditEventsForPayment('pay_ap_audit')).filter(
        (e) => e.eventType === 'APPROVAL_GRANTED' && e.createdAt >= since,
      );
      assert.equal(events.length, 1);
      assert.equal(events[0]!.actor, 'test:operator');
      assert.equal(events[0]!.decision, 'APPROVED');
      assert.equal(events[0]!.metadata['reason'], 'looks fine');
      assert.equal(
        events[0]!.metadata['note'],
        'human_decision_only_policy_still_authoritative',
      );
    });

    test('a rejection writes exactly one audit event', async () => {
      await seedAwaitingApproval({ paymentId: 'pay_ap_audit2', caseId: 'rc_ap_audit2' });
      const since = new Date();

      await rejectRecoveryCase('rc_ap_audit2', { reason: 'too risky' }, ACTOR);

      const events = (await listAuditEventsForPayment('pay_ap_audit2')).filter(
        (e) => e.eventType === 'APPROVAL_REJECTED' && e.createdAt >= since,
      );
      assert.equal(events.length, 1);
      assert.equal(events[0]!.metadata['reason'], 'too risky');
    });

    test('a duplicate approval writes no second audit event', async () => {
      await seedAwaitingApproval({ paymentId: 'pay_ap_audit3', caseId: 'rc_ap_audit3' });
      const since = new Date();

      await approveRecoveryCase('rc_ap_audit3', {}, ACTOR);
      await approveRecoveryCase('rc_ap_audit3', {}, ACTOR);
      await approveRecoveryCase('rc_ap_audit3', {}, ACTOR);

      const events = (await listAuditEventsForPayment('pay_ap_audit3')).filter(
        (e) => e.eventType === 'APPROVAL_GRANTED' && e.createdAt >= since,
      );
      assert.equal(events.length, 1, 'duplicate approvals duplicated the audit event');
    });

    test('the audit trail contains no credential', async () => {
      await seedAwaitingApproval({ paymentId: 'pay_ap_sec', caseId: 'rc_ap_sec' });
      await approveRecoveryCase('rc_ap_sec', { reason: 'ok' }, ACTOR);

      const serialised = JSON.stringify(await listAuditEventsForPayment('pay_ap_sec'));
      for (const forbidden of ['rzp_test_', 'rzp_live_', 'AIza', 'API_AUTH_TOKEN', 'Bearer ']) {
        assert.ok(!serialised.includes(forbidden), `audit leaked "${forbidden}"`);
      }
    });
  });
});

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

describe('approval HTTP — live database', { skip }, () => {
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

  test('POST approve returns the decision', async () => {
    await seedAwaitingApproval({ paymentId: 'pay_ap_http', caseId: 'rc_ap_http' });

    const response = await app.inject({
      method: 'POST',
      url: '/api/recovery/rc_ap_http/approve',
      payload: { reason: 'reviewed by ops' },
    });

    assert.equal(response.statusCode, 200);
    const body = JSON.parse(response.body) as Record<string, any>;
    assert.equal(body['approval'].decision, 'APPROVED');
    assert.equal(body['recorded'], true);
    // The response states the boundary explicitly.
    assert.match(body['note'], /not authorization/i);
  });

  test('POST reject returns the decision', async () => {
    await seedAwaitingApproval({ paymentId: 'pay_ap_httpr', caseId: 'rc_ap_httpr' });
    const response = await app.inject({
      method: 'POST',
      url: '/api/recovery/rc_ap_httpr/reject',
      payload: {},
    });
    assert.equal(response.statusCode, 200);
    assert.equal((JSON.parse(response.body) as any).approval.decision, 'REJECTED');
  });

  test('deciding a missing case is 404', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/recovery/rc_ap_missing/approve',
      payload: {},
    });
    assert.equal(response.statusCode, 404);
  });

  test('deciding an already-decided case is 409', async () => {
    await seedAwaitingApproval({ paymentId: 'pay_ap_409', caseId: 'rc_ap_409' });
    await app.inject({ method: 'POST', url: '/api/recovery/rc_ap_409/approve', payload: {} });
    const second = await app.inject({
      method: 'POST',
      url: '/api/recovery/rc_ap_409/approve',
      payload: {},
    });
    assert.equal(second.statusCode, 409);
  });

  test('the endpoint rejects a force/override/authorized field', async () => {
    await seedAwaitingApproval({ paymentId: 'pay_ap_force', caseId: 'rc_ap_force' });
    for (const payload of [
      { force: true },
      { authorized: true },
      { override: true },
      { amount: 1 },
      { action: 'RETRY' },
    ]) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/recovery/rc_ap_force/approve',
        payload,
      });
      assert.equal(response.statusCode, 400, `${JSON.stringify(payload)} was accepted`);
    }
    // And none of them recorded a decision.
    assert.equal(await findDecisionForCase('rc_ap_force'), null);
  });

  test('an over-long reason is rejected', async () => {
    await seedAwaitingApproval({ paymentId: 'pay_ap_long', caseId: 'rc_ap_long' });
    const response = await app.inject({
      method: 'POST',
      url: '/api/recovery/rc_ap_long/approve',
      payload: { reason: 'x'.repeat(501) },
    });
    assert.equal(response.statusCode, 400);
  });

  test('the response leaks no credential', async () => {
    await seedAwaitingApproval({ paymentId: 'pay_ap_leak', caseId: 'rc_ap_leak' });
    const response = await app.inject({
      method: 'POST',
      url: '/api/recovery/rc_ap_leak/approve',
      payload: {},
    });
    for (const forbidden of ['rzp_test_', 'rzp_live_', 'AIza', 'API_AUTH_TOKEN', 'Bearer ']) {
      assert.ok(!response.body.includes(forbidden), `response leaked "${forbidden}"`);
    }
  });
});

describe('approval HTTP — authentication', () => {
  const TOKEN = 'approval-token-0123456789abcdef';

  test('approve and reject require authentication', async () => {
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

    for (const url of ['/api/recovery/rc_x/approve', '/api/recovery/rc_x/reject']) {
      for (const headers of [{}, { authorization: 'Bearer wrongwrongwrongwrong' }]) {
        const response = await app.inject({ method: 'POST', url, headers, payload: {} });
        assert.equal(response.statusCode, 401, `${url} was reachable unauthenticated`);
        assert.ok(!response.body.includes(TOKEN), 'the 401 leaked the token');
      }
    }

    assert.equal(executes, 0, 'an unauthenticated decision reached the provider');
    await app.close();
  });
});
