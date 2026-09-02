import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { assessRisk } from '../src/risk/detector.ts';
import { EMPTY_CUSTOMER_HISTORY, type CustomerHistory } from '../src/risk/types.ts';
import { loadConfig } from '../src/config/index.ts';
import type { FailureReason, Payment, PaymentStatus } from '../src/shared/types.ts';

const POLICY = loadConfig({}).policy;
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
    // 2 hours before NOW.
    createdAt: new Date('2026-08-22T10:00:00.000Z'),
    updatedAt: new Date('2026-08-22T10:05:00.000Z'),
    ...overrides,
  };
}

function assess(p: Payment, history: CustomerHistory = EMPTY_CUSTOMER_HISTORY) {
  return assessRisk({ payment: p, customerHistory: history, now: NOW }, POLICY);
}

describe('risk detector — successful payments', () => {
  test('a captured payment is NOT revenue at risk', () => {
    const result = assess(payment({ status: 'captured', failureReason: null }));
    assert.equal(result.atRisk, false);
    assert.equal(result.revenueAtRisk, 0);
    assert.equal(result.baselineAction, 'NO_ACTION');
    assert.equal(result.requiresAiDiagnosis, false);
  });

  test('a refunded payment is NOT revenue at risk', () => {
    const result = assess(payment({ status: 'refunded', failureReason: null }));
    assert.equal(result.atRisk, false);
    assert.equal(result.baselineAction, 'NO_ACTION');
  });

  test('a captured payment never triggers an AI call', () => {
    // Guards the money-saving and correctness property that we do not diagnose
    // payments that already succeeded.
    const result = assess(payment({ status: 'captured', failureReason: null, amount: 5_000_000 }));
    assert.equal(result.requiresAiDiagnosis, false);
    assert.equal(result.revenueAtRisk, 0);
  });
});

describe('risk detector — temporary failures', () => {
  test('gateway_timeout is TEMPORARY_FAILURE and retryable', () => {
    const result = assess(payment({ failureReason: 'gateway_timeout' }));
    assert.equal(result.atRisk, true);
    assert.equal(result.classification, 'TEMPORARY_FAILURE');
    assert.equal(result.baselineAction, 'RETRY');
    assert.equal(result.recoverability, 'HIGH');
    assert.equal(result.revenueAtRisk, 249_900);
  });

  test('issuer_down and network_error are also temporary', () => {
    for (const reason of ['issuer_down', 'network_error'] as FailureReason[]) {
      const result = assess(payment({ failureReason: reason }));
      assert.equal(result.classification, 'TEMPORARY_FAILURE', reason);
      assert.equal(result.baselineAction, 'RETRY', reason);
    }
  });

  test('good customer history raises the recoverability score', () => {
    const poor = assess(
      payment(),
      { totalPayments: 10, successfulPayments: 1, failedPayments: 9, successRate: 0.1, lifetimeValue: 1000 },
    );
    const good = assess(
      payment(),
      { totalPayments: 10, successfulPayments: 9, failedPayments: 1, successRate: 0.9, lifetimeValue: 100000 },
    );
    assert.ok(good.recoverabilityScore > poor.recoverabilityScore);
  });
});

describe('risk detector — customer action required', () => {
  test('insufficient_funds recommends a REMINDER, never a retry', () => {
    const result = assess(payment({ failureReason: 'insufficient_funds' }));
    assert.equal(result.classification, 'CUSTOMER_ACTION_REQUIRED');
    assert.equal(result.baselineAction, 'REMINDER');
    // Retrying an unfunded account immediately just fails again.
    assert.notEqual(result.baselineAction, 'RETRY');
  });

  test('authentication_failed requires customer action', () => {
    const result = assess(payment({ failureReason: 'authentication_failed' }));
    assert.equal(result.classification, 'CUSTOMER_ACTION_REQUIRED');
  });
});

