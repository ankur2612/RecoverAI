import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { MockRecoveryProvider } from '../src/payments/providers/mock.ts';
import { buildIdempotencyKey } from '../src/recovery/executor.ts';
import { isExecutableAction, EXECUTABLE_ACTIONS } from '../src/payments/provider.ts';
import { evaluatePolicy } from '../src/policies/engine.ts';
import { POLICY_VERSION, type PolicyInput, type PolicyResult } from '../src/policies/types.ts';
import { loadConfig } from '../src/config/index.ts';

/**
 * Executor unit tests that need no database.
 *
 * The executor's database-touching paths are covered in integration.test.ts
 * against live PostgreSQL, because the idempotency guarantee IS a database
 * guarantee and mocking it would test nothing worth knowing.
 */

const POLICY = loadConfig({}).policy;

function policyInput(overrides: Partial<PolicyInput> = {}): PolicyInput {
  return {
    paymentId: 'pay_x',
    amount: 249_900,
    currency: 'INR',
    paymentStatus: 'failed',
    failureReason: 'gateway_timeout',
    attemptCount: 0,
    secondsSinceLastAttempt: null,
    proposedAction: 'RETRY',
    confidence: 0.92,
    duplicateActionExists: false,
    alreadyRecovered: false,
    remindersSent: 0,
    humanReviewRequested: false,
    ...overrides,
  };
}

const authorizedPolicy = (): PolicyResult => evaluatePolicy(policyInput(), POLICY);

describe('idempotency key design', () => {
  test('is deterministic for the same logical action', () => {
    const a = buildIdempotencyKey('rc_1', 'RETRY', 'v1');
    const b = buildIdempotencyKey('rc_1', 'RETRY', 'v1');
    assert.equal(a, b);
  });

  test('follows the documented recovery:{case}:{action}:{version} shape', () => {
    assert.equal(buildIdempotencyKey('rc_1', 'RETRY', 'v1'), 'recovery:rc_1:RETRY:v1');
  });

  test('differs across cases, actions, and policy versions', () => {
    const base = buildIdempotencyKey('rc_1', 'RETRY', 'v1');
    assert.notEqual(base, buildIdempotencyKey('rc_2', 'RETRY', 'v1'));
    assert.notEqual(base, buildIdempotencyKey('rc_1', 'REMINDER', 'v1'));
    assert.notEqual(base, buildIdempotencyKey('rc_1', 'RETRY', 'v2'));
  });

  test('contains no randomness or timestamp', () => {
    // A per-request key would defeat duplicate protection entirely.
    const key = buildIdempotencyKey('rc_1', 'RETRY', 'v1');
    assert.ok(!/\d{10,}/.test(key), 'key appears to contain a timestamp');
    assert.equal(key, buildIdempotencyKey('rc_1', 'RETRY', 'v1'));
  });

  test('uses the current policy version constant', () => {
    assert.ok(buildIdempotencyKey('rc_1', 'RETRY', POLICY_VERSION).endsWith(`:${POLICY_VERSION}`));
  });
});

describe('executable actions', () => {
  test('RETRY is executable', () => {
    assert.equal(isExecutableAction('RETRY'), true);
  });

  test('actions with no provider implementation are not executable', () => {
    // Claiming to execute a reminder no provider can send would be a lie.
    for (const action of ['REMINDER', 'CHECKOUT_RECOVERY', 'SUBSCRIPTION_RETRY']) {
      assert.equal(isExecutableAction(action), false, action);
    }
  });

  test('passive and unknown actions are never executable', () => {
    for (const action of ['NO_ACTION', 'ESCALATE', 'DRAIN_ACCOUNT', '']) {
      assert.equal(isExecutableAction(action), false, action);
    }
  });

  test('the executable set is exactly RETRY in this phase', () => {
    assert.deepEqual([...EXECUTABLE_ACTIONS], ['RETRY']);
  });
});

