import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  scoreBinary,
  scoreClassification,
  UNKNOWN_LABEL,
  type LabelledPair,
} from '../src/analytics/metrics.ts';

/**
 * METRIC CORRECTNESS
 *
 * Every expected value here is computed BY HAND from the definitions, not
 * copied from a previous run. A metrics module that agrees with itself proves
 * nothing; these fixtures are small enough to verify on paper.
 */

const LABELS = ['A', 'B', 'C'] as const;

describe('metrics — degenerate inputs', () => {
  test('an empty set produces zeros, never NaN', () => {
    const report = scoreClassification([], LABELS);

    assert.equal(report.total, 0);
    assert.equal(report.correct, 0);
    assert.equal(report.accuracy, 0);
    assert.equal(report.macroF1, 0);
    assert.equal(report.weightedF1, 0);
    for (const value of [report.accuracy, report.macroF1, report.macroPrecision, report.weightedF1]) {
      assert.ok(!Number.isNaN(value), 'a metric was NaN on an empty set');
    }
  });

  test('a single correct record scores 1 on its class only', () => {
    const report = scoreClassification([{ expected: 'A', predicted: 'A' }], LABELS);

    assert.equal(report.total, 1);
    assert.equal(report.accuracy, 1);

    const a = report.perClass.find((c) => c.label === 'A')!;
    assert.deepEqual(
      { p: a.precision, r: a.recall, f1: a.f1, support: a.support },
      { p: 1, r: 1, f1: 1, support: 1 },
    );

    // B and C have no support and no predictions: 0, not NaN.
    for (const label of ['B', 'C']) {
      const c = report.perClass.find((x) => x.label === label)!;
      assert.equal(c.support, 0);
      assert.equal(c.precision, 0);
      assert.equal(c.recall, 0);
      assert.equal(c.f1, 0);
      assert.ok(!Number.isNaN(c.f1));
    }
    // Macro F1 averages over ALL classes, so one perfect class of three = 1/3.
    assert.equal(report.macroF1, 0.3333);
    // Weighted F1 weights by support, so it is 1 here.
    assert.equal(report.weightedF1, 1);
  });

  test('a single wrong record scores zero everywhere', () => {
    const report = scoreClassification([{ expected: 'A', predicted: 'B' }], LABELS);
    assert.equal(report.accuracy, 0);
    assert.equal(report.macroF1, 0);
    assert.equal(report.perClass.find((c) => c.label === 'A')!.recall, 0);
    assert.equal(report.perClass.find((c) => c.label === 'B')!.precision, 0);
  });

  test('a class with predictions but no support has precision 0, not NaN', () => {
    // B is never the truth, but is predicted once.
    const report = scoreClassification(
      [
        { expected: 'A', predicted: 'A' },
        { expected: 'A', predicted: 'B' },
      ],
      LABELS,
    );
    const b = report.perClass.find((c) => c.label === 'B')!;
    assert.equal(b.support, 0);
    assert.equal(b.falsePositives, 1);
    assert.equal(b.precision, 0);
    assert.ok(!Number.isNaN(b.precision));
  });
});

describe('metrics — hand-computed values', () => {
  // 6 records:
  //   A->A, A->A, A->B, B->B, B->A, C->C
  //
  // A: tp=2 fp=1 fn=1  -> P = 2/3 = 0.6667, R = 2/3 = 0.6667, F1 = 0.6667
  // B: tp=1 fp=1 fn=1  -> P = 1/2 = 0.5,    R = 1/2 = 0.5,    F1 = 0.5
  // C: tp=1 fp=0 fn=0  -> P = 1, R = 1, F1 = 1
  // accuracy = 4/6 = 0.6667
  // macro F1 = (0.6667 + 0.5 + 1) / 3 = 0.7222
  const pairs: LabelledPair[] = [
    { expected: 'A', predicted: 'A' },
    { expected: 'A', predicted: 'A' },
    { expected: 'A', predicted: 'B' },
    { expected: 'B', predicted: 'B' },
    { expected: 'B', predicted: 'A' },
    { expected: 'C', predicted: 'C' },
  ];
  const report = scoreClassification(pairs, LABELS);

  test('accuracy matches the hand count', () => {
    assert.equal(report.correct, 4);
    assert.equal(report.total, 6);
    assert.equal(report.accuracy, 0.6667);
  });

  test('per-class precision, recall and F1 match', () => {
    const a = report.perClass.find((c) => c.label === 'A')!;
    assert.deepEqual([a.truePositives, a.falsePositives, a.falseNegatives], [2, 1, 1]);
    assert.equal(a.precision, 0.6667);
    assert.equal(a.recall, 0.6667);
    assert.equal(a.f1, 0.6667);

    const b = report.perClass.find((c) => c.label === 'B')!;
    assert.deepEqual([b.truePositives, b.falsePositives, b.falseNegatives], [1, 1, 1]);
    assert.equal(b.precision, 0.5);
    assert.equal(b.recall, 0.5);
    assert.equal(b.f1, 0.5);

    const c = report.perClass.find((x) => x.label === 'C')!;
    assert.equal(c.f1, 1);
  });

  test('macro F1 is the unweighted mean of per-class F1', () => {
    assert.equal(report.macroF1, 0.7222);
  });

  test('true negatives are counted', () => {
    // For class C: 5 records are neither expected nor predicted C.
    const c = report.perClass.find((x) => x.label === 'C')!;
    assert.equal(c.trueNegatives, 5);
  });

  test('support sums to the record count', () => {
    const totalSupport = report.perClass.reduce((sum, c) => sum + c.support, 0);
    assert.equal(totalSupport, 6);
  });
});

