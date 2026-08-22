import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { MockAIProvider } from '../src/agents/diagnosis/providers/mock.ts';
import { createAIProvider, UnimplementedProviderError } from '../src/agents/diagnosis/factory.ts';
import { buildDiagnosisInput, SUPPORTED_ACTIONS } from '../src/agents/diagnosis/input.ts';
import {
  validateDiagnosis,
  DiagnosisValidationError,
  type DiagnosisInput,
} from '../src/agents/diagnosis/types.ts';
import { assessRisk } from '../src/risk/detector.ts';
import { EMPTY_CUSTOMER_HISTORY, type CustomerHistory } from '../src/risk/types.ts';
import { loadConfig } from '../src/config/index.ts';
import { RECOVERY_ACTIONS, CLASSIFICATIONS } from '../src/shared/types.ts';
import type { FailureReason, Payment, PaymentStatus } from '../src/shared/types.ts';

const CONFIG = loadConfig({});
const POLICY = CONFIG.policy;
const NOW = new Date('2026-08-22T12:00:00.000Z');

function payment(overrides: Partial<Payment> = {}): Payment {
  return {
    id: 'pay_test',
    merchantId: 'merchant_001',
    customerId: 'cust_001',
    orderId: 'order_test',
    amount: 249_900,
    currency: 'INR',
    status: 'failed' as PaymentStatus,
    failureReason: 'gateway_timeout' as FailureReason,
    attemptCount: 0,
    isSubscription: false,
    createdAt: new Date('2026-08-22T10:00:00.000Z'),
    updatedAt: new Date('2026-08-22T10:05:00.000Z'),
    ...overrides,
  };
}

function inputFor(p: Payment, history: CustomerHistory = EMPTY_CUSTOMER_HISTORY): DiagnosisInput {
  const assessment = assessRisk({ payment: p, customerHistory: history, now: NOW }, POLICY);
  return buildDiagnosisInput({ payment: p, customerHistory: history, assessment, policy: POLICY });
}

describe('MockAI — determinism', () => {
  test('the same input yields byte-identical output', async () => {
    const provider = new MockAIProvider();
    const input = inputFor(payment());
    const a = await provider.diagnose(input);
    const b = await provider.diagnose(input);
    assert.deepEqual(a, b);
  });

  test('repeated calls across instances agree', async () => {
    const input = inputFor(payment());
    const a = await new MockAIProvider().diagnose(input);
    const b = await new MockAIProvider().diagnose(input);
    assert.deepEqual(a, b);
  });

  test('produces stable exact values for a known input', async () => {
    // Pinned so an unintended change to the scoring is caught immediately.
    const result = await new MockAIProvider().diagnose(inputFor(payment()));
    assert.equal(result.classification, 'TEMPORARY_FAILURE');
    assert.equal(result.recommendedAction, 'RETRY');
    assert.equal(result.confidence, 0.92);
    assert.equal(result.provider, 'mock');
    assert.equal(result.model, 'deterministic');
  });

  test('different inputs produce different diagnoses', async () => {
    const provider = new MockAIProvider();
    const timeout = await provider.diagnose(inputFor(payment({ failureReason: 'gateway_timeout' })));
    const funds = await provider.diagnose(inputFor(payment({ failureReason: 'insufficient_funds' })));
    assert.notEqual(timeout.recommendedAction, funds.recommendedAction);
  });
});

