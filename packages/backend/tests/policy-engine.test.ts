import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { evaluatePolicy } from '../src/policies/engine.ts';
import { buildPolicyInput } from '../src/policies/input.ts';
import {
  POLICY_VERSION,
  type PolicyInput,
  type PolicyReasonCode,
} from '../src/policies/types.ts';
import { loadConfig, type PolicyConfig } from '../src/config/index.ts';
import { assessRisk } from '../src/risk/detector.ts';
import { EMPTY_CUSTOMER_HISTORY } from '../src/risk/types.ts';
import type { Payment, PaymentStatus } from '../src/shared/types.ts';

const POLICY: PolicyConfig = loadConfig({}).policy;

/** A payment that should be cleanly authorized: PRD example 1. */
function input(overrides: Partial<PolicyInput> = {}): PolicyInput {
  return {
    paymentId: 'pay_test',
    amount: 249_900, // INR 2,499
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

const evaluate = (o: Partial<PolicyInput> = {}, config: PolicyConfig = POLICY) =>
  evaluatePolicy(input(o), config);

/** Find one rule's result by name. */
function ruleFor(result: ReturnType<typeof evaluate>, name: string) {
  return result.rules.find((r) => r.rule === name);
}

describe('policy engine — authorized cases', () => {
  test('PRD example 1: INR 2,499 gateway timeout, 0 retries, 0.92 confidence', () => {
    const result = evaluate();
    assert.equal(result.authorized, true);
    assert.equal(result.requiresHumanApproval, false);
    assert.equal(result.decision, 'ALLOWED');
    assert.deepEqual(result.denialReasons, []);
    assert.deepEqual(result.approvalReasons, []);
  });

  test('an authorized decision reports no failing rules', () => {
    const result = evaluate();
    assert.ok(!result.rules.some((r) => r.status === 'FAIL'));
    assert.ok(!result.rules.some((r) => r.status === 'REQUIRES_APPROVAL'));
  });

  test('a reminder for a customer-action failure is authorized', () => {
    const result = evaluate({
      proposedAction: 'REMINDER',
      failureReason: 'insufficient_funds',
      confidence: 0.86,
    });
    assert.equal(result.authorized, true);
  });

  test('an amount exactly at the automated limit is authorized', () => {
    // Boundary: the limit is inclusive for the automated ceiling but the
    // high-value threshold is >=, so an amount at both gates on approval.
    const result = evaluate(
      { amount: 500_000 },
      { ...POLICY, maxAutomatedAmount: 500_000, highValueThreshold: 1_000_000 },
    );
    assert.equal(result.authorized, true);
  });

  test('confidence exactly at the minimum is authorized', () => {
    const result = evaluate({ confidence: 0.75 });
    assert.equal(result.authorized, true);
  });
});

describe('policy engine — retry limits', () => {
  test('PRD example 3: retry count at the maximum is blocked', () => {
    const result = evaluate({ attemptCount: 3 });
    assert.equal(result.authorized, false);
    assert.ok(result.denialReasons.includes('MAX_RETRIES_EXCEEDED'));
    assert.equal(ruleFor(result, 'RETRY_LIMIT_AVAILABLE')?.status, 'FAIL');
  });

  test('retry count above the maximum is blocked', () => {
    assert.ok(evaluate({ attemptCount: 9 }).denialReasons.includes('MAX_RETRIES_EXCEEDED'));
  });

  test('one attempt below the maximum is allowed', () => {
    const result = evaluate({ attemptCount: 2 });
    assert.equal(result.authorized, true);
  });

  test('the retry limit applies to SUBSCRIPTION_RETRY too', () => {
    const result = evaluate({ proposedAction: 'SUBSCRIPTION_RETRY', attemptCount: 3 });
    assert.ok(result.denialReasons.includes('MAX_RETRIES_EXCEEDED'));
  });

  test('the retry limit does not apply to a reminder', () => {
    // A reminder consumes no retry budget, so an exhausted budget must not
    // block the one action that could still recover the payment.
    const result = evaluate({ proposedAction: 'REMINDER', attemptCount: 5, confidence: 0.9 });
    assert.ok(!result.denialReasons.includes('MAX_RETRIES_EXCEEDED'));
    assert.equal(ruleFor(result, 'RETRY_LIMIT_AVAILABLE')?.status, 'NOT_APPLICABLE');
  });

  test('retry cooldown blocks a too-soon retry', () => {
    const result = evaluate({ attemptCount: 1, secondsSinceLastAttempt: 60 });
    assert.equal(result.authorized, false);
    assert.ok(result.denialReasons.includes('RETRY_COOLDOWN_ACTIVE'));
  });

  test('an elapsed cooldown permits the retry', () => {
    const result = evaluate({ attemptCount: 1, secondsSinceLastAttempt: 7200 });
    assert.equal(result.authorized, true);
  });

  test('no prior attempt means no cooldown applies', () => {
    const result = evaluate({ attemptCount: 0, secondsSinceLastAttempt: null });
    assert.equal(ruleFor(result, 'RETRY_COOLDOWN_ELAPSED')?.status, 'NOT_APPLICABLE');
  });
});

describe('policy engine — amount limits', () => {
  test('an amount above the automated limit is never authorized', () => {
    // Exceeding the automated ceiling routes to a human (PRD sections 11, 17)
    // rather than dead-ending, but it is emphatically not authorization.
    const result = evaluate(
      { amount: 2_000_000 },
      { ...POLICY, maxAutomatedAmount: 1_000_000, highValueThreshold: 5_000_000 },
    );
    assert.equal(result.authorized, false);
    assert.equal(result.requiresHumanApproval, true);
    assert.ok(result.approvalReasons.includes('AMOUNT_EXCEEDS_AUTOMATED_LIMIT'));
  });

  test('PRD example 2: INR 25,000 requires human approval', () => {
    const result = evaluate({ amount: 2_500_000 });
    assert.equal(result.authorized, false);
    assert.equal(result.requiresHumanApproval, true);
    assert.ok(result.approvalReasons.includes('HIGH_VALUE_REQUIRES_APPROVAL'));
  });

  test('an amount at the high-value threshold requires approval', () => {
    // The threshold is inclusive: >= means exactly at it also gates.
    const result = evaluate({ amount: POLICY.highValueThreshold });
    assert.equal(result.requiresHumanApproval, true);
  });

  test('an amount just below the threshold does not require approval', () => {
    const result = evaluate({ amount: POLICY.highValueThreshold - 1 });
    assert.equal(result.requiresHumanApproval, false);
    assert.equal(result.authorized, true);
  });
});

describe('policy engine — confidence', () => {
  test('PRD example 4: confidence 0.54 below 0.75 is blocked', () => {
    const result = evaluate({ confidence: 0.54 });
    assert.equal(result.authorized, false);
    assert.ok(result.denialReasons.includes('INSUFFICIENT_CONFIDENCE'));
  });

  test('confidence just below the minimum is blocked', () => {
    assert.ok(evaluate({ confidence: 0.74 }).denialReasons.includes('INSUFFICIENT_CONFIDENCE'));
  });

  test('zero confidence is blocked', () => {
    assert.ok(evaluate({ confidence: 0 }).denialReasons.includes('INSUFFICIENT_CONFIDENCE'));
  });

  test('confidence does not gate a passive action', () => {
    // NO_ACTION is inert; requiring confidence to do nothing is nonsense.
    const result = evaluate({ proposedAction: 'NO_ACTION', confidence: 0.1 });
    assert.ok(!result.denialReasons.includes('INSUFFICIENT_CONFIDENCE'));
    assert.equal(ruleFor(result, 'CONFIDENCE_SUFFICIENT')?.status, 'NOT_APPLICABLE');
  });
});

describe('policy engine — payment state', () => {
  test('PRD example 5: an already-recovered payment is blocked', () => {
    const result = evaluate({ alreadyRecovered: true });
    assert.equal(result.authorized, false);
    assert.ok(result.denialReasons.includes('PAYMENT_ALREADY_RECOVERED'));
  });

  test('a captured payment is blocked as conflicting', () => {
    const result = evaluate({ paymentStatus: 'captured', alreadyRecovered: true });
    assert.equal(result.authorized, false);
    assert.ok(result.denialReasons.includes('PAYMENT_ALREADY_CAPTURED'));
  });

  test('a refunded payment is blocked as conflicting', () => {
    const result = evaluate({ paymentStatus: 'refunded' });
    assert.equal(result.authorized, false);
    assert.ok(result.denialReasons.includes('PAYMENT_ALREADY_REFUNDED'));
  });

  test('PRD example 7: an unknown payment state is blocked', () => {
    const result = evaluate({ paymentStatus: 'quantum_superposition' });
    assert.equal(result.authorized, false);
    assert.ok(result.denialReasons.includes('UNKNOWN_PAYMENT_STATE'));
  });

  test('a recognised but non-recoverable state is blocked as ineligible', () => {
    const result = evaluate({ paymentStatus: 'captured', alreadyRecovered: false });
    assert.equal(result.authorized, false);
    assert.ok(result.denialReasons.includes('PAYMENT_NOT_ELIGIBLE'));
  });

  test('abandoned and created states are eligible', () => {
    for (const status of ['abandoned', 'created'] as PaymentStatus[]) {
      const result = evaluate({ paymentStatus: status, proposedAction: 'CHECKOUT_RECOVERY' });
      assert.ok(
        !result.denialReasons.includes('PAYMENT_NOT_ELIGIBLE'),
        `${status} should be eligible`,
      );
    }
  });
});

describe('policy engine — duplicate protection', () => {
  test('PRD example 6: a duplicate action is blocked', () => {
    const result = evaluate({ duplicateActionExists: true });
    assert.equal(result.authorized, false);
    assert.ok(result.denialReasons.includes('DUPLICATE_ACTION'));
  });

  test('duplicate protection applies to every action type', () => {
    for (const action of ['RETRY', 'REMINDER', 'CHECKOUT_RECOVERY', 'SUBSCRIPTION_RETRY']) {
      const result = evaluate({ proposedAction: action, duplicateActionExists: true });
      assert.ok(result.denialReasons.includes('DUPLICATE_ACTION'), action);
      assert.equal(result.authorized, false, action);
    }
  });
});

describe('policy engine — unsupported actions', () => {
  test('an unsupported action is rejected', () => {
    const result = evaluate({ proposedAction: 'TRANSFER_ALL_FUNDS' });
    assert.equal(result.authorized, false);
    assert.ok(result.denialReasons.includes('UNSUPPORTED_ACTION'));
  });

  test('an empty action is rejected', () => {
    assert.ok(evaluate({ proposedAction: '' }).denialReasons.includes('UNSUPPORTED_ACTION'));
  });

  test('a lowercase variant is rejected rather than coerced', () => {
    // Silently upcasing would let a malformed recommendation through.
    assert.ok(evaluate({ proposedAction: 'retry' }).denialReasons.includes('UNSUPPORTED_ACTION'));
  });

  test('every supported action is accepted by the action rule', () => {
    for (const action of [
      'RETRY', 'REMINDER', 'CHECKOUT_RECOVERY', 'SUBSCRIPTION_RETRY', 'ESCALATE', 'NO_ACTION',
    ]) {
      const result = evaluate({ proposedAction: action });
      assert.equal(ruleFor(result, 'ACTION_SUPPORTED')?.status, 'PASS', action);
    }
  });
});

describe('policy engine — fail closed on missing information', () => {
  test('a missing payment id blocks', () => {
    const result = evaluate({ paymentId: '' });
    assert.equal(result.authorized, false);
    assert.ok(result.denialReasons.includes('MISSING_PAYMENT_ID'));
  });

  test('a whitespace-only payment id blocks', () => {
    assert.ok(evaluate({ paymentId: '   ' }).denialReasons.includes('MISSING_PAYMENT_ID'));
  });

  test('a non-integer amount blocks', () => {
    const result = evaluate({ amount: 2499.5 });
    assert.equal(result.authorized, false);
    assert.ok(result.denialReasons.includes('MISSING_REQUIRED_INFORMATION'));
  });

  test('a non-positive amount blocks', () => {
    for (const amount of [0, -100]) {
      assert.equal(evaluate({ amount }).authorized, false, String(amount));
    }
  });

  test('NaN confidence blocks rather than passing a comparison', () => {
    // NaN >= 0.75 is false, but relying on that would be accidental safety.
    const result = evaluate({ confidence: Number.NaN });
    assert.equal(result.authorized, false);
    assert.ok(result.denialReasons.includes('MISSING_REQUIRED_INFORMATION'));
  });

  test('out-of-range confidence blocks', () => {
    for (const confidence of [-0.5, 1.5]) {
      assert.equal(evaluate({ confidence }).authorized, false, String(confidence));
    }
  });

  test('a negative attempt count blocks', () => {
    assert.equal(evaluate({ attemptCount: -1 }).authorized, false);
  });

  test('missing information short-circuits but still returns a valid result', () => {
    const result = evaluate({ paymentId: '' });
    assert.equal(result.policyVersion, POLICY_VERSION);
    assert.equal(result.decision, 'BLOCKED');
    assert.ok(result.rules.length > 0);
  });
});

describe('policy engine — approval is never authorization', () => {
  test('requiring approval never yields authorized = true', () => {
    const result = evaluate({ amount: 2_500_000 });
    assert.equal(result.requiresHumanApproval, true);
    assert.equal(result.authorized, false, 'approval must NOT imply authorization');
    assert.equal(result.decision, 'REQUIRES_APPROVAL');
  });

  test('a human-review flag gates authorization', () => {
    const result = evaluate({ humanReviewRequested: true });
    assert.equal(result.authorized, false);
    assert.equal(result.requiresHumanApproval, true);
  });

  test('ESCALATE is never authorized as an automated action', () => {
    const result = evaluate({ proposedAction: 'ESCALATE' });
    assert.equal(result.authorized, false);
    assert.equal(result.requiresHumanApproval, true);
    assert.ok(result.approvalReasons.includes('ESCALATION_REQUIRES_HUMAN'));
  });

  test('exceeding the reminder cap gates further contact on approval', () => {
    const result = evaluate({
      proposedAction: 'REMINDER',
      remindersSent: POLICY.maxRemindersPerPayment,
      confidence: 0.9,
    });
    assert.equal(result.authorized, false);
    assert.equal(result.requiresHumanApproval, true);
  });

  test('no combination of inputs produces authorized alongside approval', () => {
    // Exhaustive guard on the central invariant.
    const variants: Partial<PolicyInput>[] = [
      { amount: 2_500_000 },
      { humanReviewRequested: true },
      { proposedAction: 'ESCALATE' },
      { amount: 5_000_000, confidence: 1 },
      { proposedAction: 'REMINDER', remindersSent: 99 },
    ];
    for (const variant of variants) {
      const result = evaluate(variant);
      if (result.requiresHumanApproval) {
        assert.equal(result.authorized, false, JSON.stringify(variant));
      }
    }
  });
});

describe('policy engine — value never overrides safety', () => {
  test('a high-confidence, high-value retry is still gated', () => {
    // PRD section 16: an action worth a lot must still be blocked by policy.
    const result = evaluate({ amount: 10_000_000, confidence: 1.0, attemptCount: 0 });
    assert.equal(result.authorized, false);
  });

  test('perfect confidence cannot bypass the retry limit', () => {
    const result = evaluate({ confidence: 1.0, attemptCount: 5 });
    assert.equal(result.authorized, false);
    assert.ok(result.denialReasons.includes('MAX_RETRIES_EXCEEDED'));
  });

  test('perfect confidence cannot bypass duplicate protection', () => {
    const result = evaluate({ confidence: 1.0, duplicateActionExists: true });
    assert.equal(result.authorized, false);
  });

  test('the policy input has no expected-value field to reason about', () => {
    // Structural guarantee: economics simply are not visible to this layer.
    const keys = Object.keys(input());
    for (const forbidden of ['expectedValue', 'expectedRecoveryValue', 'adjustedValue']) {
      assert.ok(!keys.includes(forbidden), `PolicyInput exposes "${forbidden}"`);
    }
  });
});

describe('policy engine — multiple simultaneous failures', () => {
  test('all failing rules are reported, not just the first', () => {
    const result = evaluate({
      attemptCount: 5,
      confidence: 0.2,
      duplicateActionExists: true,
      amount: 50_000_000,
    });
    assert.equal(result.authorized, false);
    assert.ok(result.denialReasons.length >= 3, `only got ${result.denialReasons.join(', ')}`);
    for (const expected of [
      'MAX_RETRIES_EXCEEDED',
      'INSUFFICIENT_CONFIDENCE',
      'DUPLICATE_ACTION',
    ] as PolicyReasonCode[]) {
      assert.ok(result.denialReasons.includes(expected), `missing ${expected}`);
    }
    // The oversized amount gates on approval rather than failing outright.
    assert.ok(result.approvalReasons.includes('AMOUNT_EXCEEDS_AUTOMATED_LIMIT'));
  });

  test('a failure alongside an approval gate still blocks', () => {
    const result = evaluate({ amount: 2_500_000, attemptCount: 5 });
    assert.equal(result.authorized, false);
    assert.equal(result.decision, 'BLOCKED', 'a hard failure outranks an approval gate');
  });
});

describe('policy engine — configuration drives behaviour', () => {
  test('raising the retry ceiling changes the outcome', () => {
    const strict = evaluate({ attemptCount: 3 }, { ...POLICY, maxRetryAttempts: 3 });
    const lenient = evaluate({ attemptCount: 3 }, { ...POLICY, maxRetryAttempts: 5 });
    assert.equal(strict.authorized, false);
    assert.equal(lenient.authorized, true);
  });

  test('lowering the confidence minimum changes the outcome', () => {
    const strict = evaluate({ confidence: 0.6 }, { ...POLICY, minRecoveryConfidence: 0.75 });
    const lenient = evaluate({ confidence: 0.6 }, { ...POLICY, minRecoveryConfidence: 0.5 });
    assert.equal(strict.authorized, false);
    assert.equal(lenient.authorized, true);
  });

  test('raising the high-value threshold changes the outcome', () => {
    const strict = evaluate({ amount: 2_500_000 }, { ...POLICY, highValueThreshold: 1_000_000 });
    const lenient = evaluate(
      { amount: 2_500_000 },
      { ...POLICY, highValueThreshold: 5_000_000, maxAutomatedAmount: 5_000_000 },
    );
    assert.equal(strict.requiresHumanApproval, true);
    assert.equal(lenient.authorized, true);
  });

  test('a zero retry ceiling blocks every retry', () => {
    const result = evaluate({ attemptCount: 0 }, { ...POLICY, maxRetryAttempts: 0 });
    assert.equal(result.authorized, false);
    assert.ok(result.denialReasons.includes('MAX_RETRIES_EXCEEDED'));
  });

  test('config values come from the shared loader, not from this module', () => {
    // Guards against policy values drifting into a second parser.
    const fromEnv = loadConfig({
      POLICY_MAX_RETRY_ATTEMPTS: '7',
      POLICY_MIN_RECOVERY_CONFIDENCE: '0.4',
    }).policy;
    assert.equal(fromEnv.maxRetryAttempts, 7);
    const result = evaluate({ attemptCount: 6, confidence: 0.45 }, fromEnv);
    assert.equal(result.authorized, true);
  });
});

describe('policy engine — determinism and structure', () => {
  test('identical input produces identical output', () => {
    const a = evaluate();
    const b = evaluate();
    assert.deepEqual(a, b);
  });

  test('repeated evaluation is stable across many iterations', () => {
    const first = JSON.stringify(evaluate({ amount: 2_500_000, attemptCount: 2 }));
    for (let i = 0; i < 50; i++) {
      assert.equal(JSON.stringify(evaluate({ amount: 2_500_000, attemptCount: 2 })), first);
    }
  });

  test('the policy version is always present', () => {
    for (const variant of [{}, { attemptCount: 9 }, { paymentId: '' }, { amount: 2_500_000 }]) {
      assert.equal(evaluate(variant).policyVersion, POLICY_VERSION);
      assert.equal(evaluate(variant).policyVersion, 'v1');
    }
  });

  test('the evaluated action is echoed back', () => {
    assert.equal(evaluate({ proposedAction: 'REMINDER' }).action, 'REMINDER');
  });

  test('every rule result carries a non-empty reason', () => {
    for (const rule of evaluate({ attemptCount: 9 }).rules) {
      assert.ok(rule.reason.length > 0, `${rule.rule} has no reason`);
    }
  });

  test('a code is present exactly when the rule did not pass', () => {
    for (const rule of evaluate({ attemptCount: 9, confidence: 0.1 }).rules) {
      if (rule.status === 'FAIL' || rule.status === 'REQUIRES_APPROVAL') {
        assert.notEqual(rule.code, null, `${rule.rule} is ${rule.status} without a code`);
      } else {
        assert.equal(rule.code, null, `${rule.rule} is ${rule.status} but carries a code`);
      }
    }
  });

  test('denial reasons match the failing rules exactly', () => {
    const result = evaluate({ attemptCount: 9, confidence: 0.1 });
    const failing = result.rules.filter((r) => r.status === 'FAIL').map((r) => r.code);
    assert.deepEqual(result.denialReasons, failing);
  });

  test('the evaluator does not mutate its input', () => {
    const original = input({ attemptCount: 2 });
    const snapshot = JSON.parse(JSON.stringify(original));
    evaluatePolicy(original, POLICY);
    assert.deepEqual(JSON.parse(JSON.stringify(original)), snapshot);
  });

  test('the evaluator does not mutate the config', () => {
    const config = { ...POLICY };
    const snapshot = { ...config };
    evaluatePolicy(input(), config);
    assert.deepEqual(config, snapshot);
  });
});

describe('policy engine — buildPolicyInput adapter', () => {
  const payment: Payment = {
    id: 'pay_adapter',
    merchantId: 'm1',
    customerId: 'c1',
    orderId: 'o1',
    amount: 249_900,
    currency: 'INR',
    status: 'failed',
    failureReason: 'gateway_timeout',
    attemptCount: 1,
    isSubscription: false,
    createdAt: new Date('2026-08-22T10:00:00.000Z'),
    updatedAt: new Date('2026-08-22T10:05:00.000Z'),
  };

  const assessment = assessRisk(
    { payment, customerHistory: EMPTY_CUSTOMER_HISTORY, now: new Date('2026-08-22T12:00:00.000Z') },
    POLICY,
  );

  test('copies payment facts faithfully', () => {
    const built = buildPolicyInput({
      payment,
      assessment,
      proposedAction: 'RETRY',
      confidence: 0.9,
      duplicateActionExists: false,
    });
    assert.equal(built.paymentId, 'pay_adapter');
    assert.equal(built.amount, 249_900);
    assert.equal(built.attemptCount, 1);
    assert.equal(built.paymentStatus, 'failed');
  });

  test('infers alreadyRecovered from a captured status', () => {
    const built = buildPolicyInput({
      payment: { ...payment, status: 'captured', failureReason: null },
      assessment,
      proposedAction: 'RETRY',
      confidence: 0.9,
      duplicateActionExists: false,
    });
    assert.equal(built.alreadyRecovered, true);
  });

  test('carries the detector human-review flag through', () => {
    const highValue = { ...payment, amount: 5_000_000 };
    const hvAssessment = assessRisk(
      {
        payment: highValue,
        customerHistory: EMPTY_CUSTOMER_HISTORY,
        now: new Date('2026-08-22T12:00:00.000Z'),
      },
      POLICY,
    );
    const built = buildPolicyInput({
      payment: highValue,
      assessment: hvAssessment,
      proposedAction: 'RETRY',
      confidence: 0.9,
      duplicateActionExists: false,
    });
    // Policy must never be more permissive than the detector that preceded it.
    assert.equal(built.humanReviewRequested, true);
  });

  test('does not carry any ground-truth-shaped field', () => {
    const built = buildPolicyInput({
      payment,
      assessment,
      proposedAction: 'RETRY',
      confidence: 0.9,
      duplicateActionExists: false,
    });
    const serialised = JSON.stringify(built);
    for (const forbidden of [
      'groundTruth', 'ground_truth', 'recoverable', 'idealAction',
      'ideal_action', 'split', 'recoveryProbability',
    ]) {
      assert.ok(!serialised.includes(forbidden), `policy input leaked "${forbidden}"`);
    }
  });
});
