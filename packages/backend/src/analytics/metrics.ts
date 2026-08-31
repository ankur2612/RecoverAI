/**
 * ============================================================================
 * CLASSIFICATION METRICS
 * ============================================================================
 *
 * Pure functions over (expected, predicted) label pairs. No I/O, no clock, no
 * randomness, no `process.env` — the same pairs always produce the same
 * numbers, on any machine, in any order of evaluation.
 *
 * WHAT THESE NUMBERS ARE NOT
 *
 * They measure whether the AI's LABEL matches a synthetic label. They say
 * nothing about money. A model can score a perfect F1 and recover nothing:
 * the policy engine may refuse every action, the provider may reject them, or
 * the payments may be unrecoverable in fact. Recovered revenue has exactly one
 * definition in this codebase — a VERIFIED provider outcome — and it lives in
 * recovery-metrics.ts, deliberately in a different module from this one.
 *
 * DIVISION BY ZERO
 *
 * Every rate here is defined to be 0 when its denominator is 0, rather than
 * NaN. A class with no predictions has precision 0, not "undefined"; reporting
 * NaN would propagate through the macro averages and make a whole report
 * unreadable because of one empty class.
 */

/** Counts for one class, in the one-vs-rest sense. */
export interface ClassCounts {
  /** Predicted this class, and it was this class. */
  truePositives: number;
  /** Predicted this class, but it was not. */
  falsePositives: number;
  /** Was this class, but predicted something else. */
  falseNegatives: number;
  /** Neither expected nor predicted this class. */
  trueNegatives: number;
}

export interface ClassMetrics extends ClassCounts {
  label: string;
  /** How many records genuinely belong to this class. */
  support: number;
  /** tp / (tp + fp). Zero when nothing was predicted for this class. */
  precision: number;
  /** tp / (tp + fn). Zero when the class has no support. */
  recall: number;
  /** Harmonic mean of precision and recall. Zero when both are zero. */
  f1: number;
}

export interface ClassificationReport {
  /** Total (expected, predicted) pairs scored. */
  total: number;
  /** Pairs where predicted === expected. */
  correct: number;
  /** correct / total. Zero for an empty set. */
  accuracy: number;
  /** Per-class metrics, ordered by the label list supplied. */
  perClass: ClassMetrics[];
  /** Unweighted mean of per-class F1 — every class counts equally. */
  macroF1: number;
  macroPrecision: number;
  macroRecall: number;
  /** Support-weighted mean of per-class F1 — reflects class imbalance. */
  weightedF1: number;
  /**
   * matrix[expected][predicted] = count.
   *
   * Rows are the truth, columns the prediction, so a perfect classifier is
   * diagonal. Labels not in the supplied list are collected under the
   * `unknownLabel` row/column rather than silently dropped.
   */
  confusionMatrix: Record<string, Record<string, number>>;
  /** Labels used, in report order. Includes `unknownLabel` if it was needed. */
  labels: string[];
}

export interface LabelledPair {
  /** The ground-truth label. */
  expected: string;
  /** What the system predicted. */
  predicted: string;
}

/** Where an out-of-vocabulary label is collected. */
export const UNKNOWN_LABEL = '__OTHER__';

/** Safe division: 0/0 is 0, never NaN. */
function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

/** Round to 4dp so a report is byte-stable across platforms. */
function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

/**
 * Score a set of (expected, predicted) pairs against a fixed label vocabulary.
 *
 * The vocabulary is supplied rather than inferred from the data. Inferring it
 * would make a report's shape depend on which records happened to appear —
 * two runs over different splits would produce incomparable tables, and a
 * class the model never predicts would silently vanish instead of showing a
 * recall of 0, which is exactly the failure worth seeing.
 */
