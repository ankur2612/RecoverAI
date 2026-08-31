import type { AIProvider } from '../agents/diagnosis/provider.ts';
import { buildDiagnosisInput } from '../agents/diagnosis/input.ts';
import type { PolicyConfig } from '../config/index.ts';
import { assessRisk } from '../risk/detector.ts';
import { EMPTY_CUSTOMER_HISTORY } from '../risk/types.ts';
import {
  CLASSIFICATIONS,
  RECOVERY_ACTIONS,
  type Classification,
  type RecoveryActionType,
  type SyntheticDataset,
  type SyntheticRecord,
} from '../shared/types.ts';
import {
  scoreBinary,
  scoreClassification,
  type BinaryReport,
  type ClassificationReport,
} from './metrics.ts';

/**
 * ============================================================================
 * EVALUATION HARNESS
 * ============================================================================
 *
 * Answers ONE question: how accurately does the AI layer label a payment?
 *
 * WHAT THIS MEASURES, AND WHAT IT DOES NOT
 *
 *   AI diagnosis quality   <- this module
 *   policy correctness     <- the deterministic engine, scored separately below
 *   execution outcome      <- the executor; not touched here
 *   verified recovery      <- VERIFIED provider evidence, in recovery-metrics
 *
 * A perfect F1 here means the model labelled synthetic payments correctly. It
 * does NOT mean money was recovered. Those are different claims resting on
 * different evidence, and this file must never blur them.
 *
 * THE GROUND-TRUTH BOUNDARY
 *
 * This is the ONE module permitted to read ground-truth labels — that is what
 * an evaluation harness is for. It reads them only AFTER a prediction exists,
 * and the prediction is produced through `buildDiagnosisInput`, the same
 * sanctioned builder the production path uses. Labels are never passed to the
 * provider, never merged into the input, and never used to choose an action.
 *
 * THIS HARNESS CANNOT EXECUTE
 *
 * It imports no executor, no execute service, no payment provider, no
 * repository, and no database. It calls `diagnose` — a read that produces a
 * label — and nothing else. Architecture tests enforce every one of those.
 */

/** A prediction paired with the label it is scored against. */
export interface EvaluationCase {
  /** Synthetic payment id. Safe to display: the dataset is generated. */
  paymentId: string;
  /** True when ground truth says an action other than NO_ACTION was ideal. */
  atRisk: boolean;
  expectedClassification: Classification;
  predictedClassification: Classification;
  expectedAction: RecoveryActionType;
  predictedAction: RecoveryActionType;
  expectedRecoverable: boolean;
  /** The model's own probability, thresholded to a boolean prediction. */
  predictedRecoverable: boolean;
  predictedRecoveryProbability: number;
  confidence: number;
  /** The model's stated reason. Scrubbed; never contains a credential. */
  reason: string;
  classificationCorrect: boolean;
  actionCorrect: boolean;
  /** Set when the provider failed for this record; no prediction was scored. */
  error: string | null;
}

export interface PolicyBehaviourSummary {
  /**
   * How the deterministic engine responded to the AI's proposals.
   *
   * This is NOT a correctness score. The policy engine has no ground truth to
   * be right or wrong against — it is a rule set, and these counts describe
   * what it did, not how well it did it. Reported so a reader can see that
   * good AI metrics do not imply permitted actions.
   */
  evaluated: number;
  allowed: number;
  blocked: number;
  requiresApproval: number;
}

export interface EvaluationReport {
  datasetSeed: number;
  datasetSize: number;
  /** The partition scored. 'eval' is the held-out set. */
  split: 'dev' | 'eval' | 'all';
  /** Records in the scored partition. */
  evaluated: number;
  /** Records whose provider call failed; excluded from the metrics. */
  errored: number;
  provider: string;
  model: string;
  /** How a probability was turned into a recoverable/not decision. */
  recoverableThreshold: number;
  classification: ClassificationReport;
  action: ClassificationReport;
  recoverability: BinaryReport;
  policy: PolicyBehaviourSummary | null;
  /**
   * The same three scores restricted to payments that are actually AT RISK
   * (ground truth says a recovery action was warranted).
   *
   * Reported alongside the whole-population figures because a generated
   * dataset is dominated by already-captured payments, where the correct
   * answer is "do nothing". Scoring those is legitimate — leaving healthy
   * payments alone is a real property worth measuring — but a single blended
   * number would let a model look good, or bad, for the wrong reason. Both
   * views are shown so neither can be quoted misleadingly.
   */
  atRiskOnly: {
    evaluated: number;
    classification: ClassificationReport;
    action: ClassificationReport;
    recoverability: BinaryReport;
  };
  /** Every scored record, for error review. Ordered by dataset order. */
  cases: EvaluationCase[];
}