describe('MockAI — case coverage', () => {
  const provider = new MockAIProvider();

  test('gateway_timeout recommends RETRY', async () => {
    const r = await provider.diagnose(inputFor(payment({ failureReason: 'gateway_timeout' })));
    assert.equal(r.classification, 'TEMPORARY_FAILURE');
    assert.equal(r.recommendedAction, 'RETRY');
  });

  test('network_error recommends RETRY', async () => {
    const r = await provider.diagnose(inputFor(payment({ failureReason: 'network_error' })));
    assert.equal(r.recommendedAction, 'RETRY');
  });

  test('insufficient_funds recommends REMINDER', async () => {
    const r = await provider.diagnose(inputFor(payment({ failureReason: 'insufficient_funds' })));
    assert.equal(r.classification, 'CUSTOMER_ACTION_REQUIRED');
    assert.equal(r.recommendedAction, 'REMINDER');
  });

  test('card_expired never recommends RETRY', async () => {
    const r = await provider.diagnose(inputFor(payment({ failureReason: 'card_expired' })));
    assert.notEqual(r.recommendedAction, 'RETRY');
  });

  test('checkout abandonment recommends CHECKOUT_RECOVERY', async () => {
    const r = await provider.diagnose(
      inputFor(payment({ status: 'abandoned', failureReason: 'customer_dropped_off' })),
    );
    assert.equal(r.classification, 'CHECKOUT_ABANDONMENT');
    assert.equal(r.recommendedAction, 'CHECKOUT_RECOVERY');
  });

  test('subscription failure recommends SUBSCRIPTION_RETRY', async () => {
    const r = await provider.diagnose(
      inputFor(payment({ isSubscription: true, failureReason: 'subscription_charge_failed' })),
    );
    assert.equal(r.classification, 'SUBSCRIPTION_FAILURE');
    assert.equal(r.recommendedAction, 'SUBSCRIPTION_RETRY');
  });

  test('repeated failure escalates and requires approval', async () => {
    const r = await provider.diagnose(inputFor(payment({ attemptCount: 3 })));
    assert.equal(r.classification, 'REPEATED_FAILURE');
    assert.equal(r.recommendedAction, 'ESCALATE');
    assert.equal(r.requiresHumanApproval, true);
  });

  test('unknown failure escalates with low confidence', async () => {
    const r = await provider.diagnose(inputFor(payment({ failureReason: 'unknown' })));
    assert.equal(r.classification, 'UNKNOWN');
    assert.equal(r.recommendedAction, 'ESCALATE');
    assert.ok(r.confidence < 0.75, `confidence ${r.confidence} should be low`);
    assert.equal(r.requiresHumanApproval, true);
  });

  test('high-value payments require human approval', async () => {
    const r = await provider.diagnose(
      inputFor(payment({ amount: POLICY.maxAutomatedAmount + 1 })),
    );
    assert.equal(r.requiresHumanApproval, true);
  });
});

describe('MockAI — output is always valid', () => {
  test('every generated diagnosis satisfies the strict schema', async () => {
    const provider = new MockAIProvider();
    const reasons: (FailureReason | null)[] = [
      'gateway_timeout', 'issuer_down', 'network_error', 'insufficient_funds',
      'card_expired', 'card_declined', 'invalid_cvv', 'authentication_failed',
      'payment_method_unsupported', 'customer_dropped_off', 'session_expired',
      'subscription_charge_failed', 'unknown', null,
    ];

    for (const reason of reasons) {
      for (const attempts of [0, 1, 2, 3]) {
        for (const amount of [100, 249_900, 5_000_000]) {
          const status: PaymentStatus =
            reason === 'customer_dropped_off' || reason === 'session_expired'
              ? 'abandoned'
              : 'failed';
          const result = await provider.diagnose(
            inputFor(payment({ failureReason: reason, attemptCount: attempts, amount, status })),
          );
          assert.ok(CLASSIFICATIONS.includes(result.classification));
          assert.ok(RECOVERY_ACTIONS.includes(result.recommendedAction));
          assert.ok(result.confidence >= 0 && result.confidence <= 1);
          assert.ok(
            result.expectedRecoveryProbability >= 0 && result.expectedRecoveryProbability <= 1,
          );
          assert.ok(result.reason.length > 0 && result.reason.length <= 500);
        }
      }
    }
  });

  test('only ever recommends a supported action', async () => {
    const provider = new MockAIProvider();
    const result = await provider.diagnose(inputFor(payment()));
    assert.ok(SUPPORTED_ACTIONS.includes(result.recommendedAction));
  });
});

