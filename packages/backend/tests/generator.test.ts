import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { generateDataset, summariseDataset } from '../src/datasets/generator.ts';
import { SCENARIOS } from '../src/datasets/scenarios.ts';
import { CLASSIFICATIONS, RECOVERY_ACTIONS, PAYMENT_STATUSES } from '../src/shared/types.ts';
import type { SyntheticDataset } from '../src/shared/types.ts';

const BASE_OPTIONS = {
  seed: 42,
  recordCount: 1000,
  evalSplit: 0.3,
  avgTransactionValue: 250_000,
  customerRepeatRate: 0.45,
} as const;

function hashOf(dataset: SyntheticDataset): string {
  return createHash('sha256').update(JSON.stringify(dataset)).digest('hex');
}

describe('generateDataset — determinism', () => {
  test('the same seed produces a byte-identical dataset', () => {
    const a = generateDataset({ ...BASE_OPTIONS });
    const b = generateDataset({ ...BASE_OPTIONS });
    assert.equal(hashOf(a), hashOf(b));
  });

  test('a different seed produces a different dataset', () => {
    const a = generateDataset({ ...BASE_OPTIONS });
    const b = generateDataset({ ...BASE_OPTIONS, seed: 43 });
    assert.notEqual(hashOf(a), hashOf(b));
  });

  test('generation does not depend on the wall clock', () => {
    // Two runs separated in time must still match, because `now` is pinned.
    const a = generateDataset({ ...BASE_OPTIONS, recordCount: 50 });
    const later = Date.now() + 1;
    while (Date.now() < later) {
      /* spin briefly so the clock definitely advances */
    }
    const b = generateDataset({ ...BASE_OPTIONS, recordCount: 50 });
    assert.equal(hashOf(a), hashOf(b));
  });

  test('changing evalSplit does not perturb the payment data', () => {
    const a = generateDataset({ ...BASE_OPTIONS, recordCount: 200, evalSplit: 0.2 });
    const b = generateDataset({ ...BASE_OPTIONS, recordCount: 200, evalSplit: 0.5 });
    // Splits differ, but every payment must be identical.
    assert.deepEqual(
      a.records.map((r) => r.payment),
      b.records.map((r) => r.payment),
    );
  });
});

describe('generateDataset — shape and volume', () => {
  const dataset = generateDataset({ ...BASE_OPTIONS });

  test('produces the requested record count (PRD: at least 500)', () => {
    assert.equal(dataset.records.length, 1000);
    assert.ok(dataset.records.length >= 500);
  });

  test('payment ids are unique', () => {
    const ids = new Set(dataset.records.map((r) => r.payment.id));
    assert.equal(ids.size, dataset.records.length);
  });

  test('order ids are unique', () => {
    const ids = new Set(dataset.records.map((r) => r.payment.orderId));
    assert.equal(ids.size, dataset.records.length);
  });

  test('every payment references an existing merchant and customer', () => {
    const merchantIds = new Set(dataset.merchants.map((m) => m.id));
    const customerIds = new Set(dataset.customers.map((c) => c.id));
    for (const { payment } of dataset.records) {
      assert.ok(merchantIds.has(payment.merchantId), `orphan merchant ${payment.merchantId}`);
      assert.ok(customerIds.has(payment.customerId), `orphan customer ${payment.customerId}`);
    }
  });

  test('each customer belongs to the merchant on their payments', () => {
    const merchantOf = new Map(dataset.customers.map((c) => [c.id, c.merchantId]));
    for (const { payment } of dataset.records) {
      assert.equal(merchantOf.get(payment.customerId), payment.merchantId);
    }
  });

  test('customer repeat rate actually produces repeat customers', () => {
    // With repeatRate 0.45 over 1000 payments, customers must be far fewer
    // than payments — otherwise history is not a usable signal.
    assert.ok(
      dataset.customers.length < dataset.records.length * 0.8,
      `expected repeat customers, got ${dataset.customers.length} for ${dataset.records.length} payments`,
    );
  });
});