export interface EvaluateOptions {
  /** Which partition to score. Defaults to the held-out 'eval' split. */
  split?: 'dev' | 'eval' | 'all' | undefined;
  /**
   * Probability at or above which the model is taken to predict "recoverable".
   * Explicit because the dataset stores a probability but labels a boolean.
   */
  recoverableThreshold?: number | undefined;
  /** Cap on records scored, for a quick run against a live provider. */
  limit?: number | undefined;
  /** Policy configuration, when a policy-behaviour summary is wanted. */
  policy?: PolicyConfig | undefined;
}

export interface EvaluateDeps {
  provider: AIProvider;
  /** Injected so a report is reproducible rather than clock-dependent. */
  now?: Date;
}

const DEFAULT_RECOVERABLE_THRESHOLD = 0.5;

/**
 * Strip credential-shaped text from a model-authored string.
 *
 * A `reason` comes from an LLM and is echoed into the report, so it is
 * scrubbed rather than trusted. Mirrors the scrubbing the providers already
 * apply to their own errors.
 */
export function scrubReason(text: string): string {
  return text
    .replace(/rzp_(test|live)_[A-Za-z0-9]+/g, '[redacted-key]')
    .replace(/AIza[A-Za-z0-9_-]{10,}/g, '[redacted-key]')
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, '[redacted-auth]')
    .replace(/Basic\s+[A-Za-z0-9+/=]+/gi, '[redacted-auth]')
    .replace(/"(key|api_key|apiKey|token|secret|password)"\s*:\s*"[^"]*"/gi, '"$1":"[redacted]"')
    .slice(0, 300);
}

function selectRecords(
  dataset: SyntheticDataset,
  split: 'dev' | 'eval' | 'all',
  limit: number | undefined,
): SyntheticRecord[] {
  const selected =
    split === 'all' ? [...dataset.records] : dataset.records.filter((r) => r.split === split);
  return limit === undefined ? selected : selected.slice(0, Math.max(0, limit));
}

/**
 * Score a provider's diagnoses against the dataset's hidden labels.
 *
 * Sequential by design: a live provider is rate-limited, and the population is
 * a fixed dataset rather than production traffic, so there is nothing to gain
 * from fanning out.
 *
 * A provider failure on one record never aborts the run. The record is counted
 * in `errored` and EXCLUDED from the metrics — scoring a failed call as a
 * wrong answer would understate model quality, and scoring it as right would
 * overstate it. Neither is honest, so it is not scored at all.
 */
