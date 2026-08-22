import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { getPool, closePool } from '../src/db/pool.ts';
import { runMigrations } from '../src/db/migrate.ts';
import {
  insertPayment,
  findPaymentById,
  listPayments,
  getCustomerHistory,
  DuplicatePaymentError,
  MissingReferenceError,
} from '../src/payments/repository.ts';
import {
  insertRecoveryCase,
  findLiveCaseForPayment,
  listRecoveryCases,
  DuplicateOpenCaseError,
} from '../src/recovery/repository.ts';
import { appendAuditEvent, listAuditEventsForPayment } from '../src/audit/repository.ts';
import { analyzePayment } from '../src/recovery/analyze.ts';
import { MockAIProvider } from '../src/agents/diagnosis/providers/mock.ts';
import { buildApp } from '../src/app.ts';
import { loadConfig } from '../src/config/index.ts';
import type { FastifyInstance } from 'fastify';

/**
 * Integration tests against a REAL PostgreSQL instance.
 *
 * These skip automatically when RECOVERAI_TEST_DATABASE_URL is not set, so the
 * suite stays runnable on a machine with no database. When it IS set, these
 * exercise the constraints, triggers, and API paths end to end.
 *
 * Run with:
 *   RECOVERAI_TEST_DATABASE_URL=postgres://user:pass@host:port/db npm test
 */
const TEST_DB_URL = process.env.RECOVERAI_TEST_DATABASE_URL;
const dbAvailable = TEST_DB_URL !== undefined && TEST_DB_URL.length > 0;

if (dbAvailable) process.env.DATABASE_URL = TEST_DB_URL;

const skip = dbAvailable
  ? false
  : 'RECOVERAI_TEST_DATABASE_URL is not set; skipping live database tests';

const MERCHANT = 'merchant_it';
const CUSTOMER = 'cust_it';

/** Remove only rows this suite created, never anything else. */
async function cleanFixtures(): Promise<void> {
  const pool = getPool();
  // audit_events is append-only by trigger, so it is deliberately not cleaned.
  await pool.query(`DELETE FROM recovery_actions WHERE recovery_case_id IN
    (SELECT id FROM recovery_cases WHERE payment_id LIKE 'pay_it_%')`);
  await pool.query(`DELETE FROM recovery_cases WHERE payment_id LIKE 'pay_it_%'`);
  await pool.query(`DELETE FROM payment_ground_truth WHERE payment_id LIKE 'pay_it_%'`);
  await pool.query(`DELETE FROM payments WHERE id LIKE 'pay_it_%'`);
}

