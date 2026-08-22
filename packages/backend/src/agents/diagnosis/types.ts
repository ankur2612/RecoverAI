import { z } from 'zod';
import {
  CLASSIFICATIONS,
  RECOVERY_ACTIONS,
  type Classification,
  type MinorUnits,
  type RecoveryActionType,
} from '../../shared/types.ts';
import type { CustomerHistory, RecoverabilityBand } from '../../risk/types.ts';

/**
 * ============================================================================
 * THE AI INPUT BOUNDARY (PRD sections 28, 29)
 * ============================================================================
 *
 * Everything an AI provider is allowed to see passes through DiagnosisInput.
 *
 * The hard rule: evaluation labels must never reach a provider. If ground
 * truth leaked into the prompt, every accuracy metric would be meaningless —
 * the model would be graded on data it was handed.
 *
 * This is enforced three ways, deliberately redundant:
 *
 *   1. STRUCTURALLY — ForbiddenEvaluationKeys below types every label-shaped
 *      key as `never`, so an object literal carrying one fails to compile.
 *   2. AT RUNTIME — assertNoEvaluationData() rejects such keys at any depth,
 *      catching values that arrive as `unknown` from a database row or JSON.
 *   3. BY CONSTRUCTION — buildDiagnosisInput() copies named fields only. It
 *      never spreads a payment row, so a new ground-truth column added to the
 *      database cannot silently ride along.
 */

/**
 * Keys that must never appear on anything sent to an AI provider.
 * Typed `never` so assigning any value to them is a compile error.
 */
export interface ForbiddenEvaluationKeys {
  groundTruth?: never;
  ground_truth?: never;
  expectedClassification?: never;
  expected_classification?: never;
  expectedRecoverability?: never;
  expected_recoverability?: never;
  evaluationLabel?: never;
  evaluation_label?: never;
  evaluationOutcome?: never;
  evaluation_outcome?: never;
  recoveryProbability?: never;
  recovery_probability?: never;
  idealAction?: never;
  ideal_action?: never;
  recoverable?: never;
  split?: never;
  actualOutcome?: never;
  actual_outcome?: never;
  futureOutcome?: never;
  future_outcome?: never;
}

/** Runtime mirror of the forbidden key list, for deep validation. */
export const FORBIDDEN_EVALUATION_KEYS: readonly string[] = Object.freeze([
  'groundTruth',
  'ground_truth',
  'expectedClassification',
  'expected_classification',
  'expectedRecoverability',
  'expected_recoverability',
  'evaluationLabel',
  'evaluation_label',
  'evaluationOutcome',
  'evaluation_outcome',
  'recoveryProbability',
  'recovery_probability',
  'idealAction',
  'ideal_action',
  'recoverable',
  'split',
  'actualOutcome',
  'actual_outcome',
  'futureOutcome',
  'future_outcome',
]);

/** Payment facts an AI provider may see. Observations only — no labels. */
export interface DiagnosisPaymentView {
  paymentId: string;
  amount: MinorUnits;
  currency: string;
  status: string;
  failureReason: string | null;
  attemptCount: number;
  isSubscription: boolean;
  /** Hours since the payment was created, at diagnosis time. */
  ageHours: number;
}

/** The deterministic detector's opinion, given to the AI as context. */
export interface DiagnosisRiskView {
  classification: Classification;
  recoverability: RecoverabilityBand;
  recoverabilityScore: number;
  riskScore: number;
  baselineAction: RecoveryActionType;
  factors: readonly string[];
}

/** Policy limits, so the AI knows the bounds it should reason within. */
export interface DiagnosisPolicyView {
  maxRetryAttempts: number;
  maxAutomatedAmount: MinorUnits;
  minRecoveryConfidence: number;
  recoveryWindowHours: number;
  /** True when this payment already exceeds the automated ceiling. */
  exceedsAutomatedLimit: boolean;
}

/**
 * The complete, sealed input to an AI provider.
 *
 * Extends ForbiddenEvaluationKeys so a literal carrying `groundTruth`,
 * `recoverable`, `split`, etc. is rejected by the compiler.
 */
export interface DiagnosisInput extends ForbiddenEvaluationKeys {
  payment: DiagnosisPaymentView;
  customerHistory: CustomerHistory;
  risk: DiagnosisRiskView;
  policy: DiagnosisPolicyView;
  /** Supported actions. A provider may recommend nothing outside this list. */
  supportedActions: readonly RecoveryActionType[];
}

/**
 * Deep runtime check for evaluation data.
 *
 * The compile-time guard only protects statically-typed literals. Data that
 * arrives as `unknown` — a database row, parsed JSON, a test fixture — needs
 * this. Throws rather than stripping: a leak is a bug to fix, not a value to
 * silently drop.
 */
export function assertNoEvaluationData(value: unknown, path = 'diagnosisInput'): void {
  if (value === null || typeof value !== 'object') return;

  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoEvaluationData(item, `${path}[${index}]`));
    return;
  }

  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_EVALUATION_KEYS.includes(key)) {
      throw new EvaluationDataLeakError(
        `Evaluation data "${key}" found at ${path}.${key}. ` +
          'Ground-truth labels must never reach an AI provider.',
      );
    }
    assertNoEvaluationData(child, `${path}.${key}`);
  }
}