export async function evaluateDiagnosis(
  dataset: SyntheticDataset,
  options: EvaluateOptions,
  deps: EvaluateDeps,
): Promise<EvaluationReport> {
  const split = options.split ?? 'eval';
  const threshold = options.recoverableThreshold ?? DEFAULT_RECOVERABLE_THRESHOLD;
  const now = deps.now ?? new Date(dataset.generatedAt);
  const records = selectRecords(dataset, split, options.limit);

  const cases: EvaluationCase[] = [];
  let errored = 0;
  let model = '';

  // Policy behaviour is only summarised when a configuration is supplied; the
  // harness never invents one, because a different config would produce a
  // different summary and quietly change the report.
  const policySummary: PolicyBehaviourSummary | null =
    options.policy === undefined
      ? null
      : { evaluated: 0, allowed: 0, blocked: 0, requiresApproval: 0 };

  for (const record of records) {
    const assessment = assessRisk(
      { payment: record.payment, customerHistory: EMPTY_CUSTOMER_HISTORY, now },
      options.policy ?? DEFAULT_POLICY_FOR_ASSESSMENT,
    );

    // The SANCTIONED builder. It copies named fields only and never spreads
    // the record, so `record.groundTruth` cannot ride along into the prompt.
    const input = buildDiagnosisInput({
      payment: record.payment,
      customerHistory: EMPTY_CUSTOMER_HISTORY,
      assessment,
      policy: options.policy ?? DEFAULT_POLICY_FOR_ASSESSMENT,
    });

    try {
      const diagnosis = await deps.provider.diagnose(input);
      model = diagnosis.model;

      // Labels are read HERE — after the prediction exists, never before.
      const truth = record.groundTruth;

      cases.push({
        paymentId: record.payment.id,
        atRisk: truth.idealAction !== 'NO_ACTION',
        expectedClassification: truth.classification,
        predictedClassification: diagnosis.classification,
        expectedAction: truth.idealAction,
        predictedAction: diagnosis.recommendedAction,
        expectedRecoverable: truth.recoverable,
        predictedRecoverable: diagnosis.expectedRecoveryProbability >= threshold,
        predictedRecoveryProbability: diagnosis.expectedRecoveryProbability,
        confidence: diagnosis.confidence,
        reason: scrubReason(diagnosis.reason),
        classificationCorrect: diagnosis.classification === truth.classification,
        actionCorrect: diagnosis.recommendedAction === truth.idealAction,
        error: null,
      });

      if (policySummary !== null) {
        policySummary.evaluated += 1;
        // Counted from the ASSESSMENT, not from a policy call: evaluating
        // policy here would require an execution-shaped input this harness
        // deliberately cannot build.
        if (assessment.requiresHumanReview) policySummary.requiresApproval += 1;
        else if (assessment.atRisk) policySummary.allowed += 1;
        else policySummary.blocked += 1;
      }
    } catch (error) {
      errored += 1;
      cases.push({
        paymentId: record.payment.id,
        atRisk: record.groundTruth.idealAction !== 'NO_ACTION',
        expectedClassification: record.groundTruth.classification,
        predictedClassification: 'UNKNOWN',
        expectedAction: record.groundTruth.idealAction,
        predictedAction: 'NO_ACTION',
        expectedRecoverable: record.groundTruth.recoverable,
        predictedRecoverable: false,
        predictedRecoveryProbability: 0,
        confidence: 0,
        reason: '',
        classificationCorrect: false,
        actionCorrect: false,
        error: scrubReason(error instanceof Error ? error.message : String(error)),
      });
    }
  }

  // Errored records are excluded from every metric.
  const scored = cases.filter((c) => c.error === null);
  const atRisk = scored.filter((c) => c.atRisk);

  return {
    datasetSeed: dataset.seed,
    datasetSize: dataset.records.length,
    split,
    evaluated: scored.length,
    errored,
    provider: deps.provider.name,
    model,
    recoverableThreshold: threshold,
    classification: scoreClassification(
      scored.map((c) => ({
        expected: c.expectedClassification,
        predicted: c.predictedClassification,
      })),
      CLASSIFICATIONS,
    ),
    action: scoreClassification(
      scored.map((c) => ({ expected: c.expectedAction, predicted: c.predictedAction })),
      RECOVERY_ACTIONS,
    ),
    recoverability: scoreBinary(
      scored.map((c) => ({ expected: c.expectedRecoverable, predicted: c.predictedRecoverable })),
    ),
    policy: policySummary,
    atRiskOnly: {
      evaluated: atRisk.length,
      classification: scoreClassification(
        atRisk.map((c) => ({
          expected: c.expectedClassification,
          predicted: c.predictedClassification,
        })),
        CLASSIFICATIONS,
      ),
      action: scoreClassification(
        atRisk.map((c) => ({ expected: c.expectedAction, predicted: c.predictedAction })),
        RECOVERY_ACTIONS,
      ),
      recoverability: scoreBinary(
        atRisk.map((c) => ({
          expected: c.expectedRecoverable,
          predicted: c.predictedRecoverable,
        })),
      ),
    },
    cases,
  };
}

/**
 * Risk assessment needs thresholds even when no policy summary is requested.
 *
 * These mirror the documented defaults in config. They are stated here rather
 * than read from the environment so an evaluation run is reproducible from its
 * inputs alone — a report must not change because a shell variable did.
 */
const DEFAULT_POLICY_FOR_ASSESSMENT: PolicyConfig = Object.freeze({
  maxRetryAttempts: 3,
  maxAutomatedAmount: 1_000_000,
  minRecoveryConfidence: 0.75,
  retryCooldownSeconds: 3600,
  highValueThreshold: 1_000_000,
  recoveryWindowHours: 72,
  maxRemindersPerPayment: 2,
});

/** Records the model got wrong, for error review. Never contains a secret. */
export function failures(report: EvaluationReport): EvaluationCase[] {
  return report.cases.filter(
    (c) => c.error !== null || !c.classificationCorrect || !c.actionCorrect,
  );
}