describe('integration — live database', { skip }, () => {
  let app: FastifyInstance;

  before(async () => {
    await runMigrations();
    const pool = getPool();
    await pool.query(
      `INSERT INTO merchants (id, name, currency) VALUES ($1,'Integration Co','INR')
       ON CONFLICT (id) DO NOTHING`,
      [MERCHANT],
    );
    await pool.query(
      `INSERT INTO customers (id, merchant_id, name, email)
       VALUES ($1,$2,'IT Person','it@example.com') ON CONFLICT (id) DO NOTHING`,
      [CUSTOMER, MERCHANT],
    );
    app = await buildApp({ provider: new MockAIProvider() });
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

  // -- migrations ---------------------------------------------------------
  describe('migrations', () => {
    test('running migrations again is a no-op', async () => {
      const applied = await runMigrations();
      assert.deepEqual(applied, [], 'a second migration run should apply nothing');
    });

    test('all expected tables exist', async () => {
      const { rows } = await getPool().query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.tables WHERE table_schema='public'`,
      );
      const tables = rows.map((r) => r.table_name);
      for (const expected of [
        'merchants', 'customers', 'payments', 'payment_ground_truth',
        'recovery_cases', 'recovery_actions', 'audit_events', 'schema_migrations',
      ]) {
        assert.ok(tables.includes(expected), `missing table ${expected}`);
      }
    });
  });

  // -- payment persistence ------------------------------------------------
  describe('payment persistence', () => {
    test('inserts and reads back a payment', async () => {
      const created = await insertPayment({
        id: 'pay_it_1', merchantId: MERCHANT, customerId: CUSTOMER, orderId: 'ord_it_1',
        amount: 249_900, currency: 'INR', status: 'failed',
        failureReason: 'gateway_timeout', attemptCount: 0, isSubscription: false,
        createdAt: new Date('2026-08-22T10:00:00.000Z'),
      });
      assert.equal(created.amount, 249_900);

      const found = await findPaymentById('pay_it_1');
      assert.ok(found);
      assert.equal(found.id, 'pay_it_1');
      assert.equal(found.failureReason, 'gateway_timeout');
    });

    test('BIGINT amounts round-trip exactly as numbers', async () => {
      // The money-correctness property: no precision loss, no string leakage.
      for (const amount of [1, 249_900, 100_000_000, Number.MAX_SAFE_INTEGER]) {
        const id = `pay_it_big_${amount}`;
        await insertPayment({
          id, merchantId: MERCHANT, customerId: CUSTOMER, orderId: `ord_${amount}`,
          amount, currency: 'INR', status: 'failed', failureReason: 'gateway_timeout',
          attemptCount: 0, isSubscription: false, createdAt: new Date(),
        });
        const found = await findPaymentById(id);
        assert.equal(typeof found!.amount, 'number', `${amount} came back as ${typeof found!.amount}`);
        assert.equal(found!.amount, amount);
      }
    });

    test('rejects a duplicate payment id', async () => {
      const args = {
        id: 'pay_it_dup', merchantId: MERCHANT, customerId: CUSTOMER, orderId: 'ord_dup',
        amount: 1000, currency: 'INR' as const, status: 'failed' as const,
        failureReason: 'gateway_timeout' as const, attemptCount: 0,
        isSubscription: false, createdAt: new Date(),
      };
      await insertPayment(args);
      await assert.rejects(() => insertPayment(args), DuplicatePaymentError);
    });

    test('rejects an unknown merchant or customer', async () => {
      await assert.rejects(
        () => insertPayment({
          id: 'pay_it_orphan', merchantId: 'no_such_merchant', customerId: CUSTOMER,
          orderId: 'o', amount: 1000, currency: 'INR', status: 'failed',
          failureReason: 'gateway_timeout', attemptCount: 0, isSubscription: false,
          createdAt: new Date(),
        }),
        MissingReferenceError,
      );
    });

    test('database rejects a non-positive amount', async () => {
      await assert.rejects(
        () => getPool().query(
          `INSERT INTO payments (id,merchant_id,customer_id,order_id,amount,currency,status,attempt_count)
           VALUES ('pay_it_neg',$1,$2,'o',-5,'INR','failed',0)`, [MERCHANT, CUSTOMER]),
        (error: { code?: string }) => error.code === '23514',
      );
    });

    test('lists and filters payments', async () => {
      for (const [i, status] of (['failed', 'captured', 'abandoned'] as const).entries()) {
        await insertPayment({
          id: `pay_it_list_${i}`, merchantId: MERCHANT, customerId: CUSTOMER,
          orderId: `ord_list_${i}`, amount: 1000 * (i + 1), currency: 'INR', status,
          failureReason: status === 'captured' ? null : 'gateway_timeout',
          attemptCount: 0, isSubscription: false, createdAt: new Date(),
        });
      }
      const all = await listPayments({ limit: 50, offset: 0, merchantId: MERCHANT });
      assert.ok(all.total >= 3);

      const failed = await listPayments({ limit: 50, offset: 0, status: 'failed', merchantId: MERCHANT });
      assert.ok(failed.payments.every((p) => p.status === 'failed'));
    });
  });

  // -- customer history ---------------------------------------------------
  describe('customer history', () => {
    test('derives history from payments only, excluding the subject payment', async () => {
      await insertPayment({
        id: 'pay_it_h1', merchantId: MERCHANT, customerId: CUSTOMER, orderId: 'oh1',
        amount: 5000, currency: 'INR', status: 'captured', failureReason: null,
        attemptCount: 0, isSubscription: false, createdAt: new Date(),
      });
      await insertPayment({
        id: 'pay_it_h2', merchantId: MERCHANT, customerId: CUSTOMER, orderId: 'oh2',
        amount: 3000, currency: 'INR', status: 'failed', failureReason: 'gateway_timeout',
        attemptCount: 0, isSubscription: false, createdAt: new Date(),
      });

      const history = await getCustomerHistory(CUSTOMER, 'pay_it_h2');
      assert.ok(history.totalPayments >= 1);
      assert.ok(history.successfulPayments >= 1);
      assert.ok(history.lifetimeValue >= 5000);
      // The excluded payment must not be counted in its own history.
      const withSelf = await getCustomerHistory(CUSTOMER, null);
      assert.ok(withSelf.totalPayments > history.totalPayments);
    });
  });

  // -- recovery cases -----------------------------------------------------
  describe('recovery case persistence', () => {
    async function seedPayment(id: string) {
      await insertPayment({
        id, merchantId: MERCHANT, customerId: CUSTOMER, orderId: `ord_${id}`,
        amount: 249_900, currency: 'INR', status: 'failed',
        failureReason: 'gateway_timeout', attemptCount: 0, isSubscription: false,
        createdAt: new Date('2026-08-22T10:00:00.000Z'),
      });
    }

    test('persists a recovery case', async () => {
      await seedPayment('pay_it_rc1');
      const created = await insertRecoveryCase({
        id: 'rc_it_1', paymentId: 'pay_it_rc1', riskScore: 0.8, recoverabilityScore: 0.75,
        classification: 'TEMPORARY_FAILURE', recommendedAction: 'RETRY', confidence: 0.92,
        revenueAtRisk: 249_900, reason: 'Gateway timeout is transient.', status: 'OPEN',
      });
      assert.equal(created.status, 'OPEN');
      assert.equal(created.revenueAtRisk, 249_900);

      const live = await findLiveCaseForPayment('pay_it_rc1');
      assert.equal(live?.id, 'rc_it_1');
    });

    test('enforces one live case per payment', async () => {
      await seedPayment('pay_it_rc2');
      const base = {
        paymentId: 'pay_it_rc2', riskScore: 0.8, recoverabilityScore: 0.7,
        classification: 'TEMPORARY_FAILURE' as const, recommendedAction: 'RETRY' as const,
        confidence: 0.9, revenueAtRisk: 249_900, reason: 'r', status: 'OPEN' as const,
      };
      await insertRecoveryCase({ ...base, id: 'rc_it_2a' });
      await assert.rejects(
        () => insertRecoveryCase({ ...base, id: 'rc_it_2b' }),
        DuplicateOpenCaseError,
      );
    });

    test('lists cases with pagination', async () => {
      await seedPayment('pay_it_rc3');
      await insertRecoveryCase({
        id: 'rc_it_3', paymentId: 'pay_it_rc3', riskScore: 0.5, recoverabilityScore: 0.5,
        classification: 'TEMPORARY_FAILURE', recommendedAction: 'RETRY', confidence: 0.8,
        revenueAtRisk: 1000, reason: 'r', status: 'OPEN',
      });
      const result = await listRecoveryCases({ limit: 10, offset: 0 });
      assert.ok(result.total >= 1);
      assert.ok(result.cases.length >= 1);
    });
  });

  // -- audit trail --------------------------------------------------------
  describe('audit trail', () => {
    test('appends events and reads them back in order', async () => {
      await insertPayment({
        id: 'pay_it_audit', merchantId: MERCHANT, customerId: CUSTOMER, orderId: 'oa',
        amount: 1000, currency: 'INR', status: 'failed', failureReason: 'gateway_timeout',
        attemptCount: 0, isSubscription: false, createdAt: new Date(),
      });
      await appendAuditEvent({
        paymentId: 'pay_it_audit', caseId: null, eventType: 'RISK_ASSESSED',
        actor: 'test', decision: 'AT_RISK', metadata: { a: 1 },
      });
      const events = await listAuditEventsForPayment('pay_it_audit');
      assert.ok(events.length >= 1);
      assert.equal(events[0]!.eventType, 'RISK_ASSESSED');
      assert.deepEqual(events[0]!.metadata, { a: 1 });
    });

    test('audit events cannot be updated or deleted', async () => {
      await appendAuditEvent({
        paymentId: null, caseId: null, eventType: 'RISK_ASSESSED',
        actor: 'immutability-test', decision: null, metadata: {},
      });
      await assert.rejects(
        () => getPool().query(`UPDATE audit_events SET actor='tampered' WHERE actor='immutability-test'`),
        /append-only/,
      );
      await assert.rejects(
        () => getPool().query(`DELETE FROM audit_events WHERE actor='immutability-test'`),
        /append-only/,
      );
    });
  });

  // -- analysis pipeline --------------------------------------------------
  describe('analysis pipeline', () => {
    test('analyzes an at-risk payment and creates a case', async () => {
      const payment = await insertPayment({
        id: 'pay_it_an1', merchantId: MERCHANT, customerId: CUSTOMER, orderId: 'oan1',
        amount: 249_900, currency: 'INR', status: 'failed', failureReason: 'gateway_timeout',
        attemptCount: 0, isSubscription: false, createdAt: new Date('2026-08-22T10:00:00.000Z'),
      });

      const result = await analyzePayment(payment, {
        provider: new MockAIProvider(), config: loadConfig(),
        now: new Date('2026-08-22T12:00:00.000Z'),
      });

      assert.equal(result.assessment.atRisk, true);
      assert.equal(result.assessment.revenueAtRisk, 249_900);
      assert.ok(result.diagnosis);
      assert.equal(result.diagnosis.recommendedAction, 'RETRY');
      assert.ok(result.recoveryCase);
      // ANALYZED, not authorized or executed.
      assert.equal(result.recoveryCase.status, 'OPEN');
    });

    test('a captured payment produces no case and no AI call', async () => {
      const payment = await insertPayment({
        id: 'pay_it_an2', merchantId: MERCHANT, customerId: CUSTOMER, orderId: 'oan2',
        amount: 5000, currency: 'INR', status: 'captured', failureReason: null,
        attemptCount: 0, isSubscription: false, createdAt: new Date(),
      });
      const result = await analyzePayment(payment, {
        provider: new MockAIProvider(), config: loadConfig(),
      });
      assert.equal(result.assessment.atRisk, false);
      assert.equal(result.recoveryCase, null);
      assert.equal(result.diagnosis, null);
    });

    test('re-analysis returns the existing live case rather than duplicating', async () => {
      const payment = await insertPayment({
        id: 'pay_it_an3', merchantId: MERCHANT, customerId: CUSTOMER, orderId: 'oan3',
        amount: 249_900, currency: 'INR', status: 'failed', failureReason: 'gateway_timeout',
        attemptCount: 0, isSubscription: false, createdAt: new Date('2026-08-22T10:00:00.000Z'),
      });
      const deps = { provider: new MockAIProvider(), config: loadConfig(), now: new Date('2026-08-22T12:00:00.000Z') };
      const first = await analyzePayment(payment, deps);
      const second = await analyzePayment(payment, deps);

      assert.equal(second.existingCase, true);
      assert.equal(second.recoveryCase!.id, first.recoveryCase!.id);
    });

    test('a provider failure falls back to the deterministic baseline', async () => {
      const payment = await insertPayment({
        id: 'pay_it_an4', merchantId: MERCHANT, customerId: CUSTOMER, orderId: 'oan4',
        amount: 249_900, currency: 'INR', status: 'failed', failureReason: 'gateway_timeout',
        attemptCount: 0, isSubscription: false, createdAt: new Date('2026-08-22T10:00:00.000Z'),
      });

      const broken = {
        name: 'broken', model: 'none',
        diagnose: () => Promise.reject(new Error('provider exploded')),
      };

      const result = await analyzePayment(payment, {
        provider: broken, config: loadConfig(), now: new Date('2026-08-22T12:00:00.000Z'),
      });

      // Analysis still succeeds using the deterministic assessment.
      assert.equal(result.diagnosis, null);
      assert.ok(result.diagnosisError?.includes('provider_error'));
      assert.ok(result.recoveryCase);
      assert.equal(result.recoveryCase.recommendedAction, result.assessment.baselineAction);
    });
  });

  // -- API ----------------------------------------------------------------
  describe('API endpoints', () => {
    test('POST /api/payments creates a payment', async () => {
      const response = await app.inject({
        method: 'POST', url: '/api/payments',
        payload: {
          payment_id: 'pay_it_api1', order_id: 'ord_api1', customer_id: CUSTOMER,
          merchant_id: MERCHANT, amount: 249_900, currency: 'INR',
          status: 'failed', failure_reason: 'gateway_timeout',
          created_at: '2026-08-22T10:30:00Z',
        },
      });
      assert.equal(response.statusCode, 201);
      const body = response.json();
      assert.equal(body.payment.payment_id, 'pay_it_api1');
      assert.equal(body.payment.amount, 249_900);
    });

    test('POST /api/payments rejects a fractional amount', async () => {
      const response = await app.inject({
        method: 'POST', url: '/api/payments',
        payload: {
          payment_id: 'pay_it_frac', order_id: 'o', customer_id: CUSTOMER,
          merchant_id: MERCHANT, amount: 2499.5, currency: 'INR',
          status: 'failed', failure_reason: 'gateway_timeout',
        },
      });
      assert.equal(response.statusCode, 400);
      assert.equal(response.json().error, 'validation_error');
    });

    test('POST /api/payments rejects invalid status and currency', async () => {
      for (const bad of [{ status: 'exploded' }, { currency: 'USD' }, { amount: -100 }]) {
        const response = await app.inject({
          method: 'POST', url: '/api/payments',
          payload: {
            payment_id: 'pay_it_bad', order_id: 'o', customer_id: CUSTOMER,
            merchant_id: MERCHANT, amount: 1000, currency: 'INR',
            status: 'failed', failure_reason: 'gateway_timeout', ...bad,
          },
        });
        assert.equal(response.statusCode, 400, JSON.stringify(bad));
      }
    });

    test('POST /api/payments rejects client-supplied derived fields', async () => {
      // A caller must not be able to inject a risk score or a classification.
      const response = await app.inject({
        method: 'POST', url: '/api/payments',
        payload: {
          payment_id: 'pay_it_inject', order_id: 'o', customer_id: CUSTOMER,
          merchant_id: MERCHANT, amount: 1000, currency: 'INR', status: 'failed',
          failure_reason: 'gateway_timeout', risk_score: 0.01, classification: 'UNKNOWN',
        },
      });
      assert.equal(response.statusCode, 400);
    });

    test('POST /api/payments returns 409 on a duplicate', async () => {
      const payload = {
        payment_id: 'pay_it_api_dup', order_id: 'o', customer_id: CUSTOMER,
        merchant_id: MERCHANT, amount: 1000, currency: 'INR',
        status: 'failed', failure_reason: 'gateway_timeout',
      };
      assert.equal((await app.inject({ method: 'POST', url: '/api/payments', payload })).statusCode, 201);
      assert.equal((await app.inject({ method: 'POST', url: '/api/payments', payload })).statusCode, 409);
    });

    test('GET /api/payments lists payments', async () => {
      await app.inject({
        method: 'POST', url: '/api/payments',
        payload: {
          payment_id: 'pay_it_api_list', order_id: 'o', customer_id: CUSTOMER,
          merchant_id: MERCHANT, amount: 1000, currency: 'INR',
          status: 'failed', failure_reason: 'gateway_timeout',
        },
      });
      const response = await app.inject({ method: 'GET', url: `/api/payments?merchant_id=${MERCHANT}` });
      assert.equal(response.statusCode, 200);
      const body = response.json();
      assert.ok(Array.isArray(body.payments));
      assert.ok(body.pagination.total >= 1);
    });

    test('GET /api/payments rejects an invalid limit', async () => {
      const response = await app.inject({ method: 'GET', url: '/api/payments?limit=9999' });
      assert.equal(response.statusCode, 400);
    });

    test('POST /api/recovery/analyze analyzes without executing', async () => {
      await app.inject({
        method: 'POST', url: '/api/payments',
        payload: {
          payment_id: 'pay_it_api_an', order_id: 'o', customer_id: CUSTOMER,
          merchant_id: MERCHANT, amount: 249_900, currency: 'INR',
          status: 'failed', failure_reason: 'gateway_timeout',
          created_at: '2026-08-22T10:00:00Z',
        },
      });

      const response = await app.inject({
        method: 'POST', url: '/api/recovery/analyze',
        payload: { payment_id: 'pay_it_api_an' },
      });

      assert.equal(response.statusCode, 200);
      const body = response.json();
      assert.equal(body.risk.at_risk, true);
      assert.equal(body.risk.revenue_at_risk, 249_900);
      assert.ok(body.diagnosis);
      assert.equal(body.diagnosis.recommended_action, 'RETRY');
      assert.ok(body.recovery_case);
      // `authorized` is now the computed policy verdict rather than a constant.
      // This case (INR 2,499, no prior attempts, high confidence) passes every
      // rule, so it authorizes.
      assert.equal(body.authorized, true);
      assert.equal(body.policy.decision, 'ALLOWED');
      // `executed` remains false: authorization is permission, not action, and
      // no executor exists to act on it.
      assert.equal(body.executed, false);
    });

    test('POST /api/recovery/analyze returns 404 for an unknown payment', async () => {
      const response = await app.inject({
        method: 'POST', url: '/api/recovery/analyze',
        payload: { payment_id: 'pay_does_not_exist' },
      });
      assert.equal(response.statusCode, 404);
    });

    test('POST /api/recovery/analyze rejects an invalid body', async () => {
      for (const payload of [{}, { payment_id: '' }, { payment_id: 'x', classification: 'RETRY' }]) {
        const response = await app.inject({ method: 'POST', url: '/api/recovery/analyze', payload });
        assert.equal(response.statusCode, 400, JSON.stringify(payload));
      }
    });

    test('error responses never leak a stack trace', async () => {
      const response = await app.inject({
        method: 'POST', url: '/api/payments', payload: { nonsense: true },
      });
      const raw = response.body;
      assert.ok(!raw.includes('at Object.'), 'response contains a stack frame');
      assert.ok(!raw.includes('node_modules'), 'response leaks internal paths');
    });

    test('GET /api/health reports a reachable database', async () => {
      const response = await app.inject({ method: 'GET', url: '/api/health' });
      assert.equal(response.statusCode, 200);
      assert.equal(response.json().database.reachable, true);
    });
  });
});