describe('risk detector — payment method problems', () => {
  test('card_expired is a method problem and is never retried', () => {
    const result = assess(payment({ failureReason: 'card_expired' }));
    assert.equal(result.classification, 'PAYMENT_METHOD_PROBLEM');
    assert.notEqual(result.baselineAction, 'RETRY');
  });

  test('no non-retryable reason ever yields RETRY', () => {
    // This is the core safety invariant of the baseline action chooser.
    const nonRetryable: FailureReason[] = [
      'card_expired',
      'invalid_cvv',
      'payment_method_unsupported',
      'card_declined',
    ];
    for (const reason of nonRetryable) {
      for (const attempts of [0, 1, 2]) {
        const result = assess(payment({ failureReason: reason, attemptCount: attempts }));
        assert.notEqual(result.baselineAction, 'RETRY', `${reason} @ ${attempts} attempts`);
        assert.notEqual(result.baselineAction, 'SUBSCRIPTION_RETRY', `${reason} @ ${attempts}`);
      }
    }
  });
});

describe('risk detector — checkout abandonment', () => {
  test('recent abandonment is recoverable via CHECKOUT_RECOVERY', () => {
    const result = assess(
      payment({ status: 'abandoned', failureReason: 'customer_dropped_off' }),
    );
    assert.equal(result.classification, 'CHECKOUT_ABANDONMENT');
    assert.equal(result.baselineAction, 'CHECKOUT_RECOVERY');
    assert.equal(result.atRisk, true);
  });

  test('abandonment outside the recovery window takes NO_ACTION', () => {
    const stale = assess(
      payment({
        status: 'abandoned',
        failureReason: 'session_expired',
        // 200 hours before NOW, well beyond the 72h default window.
        createdAt: new Date(NOW.getTime() - 200 * 3_600_000),
      }),
    );
    assert.equal(stale.baselineAction, 'NO_ACTION');
    assert.ok(stale.factors.some((f) => f.includes('outside_recovery_window')));
  });
});

describe('risk detector — subscription failures', () => {
  test('a failed subscription charge is SUBSCRIPTION_FAILURE', () => {
    const result = assess(
      payment({ isSubscription: true, failureReason: 'subscription_charge_failed' }),
    );
    assert.equal(result.classification, 'SUBSCRIPTION_FAILURE');
    assert.equal(result.baselineAction, 'SUBSCRIPTION_RETRY');
  });

  test('a subscription with an expired card is not retried', () => {
    const result = assess(payment({ isSubscription: true, failureReason: 'card_expired' }));
    assert.notEqual(result.baselineAction, 'SUBSCRIPTION_RETRY');
    assert.equal(result.baselineAction, 'REMINDER');
  });
});

describe('risk detector — repeated failures', () => {
  test('exhausted retries become REPEATED_FAILURE and ESCALATE', () => {
    const result = assess(payment({ attemptCount: POLICY.maxRetryAttempts }));
    assert.equal(result.classification, 'REPEATED_FAILURE');
    assert.equal(result.baselineAction, 'ESCALATE');
  });

  test('repeated failure overrides an otherwise temporary reason', () => {
    // A gateway timeout that has already failed 3 times is not a fresh blip.
    const result = assess(payment({ failureReason: 'gateway_timeout', attemptCount: 3 }));
    assert.equal(result.classification, 'REPEATED_FAILURE');
    assert.notEqual(result.baselineAction, 'RETRY');
  });

  test('a permanently failed case never becomes a retry candidate', () => {
    const result = assess(payment({ failureReason: 'card_declined', attemptCount: 4 }));
    assert.notEqual(result.baselineAction, 'RETRY');
    assert.equal(result.baselineAction, 'ESCALATE');
  });

  test('exhausted retries skip AI diagnosis', () => {
    const result = assess(payment({ attemptCount: 5 }));
    assert.equal(result.requiresAiDiagnosis, false);
  });

  test('each attempt lowers the recoverability score', () => {
    const zero = assess(payment({ attemptCount: 0 }));
    const one = assess(payment({ attemptCount: 1 }));
    const two = assess(payment({ attemptCount: 2 }));
    assert.ok(zero.recoverabilityScore > one.recoverabilityScore);
    assert.ok(one.recoverabilityScore > two.recoverabilityScore);
  });
});