describe('metrics — F1 is the harmonic mean, not a copy of precision', () => {
  // The fixture above is symmetric (precision === recall for every class), so
  // it cannot tell F1 apart from precision. This one is deliberately skewed.
  //
  // 5 records: A->A, B->A, C->A, A->B, A->C
  //   A: tp=1 fp=2 fn=2 -> P = 1/3 = 0.3333, R = 1/3 ... still symmetric.
  //
  // So instead: A appears 4 times as truth, predicted A only once, and A is
  // predicted twice in total.
  //   A: tp=1 fp=1 fn=3
  //      P = 1/(1+1) = 0.5
  //      R = 1/(1+3) = 0.25
  //      F1 = 2*0.5*0.25 / 0.75 = 0.3333   <- differs from BOTH P and R
  const skewed = [
    { expected: 'A', predicted: 'A' },
    { expected: 'A', predicted: 'B' },
    { expected: 'A', predicted: 'B' },
    { expected: 'A', predicted: 'C' },
    { expected: 'B', predicted: 'A' },
  ];
  const report = scoreClassification(skewed, LABELS);
  const a = report.perClass.find((c) => c.label === 'A')!;

  test('precision, recall and F1 are three distinct values', () => {
    assert.deepEqual([a.truePositives, a.falsePositives, a.falseNegatives], [1, 1, 3]);
    assert.equal(a.precision, 0.5);
    assert.equal(a.recall, 0.25);
    assert.equal(a.f1, 0.3333);

    // The assertions that actually pin F1 to the harmonic mean.
    assert.notEqual(a.f1, a.precision, 'F1 equals precision — the formula may be wrong');
    assert.notEqual(a.f1, a.recall, 'F1 equals recall — the formula may be wrong');
    assert.ok(a.f1 < a.precision && a.f1 > a.recall, 'F1 is not between recall and precision');
  });

  test('F1 penalises imbalance more than an arithmetic mean would', () => {
    // Arithmetic mean of 0.5 and 0.25 is 0.375; the harmonic mean is lower.
    const arithmetic = (a.precision + a.recall) / 2;
    assert.ok(a.f1 < arithmetic, 'F1 is not below the arithmetic mean');
  });

  test('the binary scorer also computes a true harmonic mean', () => {
    // tp=1 fp=1 fn=3 -> P=0.5, R=0.25, F1=0.3333
    const binary = scoreBinary([
      { expected: true, predicted: true },
      { expected: true, predicted: false },
      { expected: true, predicted: false },
      { expected: true, predicted: false },
      { expected: false, predicted: true },
    ]);
    assert.equal(binary.precision, 0.5);
    assert.equal(binary.recall, 0.25);
    assert.equal(binary.f1, 0.3333);
    assert.notEqual(binary.f1, binary.precision);
    assert.notEqual(binary.f1, binary.recall);
  });
});

describe('metrics — confusion matrix', () => {
  test('rows are truth, columns are prediction', () => {
    const report = scoreClassification(
      [
        { expected: 'A', predicted: 'B' },
        { expected: 'A', predicted: 'B' },
        { expected: 'B', predicted: 'B' },
      ],
      LABELS,
    );

    assert.equal(report.confusionMatrix['A']!['B'], 2, 'A predicted as B should be 2');
    assert.equal(report.confusionMatrix['B']!['A'], 0);
    assert.equal(report.confusionMatrix['B']!['B'], 1);
  });

  test('a perfect classifier is diagonal', () => {
    const report = scoreClassification(
      LABELS.map((l) => ({ expected: l, predicted: l })),
      LABELS,
    );
    for (const expected of LABELS) {
      for (const predicted of LABELS) {
        const count = report.confusionMatrix[expected]![predicted];
        assert.equal(count, expected === predicted ? 1 : 0);
      }
    }
    assert.equal(report.accuracy, 1);
    assert.equal(report.macroF1, 1);
  });

  test('every cell sums to the total', () => {
    const report = scoreClassification(
      [
        { expected: 'A', predicted: 'A' },
        { expected: 'B', predicted: 'C' },
        { expected: 'C', predicted: 'A' },
      ],
      LABELS,
    );
    let sum = 0;
    for (const row of Object.values(report.confusionMatrix)) {
      for (const count of Object.values(row)) sum += count;
    }
    assert.equal(sum, report.total, 'the matrix lost or invented records');
  });

  test('the matrix is square over the reported labels', () => {
    const report = scoreClassification([{ expected: 'A', predicted: 'A' }], LABELS);
    assert.equal(Object.keys(report.confusionMatrix).length, report.labels.length);
    for (const row of Object.values(report.confusionMatrix)) {
      assert.equal(Object.keys(row).length, report.labels.length);
    }
  });
});