describe('generateDataset — money invariants', () => {
  const dataset = generateDataset({ ...BASE_OPTIONS });

  test('every amount is a positive integer in minor units', () => {
    for (const { payment } of dataset.records) {
      assert.ok(Number.isInteger(payment.amount), `${payment.id} amount is not an integer`);
      assert.ok(payment.amount > 0, `${payment.id} amount is not positive`);
      assert.ok(Number.isSafeInteger(payment.amount), `${payment.id} amount exceeds safe range`);
    }
  });

  test('currency is always INR', () => {
    for (const { payment } of dataset.records) assert.equal(payment.currency, 'INR');
  });

  test('produces high-value transactions above the default automation ceiling', () => {
    // The default POLICY_MAX_AUTOMATED_AMOUNT is 1,000,000 paise (INR 10,000).
    // Without these the manual-approval path would never be exercised.
    const highValue = dataset.records.filter((r) => r.payment.amount > 1_000_000);
    assert.ok(highValue.length > 0, 'dataset contains no high-value transactions');
  });
});

describe('generateDataset — field validity', () => {
  const dataset = generateDataset({ ...BASE_OPTIONS });

  test('statuses, classifications and actions are all in their enums', () => {
    for (const { payment, groundTruth } of dataset.records) {
      assert.ok(PAYMENT_STATUSES.includes(payment.status));
      assert.ok(CLASSIFICATIONS.includes(groundTruth.classification));
      assert.ok(RECOVERY_ACTIONS.includes(groundTruth.idealAction));
    }
  });

  test('captured payments carry no failure reason; failed ones do', () => {
    for (const { payment } of dataset.records) {
      if (payment.status === 'captured') {
        assert.equal(payment.failureReason, null, `${payment.id} captured but has a failure reason`);
      } else {
        assert.notEqual(payment.failureReason, null, `${payment.id} ${payment.status} with no reason`);
      }
    }
  });

  test('recovery probability is a valid probability', () => {
    for (const { groundTruth } of dataset.records) {
      const p = groundTruth.recoveryProbability;
      assert.ok(p >= 0 && p <= 1, `probability ${p} out of range`);
    }
  });

  test('attempt counts are non-negative', () => {
    for (const { payment } of dataset.records) {
      assert.ok(payment.attemptCount >= 0 && Number.isInteger(payment.attemptCount));
    }
  });

  test('updatedAt is never before createdAt, and nothing is in the future', () => {
    const now = new Date(dataset.generatedAt).getTime();
    for (const { payment } of dataset.records) {
      assert.ok(
        payment.updatedAt.getTime() >= payment.createdAt.getTime(),
        `${payment.id} updated before created`,
      );
      assert.ok(payment.createdAt.getTime() <= now, `${payment.id} created in the future`);
    }
  });

  test('non-recoverable records never carry a high recovery probability', () => {
    for (const { groundTruth, payment } of dataset.records) {
      if (!groundTruth.recoverable && payment.status !== 'captured') {
        assert.ok(
          groundTruth.recoveryProbability < 0.5,
          `${payment.id} is non-recoverable but has probability ${groundTruth.recoveryProbability}`,
        );
      }
    }
  });
});

describe('generateDataset — class coverage', () => {
  const dataset = generateDataset({ ...BASE_OPTIONS });
  const summary = summariseDataset(dataset);

  test('every PRD-required class appears in the dataset', () => {
    // PRD section 17 enumerates the classes the dataset must contain.
    const statuses = new Set(dataset.records.map((r) => r.payment.status));
    assert.ok(statuses.has('captured'), 'no successful payments');
    assert.ok(statuses.has('failed'), 'no failed payments');
    assert.ok(statuses.has('abandoned'), 'no checkout abandonment');

    for (const cls of [
      'TEMPORARY_FAILURE',
      'CUSTOMER_ACTION_REQUIRED',
      'PAYMENT_METHOD_PROBLEM',
      'CHECKOUT_ABANDONMENT',
      'SUBSCRIPTION_FAILURE',
      'REPEATED_FAILURE',
      'UNKNOWN',
    ]) {
      assert.ok((summary.byClassification[cls] ?? 0) > 0, `class ${cls} is absent`);
    }
  });

  test('contains both recoverable and non-recoverable cases', () => {
    const failures = dataset.records.filter((r) => r.payment.status !== 'captured');
    assert.ok(failures.some((r) => r.groundTruth.recoverable), 'no recoverable cases');
    assert.ok(failures.some((r) => !r.groundTruth.recoverable), 'no non-recoverable cases');
  });

  test('contains multi-retry failures', () => {
    assert.ok(
      dataset.records.some((r) => r.payment.attemptCount >= 3),
      'no payments with exhausted retries',
    );
  });

  test('contains subscription payments', () => {
    assert.ok(dataset.records.some((r) => r.payment.isSubscription), 'no subscription payments');
  });

  test('every scenario in the catalogue is actually reachable', () => {
    // Guards against a scenario being defined but never sampled.
    const seen = new Set(
      dataset.records.map((r) => `${r.groundTruth.classification}:${r.payment.status}`),
    );
    for (const scenario of SCENARIOS) {
      assert.ok(
        seen.has(`${scenario.classification}:${scenario.status}`),
        `scenario ${scenario.key} never produced a record`,
      );
    }
  });
});