describe('risk detector — unknown failures', () => {
  test('an unknown reason stays conservative and escalates', () => {
    const result = assess(payment({ failureReason: 'unknown' }));
    assert.equal(result.classification, 'UNKNOWN');
    // PRD section 10: UNKNOWN_FAILURE = no automatic action.
    assert.equal(result.baselineAction, 'ESCALATE');
    assert.equal(result.requiresHumanReview, true);
  });

  test('a missing failure reason on a failed payment is UNKNOWN', () => {
    const result = assess(payment({ failureReason: null }));
    assert.equal(result.classification, 'UNKNOWN');
    assert.equal(result.baselineAction, 'ESCALATE');
  });

  test('an unknown failure never recommends an automated money action', () => {
    const result = assess(payment({ failureReason: 'unknown' }));
    for (const forbidden of ['RETRY', 'SUBSCRIPTION_RETRY']) {
      assert.notEqual(result.baselineAction, forbidden);
    }
  });
});

describe('risk detector — high-value payments', () => {
  test('a payment above the automated ceiling requires human review', () => {
    const result = assess(payment({ amount: POLICY.highValueThreshold + 1 }));
    assert.equal(result.requiresHumanReview, true);
    assert.ok(result.factors.some((f) => f.includes('high_value')));
  });

  test('a payment below the ceiling does not require review by value', () => {
    const result = assess(payment({ amount: 100_000 }));
    assert.equal(result.requiresHumanReview, false);
  });

  test('high value raises the risk score', () => {
    const small = assess(payment({ amount: 10_000 }));
    const large = assess(payment({ amount: 2_000_000 }));
    assert.ok(large.riskScore > small.riskScore);
  });
});

describe('risk detector — malformed and edge-case data', () => {
  test('an unrecognised status escalates rather than guessing', () => {
    const result = assess(payment({ status: 'weird_status' as PaymentStatus }));
    assert.equal(result.atRisk, false);
    assert.equal(result.baselineAction, 'ESCALATE');
    assert.equal(result.requiresHumanReview, true);
  });

  test('a future createdAt clamps age to zero rather than going negative', () => {
    const result = assess(payment({ createdAt: new Date(NOW.getTime() + 10 * 3_600_000) }));
    assert.equal(result.ageHours, 0);
  });

  test('scores always stay within [0,1]', () => {
    const cases: Partial<Payment>[] = [
      { attemptCount: 99 },
      { amount: 1 },
      { amount: Number.MAX_SAFE_INTEGER },
      { createdAt: new Date(NOW.getTime() - 10_000 * 3_600_000) },
      { failureReason: 'unknown', attemptCount: 50 },
    ];
    for (const override of cases) {
      const result = assess(payment(override));
      assert.ok(result.riskScore >= 0 && result.riskScore <= 1, `risk ${result.riskScore}`);
      assert.ok(
        result.recoverabilityScore >= 0 && result.recoverabilityScore <= 1,
        `recoverability ${result.recoverabilityScore}`,
      );
    }
  });

  test('is a pure function: same input yields identical output', () => {
    const p = payment();
    const a = assess(p);
    const b = assess(p);
    assert.deepEqual(a, b);
  });

  test('always produces explanatory factors', () => {
    const result = assess(payment());
    assert.ok(result.factors.length > 0);
    assert.ok(result.reason.length > 0);
  });
});

describe('risk detector — revenue at risk is from real payment data', () => {
  test('revenue at risk equals the payment amount for at-risk payments', () => {
    for (const amount of [1, 99, 249_900, 5_000_000]) {
      const result = assess(payment({ amount }));
      assert.equal(result.revenueAtRisk, amount);
    }
  });

  test('revenue at risk is zero for settled payments', () => {
    assert.equal(assess(payment({ status: 'captured', failureReason: null })).revenueAtRisk, 0);
    assert.equal(assess(payment({ status: 'refunded', failureReason: null })).revenueAtRisk, 0);
  });
});

describe('risk detection — unrecognised failure reasons', () => {
  test('an unknown reason classifies as UNKNOWN rather than throwing', () => {
    const assessment = assessRisk(
      {
        payment: { ...payment(), failureReason: 'some_reason_not_in_the_enum' } as unknown as Payment,
        customerHistory: EMPTY_CUSTOMER_HISTORY,
        now: NOW,
      },
      POLICY,
    );

    assert.equal(assessment.classification, 'UNKNOWN');
    assert.ok(Number.isFinite(assessment.ageHours));
    assert.ok(Number.isFinite(assessment.recoverabilityScore));
    assert.equal(assessment.requiresHumanReview, true);
  });
});
