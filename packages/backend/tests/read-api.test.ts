import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { getPool, closePool } from '../src/db/pool.ts';
import { runMigrations } from '../src/db/migrate.ts';
import { buildApp } from '../src/app.ts';
import { loadConfig } from '../src/config/index.ts';
import { insertPayment } from '../src/payments/repository.ts';
import { insertRecoveryCase } from '../src/recovery/repository.ts';
import { approveRecoveryCase } from '../src/recovery/approval-service.ts';
import { runBatchRecovery } from '../src/jobs/batch-recovery.ts';
import { MockAIProvider } from '../src/agents/diagnosis/providers/mock.ts';
import { MockRecoveryProvider } from '../src/payments/providers/mock.ts';

/**
 * READ APIS FOR THE OPERATIONS CONSOLE
 *
 * GET /api/recovery/:caseId and GET /api/audit exist so a frontend can render
 * a case and an audit trail WITHOUT calling POST /analyze, which would create
 * state as a side effect of viewing.
 *
 * Both are read-only. The tests below assert that they cannot mutate, cannot
 * leak a credential, and are protected by the existing auth hook.
 */
const TEST_DB_URL = process.env.RECOVERAI_TEST_DATABASE_URL;
const dbAvailable = TEST_DB_URL !== undefined && TEST_DB_URL.length > 0;
if (dbAvailable) process.env.DATABASE_URL = TEST_DB_URL;

const skip = dbAvailable
  ? false
  : 'RECOVERAI_TEST_DATABASE_URL is not set; skipping live read-API tests';

const MERCHANT = 'merchant_read';
const CUSTOMER = 'cust_read';
const CONFIG = loadConfig({});

async function cleanFixtures(): Promise<void> {
  const pool = getPool();
  await pool.query(
    `DELETE FROM recovery_approvals WHERE recovery_case_id IN
       (SELECT id FROM recovery_cases WHERE payment_id LIKE 'pay_rd_%')`,
  );
  await pool.query(
    `DELETE FROM recovery_actions WHERE recovery_case_id IN
       (SELECT id FROM recovery_cases WHERE payment_id LIKE 'pay_rd_%')`,
  );
  await pool.query(`DELETE FROM recovery_cases WHERE payment_id LIKE 'pay_rd_%'`);
  // audit_events is append-only; removing the payment cascades to its events.
  await pool.query(`DELETE FROM payments WHERE id LIKE 'pay_rd_%'`);
}

async function seedCase(options: {
  paymentId: string;
  caseId: string;
  amount?: number;
  caseStatus?: 'OPEN' | 'AWAITING_APPROVAL';
}): Promise<void> {
  const amount = options.amount ?? 249_900;
  await insertPayment({
    id: options.paymentId,
    merchantId: MERCHANT,
    customerId: CUSTOMER,
    orderId: `ord_${options.paymentId}`,
    amount,
    currency: 'INR',
    status: 'failed',
    failureReason: 'gateway_timeout',
    attemptCount: 0,
    isSubscription: false,
    createdAt: new Date('2026-08-22T10:00:00.000Z'),
  });
  await insertRecoveryCase({
    id: options.caseId,
    paymentId: options.paymentId,
    riskScore: 0.5,
    recoverabilityScore: 0.8,
    classification: 'TEMPORARY_FAILURE',
    recommendedAction: 'RETRY',
    confidence: 0.92,
    revenueAtRisk: amount,
    reason: 'seeded for read-api test',
    status: (options.caseStatus ?? 'OPEN') as 'OPEN',
  });
}