describe('diagnosis validation — rejects bad model output', () => {
  const valid = {
    classification: 'TEMPORARY_FAILURE',
    confidence: 0.94,
    reason: 'Temporary gateway timeout is likely recoverable.',
    recommended_action: 'RETRY',
    expected_recovery_probability: 0.78,
  };

  test('accepts a valid PRD-shaped response', () => {
    const result = validateDiagnosis(valid, 'test', 'test-model');
    assert.equal(result.classification, 'TEMPORARY_FAILURE');
    assert.equal(result.recommendedAction, 'RETRY');
    assert.equal(result.confidence, 0.94);
  });

  test('accepts the response as a JSON string', () => {
    const result = validateDiagnosis(JSON.stringify(valid), 'test', 'test-model');
    assert.equal(result.classification, 'TEMPORARY_FAILURE');
  });

  test('normalises PAYMENT_REMINDER to REMINDER', () => {
    // The PRD prose and the domain enum use different spellings for the same
    // action; both must be accepted and unified.
    const result = validateDiagnosis(
      { ...valid, recommended_action: 'PAYMENT_REMINDER' },
      'test',
      'm',
    );
    assert.equal(result.recommendedAction, 'REMINDER');
  });

  test('rejects malformed JSON', () => {
    assert.throws(
      () => validateDiagnosis('{not valid json', 'test', 'm'),
      DiagnosisValidationError,
    );
  });

  test('rejects a missing classification', () => {
    const { classification, ...rest } = valid;
    void classification;
    assert.throws(() => validateDiagnosis(rest, 'test', 'm'), DiagnosisValidationError);
  });

  test('rejects an invalid classification', () => {
    assert.throws(
      () => validateDiagnosis({ ...valid, classification: 'MADE_UP_CATEGORY' }, 'test', 'm'),
      DiagnosisValidationError,
    );
  });

  test('rejects an unknown action', () => {
    assert.throws(
      () => validateDiagnosis({ ...valid, recommended_action: 'REFUND_EVERYTHING' }, 'test', 'm'),
      DiagnosisValidationError,
    );
  });

  test('rejects confidence outside [0,1]', () => {
    for (const bad of [-0.1, 1.1, 42, Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.throws(
        () => validateDiagnosis({ ...valid, confidence: bad }, 'test', 'm'),
        DiagnosisValidationError,
        `confidence ${bad} should be rejected`,
      );
    }
  });

  test('rejects recovery probability outside [0,1]', () => {
    for (const bad of [-0.5, 1.5, Number.NaN]) {
      assert.throws(
        () => validateDiagnosis({ ...valid, expected_recovery_probability: bad }, 'test', 'm'),
        DiagnosisValidationError,
        `probability ${bad} should be rejected`,
      );
    }
  });

  test('rejects a non-numeric confidence', () => {
    assert.throws(
      () => validateDiagnosis({ ...valid, confidence: '0.9' }, 'test', 'm'),
      DiagnosisValidationError,
    );
  });

  test('rejects an empty reason', () => {
    assert.throws(
      () => validateDiagnosis({ ...valid, reason: '   ' }, 'test', 'm'),
      DiagnosisValidationError,
    );
  });

  test('rejects an array or a scalar', () => {
    for (const bad of [[valid], 42, true, null]) {
      assert.throws(() => validateDiagnosis(bad, 'test', 'm'), DiagnosisValidationError);
    }
  });

  test('rejects an invented payment_id field', () => {
    // A model must not smuggle in payment identifiers it was not given.
    assert.throws(
      () => validateDiagnosis({ ...valid, payment_id: 'pay_invented' }, 'test', 'm'),
      DiagnosisValidationError,
    );
  });

  test('rejects embedded API instructions', () => {
    // Strict mode refuses anything resembling an execution directive.
    for (const injected of [
      { api_endpoint: 'https://api.razorpay.com/v1/payments' },
      { execute: true },
      { command: 'capture_payment' },
    ]) {
      assert.throws(
        () => validateDiagnosis({ ...valid, ...injected }, 'test', 'm'),
        DiagnosisValidationError,
        `should reject ${JSON.stringify(injected)}`,
      );
    }
  });

  test('validation errors carry field-level detail', () => {
    try {
      validateDiagnosis({ ...valid, confidence: 5 }, 'test', 'm');
      assert.fail('should have thrown');
    } catch (error) {
      assert.ok(error instanceof DiagnosisValidationError);
      assert.ok(error.issues.length > 0);
      assert.ok(error.message.includes('confidence'));
    }
  });
});

describe('provider factory', () => {
  test('returns MockAI when configured for mock', () => {
    const provider = createAIProvider(loadConfig({ AI_PROVIDER: 'mock' }));
    assert.equal(provider.name, 'mock');
  });

  test('mock is the default', () => {
    assert.equal(createAIProvider(loadConfig({})).name, 'mock');
  });

  test('unimplemented providers throw rather than silently falling back', () => {
    // Failing loudly beats quietly producing MockAI output while the operator
    // believes a real model is running.
    assert.throws(
      () => createAIProvider(loadConfig({ AI_PROVIDER: 'claude', ANTHROPIC_API_KEY: 'sk-ant-x' })),
      UnimplementedProviderError,
    );
    assert.throws(
      () => createAIProvider(loadConfig({ AI_PROVIDER: 'openai', OPENAI_API_KEY: 'sk-x' })),
      UnimplementedProviderError,
    );
  });
});