describe('generateDataset — train/eval split', () => {
  const dataset = generateDataset({ ...BASE_OPTIONS });

  test('both splits are populated and sum to the total', () => {
    const dev = dataset.records.filter((r) => r.split === 'dev').length;
    const evalCount = dataset.records.filter((r) => r.split === 'eval').length;
    assert.ok(dev > 0 && evalCount > 0);
    assert.equal(dev + evalCount, dataset.records.length);
  });

  test('eval split is close to the requested fraction', () => {
    const evalCount = dataset.records.filter((r) => r.split === 'eval').length;
    const ratio = evalCount / dataset.records.length;
    // Per-class rounding means it will not land exactly on 0.30.
    assert.ok(ratio > 0.27 && ratio < 0.33, `eval ratio ${ratio} far from 0.30`);
  });

  test('the split is stratified: every class appears in the eval set', () => {
    const evalClasses = new Set(
      dataset.records.filter((r) => r.split === 'eval').map((r) => r.groundTruth.classification),
    );
    const allClasses = new Set(dataset.records.map((r) => r.groundTruth.classification));
    assert.deepEqual([...evalClasses].sort(), [...allClasses].sort());
  });

  test('no payment appears in both splits', () => {
    const devIds = new Set(
      dataset.records.filter((r) => r.split === 'dev').map((r) => r.payment.id),
    );
    for (const record of dataset.records.filter((r) => r.split === 'eval')) {
      assert.ok(!devIds.has(record.payment.id), `${record.payment.id} leaked across splits`);
    }
  });
});

describe('summariseDataset', () => {
  const dataset = generateDataset({ ...BASE_OPTIONS });
  const summary = summariseDataset(dataset);

  test('revenue at risk equals the sum of non-captured amounts', () => {
    const expected = dataset.records
      .filter((r) => r.payment.status !== 'captured')
      .reduce((sum, r) => sum + r.payment.amount, 0);
    assert.equal(summary.revenueAtRiskMinor, expected);
  });

  test('recoverable revenue never exceeds revenue at risk', () => {
    assert.ok(summary.recoverableRevenueMinor <= summary.revenueAtRiskMinor);
    assert.ok(summary.recoverableRevenueMinor > 0);
  });

  test('status counts sum to the record count', () => {
    const total = Object.values(summary.byStatus).reduce((a, b) => a + b, 0);
    assert.equal(total, summary.totalRecords);
  });

  test('reported counts match the dataset arrays', () => {
    assert.equal(summary.merchants, dataset.merchants.length);
    assert.equal(summary.customers, dataset.customers.length);
    assert.equal(summary.devRecords + summary.evalRecords, summary.totalRecords);
  });
});

describe('generateDataset — input validation', () => {
  test('rejects a zero record count', () => {
    assert.throws(() => generateDataset({ ...BASE_OPTIONS, recordCount: 0 }), RangeError);
  });

  test('rejects an out-of-range eval split', () => {
    assert.throws(() => generateDataset({ ...BASE_OPTIONS, evalSplit: 0 }), RangeError);
    assert.throws(() => generateDataset({ ...BASE_OPTIONS, evalSplit: 1 }), RangeError);
  });

  test('rejects an invalid now value', () => {
    assert.throws(() => generateDataset({ ...BASE_OPTIONS, now: 'not-a-date' }), RangeError);
  });

  test('handles a small record count without crashing', () => {
    const tiny = generateDataset({ ...BASE_OPTIONS, recordCount: 5 });
    assert.equal(tiny.records.length, 5);
  });
});