describe('metrics — unknown labels', () => {
  test('an out-of-vocabulary label is collected, never dropped', () => {
    const report = scoreClassification(
      [
        { expected: 'A', predicted: 'A' },
        { expected: 'A', predicted: 'ZZZ' },
        { expected: 'QQQ', predicted: 'A' },
      ],
      LABELS,
    );

    assert.ok(report.labels.includes(UNKNOWN_LABEL), 'the unknown bucket was not created');
    assert.equal(report.total, 3, 'a record was dropped');
    assert.equal(report.confusionMatrix['A']![UNKNOWN_LABEL], 1);
    assert.equal(report.confusionMatrix[UNKNOWN_LABEL]!['A'], 1);
    // Counts still reconcile.
    let sum = 0;
    for (const row of Object.values(report.confusionMatrix)) {
      for (const count of Object.values(row)) sum += count;
    }
    assert.equal(sum, 3);
  });

  test('no unknown bucket is created when every label is known', () => {
    const report = scoreClassification([{ expected: 'A', predicted: 'B' }], LABELS);
    assert.ok(!report.labels.includes(UNKNOWN_LABEL));
  });

  test('a class the model never predicts still appears with recall 0', () => {
    // The failure worth seeing: silently omitting it would hide the miss.
    const report = scoreClassification(
      [
        { expected: 'C', predicted: 'A' },
        { expected: 'C', predicted: 'A' },
      ],
      LABELS,
    );
    const c = report.perClass.find((x) => x.label === 'C')!;
    assert.equal(c.support, 2);
    assert.equal(c.recall, 0);
    assert.equal(c.f1, 0);
  });
});

describe('metrics — determinism', () => {
  test('the same pairs always produce the same report', () => {
    const pairs: LabelledPair[] = [
      { expected: 'A', predicted: 'B' },
      { expected: 'B', predicted: 'B' },
      { expected: 'C', predicted: 'A' },
    ];
    const first = scoreClassification(pairs, LABELS);
    const second = scoreClassification(pairs, LABELS);
    assert.deepEqual(first, second);
    assert.equal(JSON.stringify(first), JSON.stringify(second), 'report is not byte-stable');
  });

  test('every rate is rounded to 4dp for stable output', () => {
    // 1/3 must not serialise as 0.3333333333333333.
    const report = scoreClassification(
      [
        { expected: 'A', predicted: 'A' },
        { expected: 'A', predicted: 'B' },
        { expected: 'A', predicted: 'C' },
      ],
      LABELS,
    );
    for (const value of [report.accuracy, report.macroF1, report.weightedF1]) {
      assert.equal(value, Math.round(value * 10_000) / 10_000);
    }
  });
});

describe('metrics — binary scoring', () => {
  test('an empty set is all zeros, never NaN', () => {
    const report = scoreBinary([]);
    assert.equal(report.total, 0);
    assert.equal(report.accuracy, 0);
    assert.equal(report.f1, 0);
    assert.ok(!Number.isNaN(report.precision));
  });

  test('counts and rates match a hand computation', () => {
    // tp=2 fp=1 fn=1 tn=1  -> P=2/3, R=2/3, F1=2/3, acc=3/5
    const report = scoreBinary([
      { expected: true, predicted: true },
      { expected: true, predicted: true },
      { expected: true, predicted: false },
      { expected: false, predicted: true },
      { expected: false, predicted: false },
    ]);

    assert.deepEqual(
      [report.truePositives, report.falsePositives, report.falseNegatives, report.trueNegatives],
      [2, 1, 1, 1],
    );
    assert.equal(report.precision, 0.6667);
    assert.equal(report.recall, 0.6667);
    assert.equal(report.f1, 0.6667);
    assert.equal(report.accuracy, 0.6);
  });

  test('a model that never predicts true has recall 0 and precision 0', () => {
    const report = scoreBinary([
      { expected: true, predicted: false },
      { expected: false, predicted: false },
    ]);
    assert.equal(report.precision, 0);
    assert.equal(report.recall, 0);
    assert.equal(report.f1, 0);
    assert.equal(report.accuracy, 0.5);
  });

  test('a perfect binary classifier scores 1', () => {
    const report = scoreBinary([
      { expected: true, predicted: true },
      { expected: false, predicted: false },
    ]);
    assert.equal(report.accuracy, 1);
    assert.equal(report.f1, 1);
  });
});