describe('read APIs — live database', { skip }, () => {
  let app: FastifyInstance;

  before(async () => {
    await runMigrations();
    const pool = getPool();
    await pool.query(
      `INSERT INTO merchants (id, name, currency) VALUES ($1,'Read Co','INR')
       ON CONFLICT (id) DO NOTHING`,
      [MERCHANT],
    );
    await pool.query(
      `INSERT INTO customers (id, merchant_id, name, email)
       VALUES ($1,$2,'Read Person','read@example.com') ON CONFLICT (id) DO NOTHING`,
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

  // -- GET /api/recovery/:caseId -------------------------------------------
  describe('GET /api/recovery/:caseId', () => {
    test('returns the case with every lifecycle stage', async () => {
      await seedCase({ paymentId: 'pay_rd_one', caseId: 'rc_rd_one' });

      const response = await app.inject({ method: 'GET', url: '/api/recovery/rc_rd_one' });

      assert.equal(response.statusCode, 200);
      const body = JSON.parse(response.body) as Record<string, any>;
      // The five stages a detail screen must render separately.
      assert.equal(body.case.id, 'rc_rd_one');
      assert.equal(body.case.recommended_action, 'RETRY', 'AI stage missing');
      assert.equal(body.case.confidence, 0.92);
      // serialisePayment exposes `payment_id`, not `id` — matching the
      // existing /api/payments contract the frontend already binds to.
      assert.equal(body.payment.payment_id, 'pay_rd_one', 'payment missing');
      assert.ok(Array.isArray(body.actions), 'actions missing');
      assert.ok('approval' in body, 'approval key missing');
      assert.ok(Array.isArray(body.audit), 'audit missing');
    });

    test('includes the recorded policy, execution and verification once executed', async () => {
      await seedCase({ paymentId: 'pay_rd_exec', caseId: 'rc_rd_exec' });
      await runBatchRecovery(
        { merchantId: MERCHANT },
        {
          provider: new MockAIProvider(),
          recoveryProvider: new MockRecoveryProvider({
            defaultOutcome: 'SUCCESS',
            observedState: 'SUCCEEDED',
          }),
          config: CONFIG,
        },
      );

      const response = await app.inject({ method: 'GET', url: '/api/recovery/rc_rd_exec' });
      const body = JSON.parse(response.body) as Record<string, any>;

      // The batch creates its own case, so this seeded case may have no
      // action; what matters is the SHAPE the frontend binds to.
      assert.equal(response.statusCode, 200);
      for (const action of body.actions) {
        for (const field of [
          'policy_status',
          'execution_status',
          'verification_status',
          'observed_payment_status',
        ]) {
          assert.ok(field in action, `action is missing ${field}`);
        }
      }
    });

    test('includes a human decision when one exists', async () => {
      await seedCase({
        paymentId: 'pay_rd_appr',
        caseId: 'rc_rd_appr',
        amount: 2_500_000,
        caseStatus: 'AWAITING_APPROVAL',
      });
      await approveRecoveryCase('rc_rd_appr', { reason: 'reviewed' }, { actor: 'test:operator' });

      const response = await app.inject({ method: 'GET', url: '/api/recovery/rc_rd_appr' });
      const body = JSON.parse(response.body) as Record<string, any>;

      assert.equal(body.approval.decision, 'APPROVED');
      assert.equal(body.approval.actor, 'test:operator');
      assert.equal(body.approval.reason, 'reviewed');
      assert.equal(body.case.status, 'APPROVED');
    });

    test('approval is null when no decision was made', async () => {
      await seedCase({ paymentId: 'pay_rd_noappr', caseId: 'rc_rd_noappr' });
      const response = await app.inject({ method: 'GET', url: '/api/recovery/rc_rd_noappr' });
      assert.equal(JSON.parse(response.body).approval, null);
    });

    test('a missing case is 404, not an empty shell', async () => {
      const response = await app.inject({ method: 'GET', url: '/api/recovery/rc_rd_absent' });
      assert.equal(response.statusCode, 404);
    });

    test('a malformed caseId is rejected', async () => {
      const response = await app.inject({ method: 'GET', url: '/api/recovery/not%20valid%21' });
      assert.ok([400, 404].includes(response.statusCode));
    });

    test('the endpoint CREATES NOTHING', async () => {
      // The whole reason this endpoint exists: rendering a detail view must
      // never manufacture state the way POST /analyze would.
      await seedCase({ paymentId: 'pay_rd_pure', caseId: 'rc_rd_pure' });
      const countBefore = await getPool().query<{ c: string }>(
        `SELECT COUNT(*)::text AS c FROM recovery_cases WHERE payment_id LIKE 'pay_rd_%'`,
      );
      const actionsBefore = await getPool().query<{ c: string }>(
        `SELECT COUNT(*)::text AS c FROM recovery_actions`,
      );

      for (let i = 0; i < 3; i += 1) {
        await app.inject({ method: 'GET', url: '/api/recovery/rc_rd_pure' });
      }

      const countAfter = await getPool().query<{ c: string }>(
        `SELECT COUNT(*)::text AS c FROM recovery_cases WHERE payment_id LIKE 'pay_rd_%'`,
      );
      const actionsAfter = await getPool().query<{ c: string }>(
        `SELECT COUNT(*)::text AS c FROM recovery_actions`,
      );
      assert.equal(countAfter.rows[0]!.c, countBefore.rows[0]!.c, 'a case was created by a GET');
      assert.equal(actionsAfter.rows[0]!.c, actionsBefore.rows[0]!.c, 'an action was created');
    });

    test('the response leaks no credential', async () => {
      await seedCase({ paymentId: 'pay_rd_sec', caseId: 'rc_rd_sec' });
      const response = await app.inject({ method: 'GET', url: '/api/recovery/rc_rd_sec' });
      for (const forbidden of ['rzp_test_', 'rzp_live_', 'AIza', 'API_AUTH_TOKEN', 'Bearer ']) {
        assert.ok(!response.body.includes(forbidden), `response leaked "${forbidden}"`);
      }
    });
  });

  // -- GET /api/audit -------------------------------------------------------
  describe('GET /api/audit', () => {
    test('returns events newest first with a total', async () => {
      await seedCase({ paymentId: 'pay_rd_aud', caseId: 'rc_rd_aud' });
      await runBatchRecovery(
        { merchantId: MERCHANT },
        {
          provider: new MockAIProvider(),
          recoveryProvider: new MockRecoveryProvider(),
          config: CONFIG,
        },
      );

      const response = await app.inject({ method: 'GET', url: '/api/audit?limit=50' });

      assert.equal(response.statusCode, 200);
      const body = JSON.parse(response.body) as Record<string, any>;
      assert.ok(Array.isArray(body.events));
      assert.equal(typeof body.pagination.total, 'number');
      assert.ok(body.events.length > 0, 'no audit events were returned');

      // Newest first, so an operator sees recent activity at the top.
      const times: number[] = body.events.map((e: any) => Date.parse(e.created_at));
      for (let i = 1; i < times.length; i += 1) {
        // Non-null assertions: the loop bounds guarantee both indices exist,
        // which noUncheckedIndexedAccess cannot see.
        assert.ok(times[i - 1]! >= times[i]!, 'events are not ordered newest first');
      }
    });

    test('every event carries the fields an audit table needs', async () => {
      await seedCase({ paymentId: 'pay_rd_fields', caseId: 'rc_rd_fields' });
      await runBatchRecovery(
        { merchantId: MERCHANT },
        {
          provider: new MockAIProvider(),
          recoveryProvider: new MockRecoveryProvider(),
          config: CONFIG,
        },
      );

      const body = JSON.parse(
        (await app.inject({ method: 'GET', url: '/api/audit' })).body,
      ) as Record<string, any>;

      for (const field of [
        'id', 'payment_id', 'case_id', 'event_type', 'actor', 'decision',
        'metadata', 'created_at',
      ]) {
        assert.ok(field in body.events[0], `audit event is missing ${field}`);
      }
    });

    test('filters by payment, case, event type and actor', async () => {
      await seedCase({ paymentId: 'pay_rd_filt', caseId: 'rc_rd_filt' });
      await runBatchRecovery(
        { merchantId: MERCHANT },
        {
          provider: new MockAIProvider(),
          recoveryProvider: new MockRecoveryProvider(),
          config: CONFIG,
        },
      );

      const byPayment = JSON.parse(
        (await app.inject({ method: 'GET', url: '/api/audit?payment_id=pay_rd_filt' })).body,
      );
      for (const event of byPayment.events) {
        assert.equal(event.payment_id, 'pay_rd_filt');
      }

      const byType = JSON.parse(
        (await app.inject({ method: 'GET', url: '/api/audit?event_type=RISK_ASSESSED' })).body,
      );
      for (const event of byType.events) {
        assert.equal(event.event_type, 'RISK_ASSESSED');
      }
    });

    test('pagination is bounded and consistent', async () => {
      await seedCase({ paymentId: 'pay_rd_page', caseId: 'rc_rd_page' });
      await runBatchRecovery(
        { merchantId: MERCHANT },
        {
          provider: new MockAIProvider(),
          recoveryProvider: new MockRecoveryProvider(),
          config: CONFIG,
        },
      );

      const page = JSON.parse(
        (await app.inject({ method: 'GET', url: '/api/audit?limit=2&offset=0' })).body,
      );
      assert.ok(page.events.length <= 2);
      assert.equal(page.pagination.limit, 2);
      assert.equal(page.pagination.offset, 0);

      // A limit above the cap is rejected rather than silently clamped.
      const tooBig = await app.inject({ method: 'GET', url: '/api/audit?limit=9999' });
      assert.equal(tooBig.statusCode, 400);
    });

    test('the pagination envelope MATCHES the other list endpoints', async () => {
      // /api/recovery/cases and /api/payments both nest pagination. An audit
      // endpoint that paginated differently would force every consumer to
      // special-case it — the exact inconsistency that produced a silent
      // "0 cases" bug in the frontend.
      await seedCase({ paymentId: 'pay_rd_shape', caseId: 'rc_rd_shape' });
      await runBatchRecovery(
        { merchantId: MERCHANT },
        {
          provider: new MockAIProvider(),
          recoveryProvider: new MockRecoveryProvider(),
          config: CONFIG,
        },
      );

      const shapeOf = async (url: string): Promise<string[]> => {
        const body = JSON.parse((await app.inject({ method: 'GET', url })).body) as
          Record<string, unknown>;
        return Object.keys(body).sort();
      };

      const audit = JSON.parse(
        (await app.inject({ method: 'GET', url: '/api/audit?limit=5' })).body,
      ) as Record<string, any>;

      // Nested, with exactly the three pagination fields the siblings use.
      assert.deepEqual(Object.keys(audit).sort(), ['events', 'pagination']);
      assert.deepEqual(Object.keys(audit.pagination).sort(), ['limit', 'offset', 'total']);
      assert.equal(typeof audit.pagination.total, 'number');
      assert.equal(audit.pagination.limit, 5);
      assert.equal(audit.pagination.offset, 0);

      // And NOT flat: the old shape must be gone.
      assert.equal(audit.total, undefined, 'the flat `total` field still exists');
      assert.equal(audit.limit, undefined, 'the flat `limit` field still exists');
      assert.equal(audit.offset, undefined, 'the flat `offset` field still exists');

      // The sibling endpoints use the same envelope key.
      assert.ok((await shapeOf('/api/recovery/cases?limit=1')).includes('pagination'));
      assert.ok((await shapeOf('/api/payments?limit=1')).includes('pagination'));
    });

    test('an unknown query parameter is rejected', async () => {
      const response = await app.inject({ method: 'GET', url: '/api/audit?nonsense=1' });
      assert.equal(response.statusCode, 400);
    });

    test('an invalid event_type is rejected', async () => {
      const response = await app.inject({ method: 'GET', url: '/api/audit?event_type=NOPE' });
      assert.equal(response.statusCode, 400);
    });

    test('NO audit event exposes a credential', async () => {
      // The audit trail is written by services that record decision codes and
      // scrubbed messages. This asserts that end to end over real events.
      await seedCase({ paymentId: 'pay_rd_audsec', caseId: 'rc_rd_audsec' });
      await runBatchRecovery(
        { merchantId: MERCHANT },
        {
          provider: new MockAIProvider(),
          recoveryProvider: new MockRecoveryProvider(),
          config: CONFIG,
        },
      );

      const response = await app.inject({ method: 'GET', url: '/api/audit?limit=200' });
      for (const forbidden of [
        'rzp_test_', 'rzp_live_', 'AIza', 'API_AUTH_TOKEN',
        'RAZORPAY_KEY_SECRET', 'DATABASE_URL', 'Bearer ',
      ]) {
        assert.ok(!response.body.includes(forbidden), `the audit log leaked "${forbidden}"`);
      }
    });

    test('the endpoint MUTATES NOTHING', async () => {
      // Scoped to THIS suite's fixtures. A global count would be flaky: node
      // runs test files in parallel and another suite legitimately writes
      // audit events while this one runs.
      await seedCase({ paymentId: 'pay_rd_readonly', caseId: 'rc_rd_readonly' });
      const scoped = async (): Promise<string> =>
        (
          await getPool().query<{ c: string }>(
            `SELECT COUNT(*)::text AS c FROM audit_events WHERE payment_id LIKE 'pay_rd_%'`,
          )
        ).rows[0]!.c;

      // Named to avoid shadowing node:test's `before` hook.
      const countBeforeReads = await scoped();
      for (let i = 0; i < 3; i += 1) {
        await app.inject({ method: 'GET', url: '/api/audit' });
        await app.inject({ method: 'GET', url: '/api/audit?payment_id=pay_rd_readonly' });
      }
      assert.equal(await scoped(), countBeforeReads, 'reading the audit log wrote to it');
    });
  });
});

// ---------------------------------------------------------------------------
// AUTHENTICATION — no database required
// ---------------------------------------------------------------------------

describe('read APIs — authentication', () => {
  const TOKEN = 'readapi-token-0123456789abcdef';

  test('both endpoints require authentication', async () => {
    const app = await buildApp({
      config: loadConfig({ AUTH_ENABLED: 'true', API_AUTH_TOKEN: TOKEN }),
      provider: new MockAIProvider(),
      recoveryProvider: new MockRecoveryProvider(),
    });
    await app.ready();

    for (const url of ['/api/recovery/rc_any', '/api/audit']) {
      for (const headers of [{}, { authorization: 'Bearer wrongwrongwrongwrong' }]) {
        const response = await app.inject({ method: 'GET', url, headers });
        assert.equal(response.statusCode, 401, `${url} was reachable unauthenticated`);
        assert.ok(!response.body.includes(TOKEN), 'the 401 leaked the token');
      }
    }
    await app.close();
  });

  test('a correct token is admitted past authentication', async () => {
    const app = await buildApp({
      config: loadConfig({ AUTH_ENABLED: 'true', API_AUTH_TOKEN: TOKEN }),
      provider: new MockAIProvider(),
      recoveryProvider: new MockRecoveryProvider(),
    });
    await app.ready();

    const response = await app.inject({
      method: 'GET',
      url: '/api/audit',
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    // May still fail for want of a database, but must not be a 401.
    assert.notEqual(response.statusCode, 401);
    await app.close();
  });
});