describe('MockRecoveryProvider — determinism', () => {
  test('returns the configured default outcome every time', async () => {
    const provider = new MockRecoveryProvider({ defaultOutcome: 'SUCCESS' });
    const request = {
      idempotencyKey: 'k1', action: 'RETRY' as const,
      paymentId: 'pay_1', amount: 1000, currency: 'INR',
    };
    const a = await provider.executeAction(request);
    const b = await provider.executeAction(request);
    assert.equal(a.outcome, 'SUCCESS');
    assert.deepEqual(a, b, 'the mock must be deterministic');
  });

  test('consumes queued outcomes in order', async () => {
    const provider = new MockRecoveryProvider({
      outcomeQueue: ['FAILED', 'UNKNOWN'], defaultOutcome: 'SUCCESS',
    });
    const request = {
      idempotencyKey: 'k', action: 'RETRY' as const,
      paymentId: 'p', amount: 1, currency: 'INR',
    };
    assert.equal((await provider.executeAction(request)).outcome, 'FAILED');
    assert.equal((await provider.executeAction(request)).outcome, 'UNKNOWN');
    assert.equal((await provider.executeAction(request)).outcome, 'SUCCESS');
  });

  test('counts calls, which is how duplicate protection is proven', async () => {
    const provider = new MockRecoveryProvider();
    assert.equal(provider.callCount, 0);
    await provider.executeAction({
      idempotencyKey: 'k', action: 'RETRY', paymentId: 'p', amount: 1, currency: 'INR',
    });
    assert.equal(provider.callCount, 1);
  });

  test('an UNKNOWN result reports no payment status', async () => {
    // Claiming to know the payment state after a timeout would be fabrication.
    const provider = new MockRecoveryProvider({ defaultOutcome: 'UNKNOWN' });
    const result = await provider.executeAction({
      idempotencyKey: 'k', action: 'RETRY', paymentId: 'p', amount: 1, currency: 'INR',
    });
    assert.equal(result.paymentStatus, null);
    assert.equal(result.providerActionId, null);
    assert.ok(result.errorMessage);
  });

  test('throwOnCall throws rather than returning FAILED', async () => {
    const provider = new MockRecoveryProvider({ throwOnCall: true });
    await assert.rejects(() =>
      provider.executeAction({
        idempotencyKey: 'k', action: 'RETRY', paymentId: 'p', amount: 1, currency: 'INR',
      }),
    );
  });

  test('references are derived from the key, so they are stable', async () => {
    const provider = new MockRecoveryProvider();
    const result = await provider.executeAction({
      idempotencyKey: 'recovery:rc_1:RETRY:v1', action: 'RETRY',
      paymentId: 'p', amount: 1, currency: 'INR',
    });
    assert.equal(result.rawReference, 'mock_recovery:rc_1:RETRY:v1');
  });

  test('never uses randomness', async () => {
    // Two separately-constructed providers must agree exactly.
    const req = {
      idempotencyKey: 'k', action: 'RETRY' as const,
      paymentId: 'p', amount: 1, currency: 'INR',
    };
    const a = await new MockRecoveryProvider().executeAction(req);
    const b = await new MockRecoveryProvider().executeAction(req);
    assert.deepEqual(a, b);
  });
});

describe('authorization boundary — policy shapes the executor refuses', () => {
  // These assert the policy verdicts the executor keys off. The refusal paths
  // themselves are exercised end to end in the integration suite.

  test('an authorized retry is the only shape that may proceed', () => {
    const policy = authorizedPolicy();
    assert.equal(policy.authorized, true);
    assert.equal(policy.requiresHumanApproval, false);
  });

  test('a high-value case yields requiresHumanApproval, which must refuse', () => {
    const policy = evaluatePolicy(policyInput({ amount: 2_500_000 }), POLICY);
    assert.equal(policy.authorized, false);
    assert.equal(policy.requiresHumanApproval, true);
  });

  test('an exhausted retry budget yields BLOCKED, which must refuse', () => {
    const policy = evaluatePolicy(policyInput({ attemptCount: 3 }), POLICY);
    assert.equal(policy.authorized, false);
    assert.equal(policy.decision, 'BLOCKED');
  });

  test('a duplicate flag yields BLOCKED before the executor is reached', () => {
    const policy = evaluatePolicy(policyInput({ duplicateActionExists: true }), POLICY);
    assert.equal(policy.authorized, false);
    assert.ok(policy.denialReasons.includes('DUPLICATE_ACTION'));
  });

  test('policy.action identifies what was authorized, enabling mismatch checks', () => {
    // The executor compares this against the submitted action so an
    // authorization for one action cannot be spent on another.
    const policy = evaluatePolicy(policyInput({ proposedAction: 'NO_ACTION' }), POLICY);
    assert.equal(policy.action, 'NO_ACTION');
  });
});