export class EvaluationDataLeakError extends Error {
  override name = 'EvaluationDataLeakError';
}

/**
 * ============================================================================
 * DIAGNOSIS OUTPUT (PRD sections 7, 28)
 * ============================================================================
 *
 * Model output is untrusted input. It is parsed against this schema before it
 * is allowed anywhere near a recovery case.
 *
 * Note the action vocabulary: the PRD's prose uses PAYMENT_REMINDER while the
 * domain enum uses REMINDER for the same action. Both are accepted on input
 * and normalised to REMINDER, so a provider following either spelling works
 * and the rest of the system sees exactly one vocabulary.
 */

/** Alternate spellings accepted from providers, normalised to the domain enum. */
const ACTION_ALIASES: Readonly<Record<string, RecoveryActionType>> = Object.freeze({
  PAYMENT_REMINDER: 'REMINDER',
  REMINDER: 'REMINDER',
  RETRY: 'RETRY',
  CHECKOUT_RECOVERY: 'CHECKOUT_RECOVERY',
  SUBSCRIPTION_RETRY: 'SUBSCRIPTION_RETRY',
  ESCALATE: 'ESCALATE',
  NO_ACTION: 'NO_ACTION',
});

/** Every action spelling a provider may legally emit. */
export const ACCEPTED_ACTION_INPUTS: readonly string[] = Object.freeze(Object.keys(ACTION_ALIASES));

const probability = z
  .number({ invalid_type_error: 'must be a number' })
  .finite('must be finite')
  .min(0, 'must be >= 0')
  .max(1, 'must be <= 1');

/**
 * Strict schema for a provider's diagnosis.
 *
 * `.strict()` rejects unknown keys outright: a model that invents a
 * `payment_id`, an `api_call`, or an `execute` field is refused rather than
 * having the extra field quietly ignored.
 */
export const diagnosisResultSchema = z
  .object({
    classification: z.enum(CLASSIFICATIONS),
    confidence: probability,
    reason: z
      .string()
      .trim()
      .min(1, 'reason must not be empty')
      .max(500, 'reason must be 500 characters or fewer'),
    recommended_action: z
      .string()
      .transform((value) => value.trim().toUpperCase())
      .refine((value) => value in ACTION_ALIASES, {
        message: `recommended_action must be one of ${ACCEPTED_ACTION_INPUTS.join(', ')}`,
      })
      .transform((value) => ACTION_ALIASES[value] as RecoveryActionType),
    expected_recovery_probability: probability,
    requires_human_approval: z.boolean().optional().default(false),
  })
  .strict();

/** A provider's diagnosis, after validation and normalisation. */
export type ValidatedDiagnosis = z.infer<typeof diagnosisResultSchema>;

/** The diagnosis plus provenance the system adds. Providers cannot set these. */
export interface DiagnosisResult {
  classification: Classification;
  confidence: number;
  reason: string;
  recommendedAction: RecoveryActionType;
  expectedRecoveryProbability: number;
  requiresHumanApproval: boolean;
  /** Which provider produced this, for the audit trail. */
  provider: string;
  /** Model identifier where applicable; 'deterministic' for MockAI. */
  model: string;
}

export class DiagnosisValidationError extends Error {
  override name = 'DiagnosisValidationError';
  readonly issues: readonly string[];

  constructor(message: string, issues: readonly string[] = []) {
    super(message);
    this.issues = issues;
  }
}

/**
 * Parse and validate raw provider output.
 *
 * Accepts a JSON string or an already-parsed object, because different
 * providers return different shapes. Anything that does not satisfy the schema
 * throws — there is no partial acceptance and no defaulting of a missing
 * classification or confidence.
 */
export function validateDiagnosis(
  raw: unknown,
  provider: string,
  model: string,
): DiagnosisResult {
  let candidate: unknown = raw;

  if (typeof raw === 'string') {
    try {
      candidate = JSON.parse(raw);
    } catch (error) {
      throw new DiagnosisValidationError(
        `Provider "${provider}" returned malformed JSON: ${(error as Error).message}`,
      );
    }
  }

  if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) {
    throw new DiagnosisValidationError(
      `Provider "${provider}" returned ${Array.isArray(candidate) ? 'an array' : typeof candidate}, expected a JSON object`,
    );
  }

  const parsed = diagnosisResultSchema.safeParse(candidate);
  if (!parsed.success) {
    const issues = parsed.error.issues.map(
      (issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`,
    );
    throw new DiagnosisValidationError(
      `Provider "${provider}" returned an invalid diagnosis: ${issues.join('; ')}`,
      issues,
    );
  }

  const value = parsed.data;

  return {
    classification: value.classification,
    confidence: value.confidence,
    reason: value.reason,
    recommendedAction: value.recommended_action,
    expectedRecoveryProbability: value.expected_recovery_probability,
    requiresHumanApproval: value.requires_human_approval,
    provider,
    model,
  };
}

export { CLASSIFICATIONS, RECOVERY_ACTIONS };