export function scoreClassification(
  pairs: readonly LabelledPair[],
  labels: readonly string[],
): ClassificationReport {
  // Any label outside the vocabulary is folded into one bucket rather than
  // dropped, so counts always reconcile with `total`.
  const known = new Set(labels);
  const needsUnknown = pairs.some(
    (p) => !known.has(p.expected) || !known.has(p.predicted),
  );
  const reportLabels = needsUnknown ? [...labels, UNKNOWN_LABEL] : [...labels];
  const normalise = (label: string): string => (known.has(label) ? label : UNKNOWN_LABEL);

  const matrix: Record<string, Record<string, number>> = {};
  for (const expected of reportLabels) {
    matrix[expected] = {};
    for (const predicted of reportLabels) {
      matrix[expected]![predicted] = 0;
    }
  }

  let correct = 0;
  for (const pair of pairs) {
    const expected = normalise(pair.expected);
    const predicted = normalise(pair.predicted);
    matrix[expected]![predicted] = (matrix[expected]![predicted] ?? 0) + 1;
    if (expected === predicted) correct += 1;
  }

  const total = pairs.length;

  const perClass: ClassMetrics[] = reportLabels.map((label) => {
    let truePositives = 0;
    let falsePositives = 0;
    let falseNegatives = 0;
    let trueNegatives = 0;

    for (const expected of reportLabels) {
      for (const predicted of reportLabels) {
        const count = matrix[expected]![predicted] ?? 0;
        if (expected === label && predicted === label) truePositives += count;
        else if (expected !== label && predicted === label) falsePositives += count;
        else if (expected === label && predicted !== label) falseNegatives += count;
        else trueNegatives += count;
      }
    }

    const precision = ratio(truePositives, truePositives + falsePositives);
    const recall = ratio(truePositives, truePositives + falseNegatives);

    return {
      label,
      truePositives,
      falsePositives,
      falseNegatives,
      trueNegatives,
      support: truePositives + falseNegatives,
      precision: round4(precision),
      recall: round4(recall),
      f1: round4(ratio(2 * precision * recall, precision + recall)),
    };
  });

  // Macro averages treat every class equally, so a rare class cannot be hidden
  // by a common one. Weighted averages do the opposite. Reporting both is the
  // honest choice on an imbalanced dataset like this one.
  const macroPrecision = ratio(
    perClass.reduce((sum, c) => sum + c.precision, 0),
    perClass.length,
  );
  const macroRecall = ratio(
    perClass.reduce((sum, c) => sum + c.recall, 0),
    perClass.length,
  );
  const macroF1 = ratio(
    perClass.reduce((sum, c) => sum + c.f1, 0),
    perClass.length,
  );
  const totalSupport = perClass.reduce((sum, c) => sum + c.support, 0);
  const weightedF1 = ratio(
    perClass.reduce((sum, c) => sum + c.f1 * c.support, 0),
    totalSupport,
  );

  return {
    total,
    correct,
    accuracy: round4(ratio(correct, total)),
    perClass,
    macroPrecision: round4(macroPrecision),
    macroRecall: round4(macroRecall),
    macroF1: round4(macroF1),
    weightedF1: round4(weightedF1),
    confusionMatrix: matrix,
    labels: reportLabels,
  };
}

export interface BinaryReport extends ClassCounts {
  total: number;
  accuracy: number;
  precision: number;
  recall: number;
  f1: number;
}

/**
 * Score a boolean prediction (here: "is this recoverable?").
 *
 * `true` is the positive class. Kept separate from `scoreClassification`
 * because a two-class confusion matrix reads better as four named counts than
 * as a 2x2 table.
 */
export function scoreBinary(
  pairs: readonly { expected: boolean; predicted: boolean }[],
): BinaryReport {
  let truePositives = 0;
  let falsePositives = 0;
  let falseNegatives = 0;
  let trueNegatives = 0;

  for (const { expected, predicted } of pairs) {
    if (expected && predicted) truePositives += 1;
    else if (!expected && predicted) falsePositives += 1;
    else if (expected && !predicted) falseNegatives += 1;
    else trueNegatives += 1;
  }

  const precision = ratio(truePositives, truePositives + falsePositives);
  const recall = ratio(truePositives, truePositives + falseNegatives);

  return {
    total: pairs.length,
    truePositives,
    falsePositives,
    falseNegatives,
    trueNegatives,
    accuracy: round4(ratio(truePositives + trueNegatives, pairs.length)),
    precision: round4(precision),
    recall: round4(recall),
    f1: round4(ratio(2 * precision * recall, precision + recall)),
  };
}
