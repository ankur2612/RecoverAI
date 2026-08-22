import type {
  Currency,
  FailureReason,
  MinorUnits,
  PaymentStatus,
  PolicyDecision,
  RecoveryActionType,
} from '../shared/types.ts';

/**
 * ============================================================================
 * DETERMINISTIC POLICY ENGINE — TYPES
 * ============================================================================
 *
 * This layer answers exactly one question:
 *
 *     "Is this action allowed under current deterministic rules?"
 *
 * It does NOT decide which action is economically optimal. Expected recovery
 * value is deliberately absent from PolicyInput: an action worth a large sum
 * must still be blocked when policy prohibits it (PRD section 16).
 *
 * The AI recommends. This layer authorizes. Neither can override the other's
 * role: the recommendation is an *input* here, never an override.
 */

/** Stamped on every decision so an audit record identifies the rule set used. */
export const POLICY_VERSION = 'v1';

/**
 * Machine-readable denial reasons.
 *
 * Codes are stable identifiers meant for storage, metrics, and API responses —
 * never free-form prose, so that "how often did we block for X" is countable.
 */
export const POLICY_RULES = [
  'PAYMENT_ELIGIBLE_FOR_RECOVERY',
  'PAYMENT_NOT_ALREADY_RECOVERED',
  'PAYMENT_STATE_NOT_CONFLICTING',
  'PAYMENT_STATE_KNOWN',
  'NO_DUPLICATE_ACTION',
  'ACTION_SUPPORTED',
  'RETRY_LIMIT_AVAILABLE',
  'RETRY_COOLDOWN_ELAPSED',
  'AMOUNT_WITHIN_AUTOMATED_LIMIT',
  'CONFIDENCE_SUFFICIENT',
  'HIGH_VALUE_APPROVAL',
  'REQUIRED_INFORMATION_PRESENT',
] as const;
export type PolicyRuleName = (typeof POLICY_RULES)[number];

/** Outcome codes attached to a failing or approval-gated rule. */
export const POLICY_REASON_CODES = [
  'PAYMENT_NOT_ELIGIBLE',
  'PAYMENT_ALREADY_RECOVERED',
  'PAYMENT_ALREADY_REFUNDED',
  'PAYMENT_ALREADY_CAPTURED',
  'UNKNOWN_PAYMENT_STATE',
  'DUPLICATE_ACTION',
  'UNSUPPORTED_ACTION',
  'MAX_RETRIES_EXCEEDED',
  'RETRY_COOLDOWN_ACTIVE',
  'AMOUNT_EXCEEDS_AUTOMATED_LIMIT',
  'INSUFFICIENT_CONFIDENCE',
  'HIGH_VALUE_REQUIRES_APPROVAL',
  'CUSTOMER_INTERVENTION_REQUIRES_APPROVAL',
  'MISSING_PAYMENT_ID',
  'MISSING_REQUIRED_INFORMATION',
  'INVALID_INPUT',
  'ESCALATION_REQUIRES_HUMAN',
] as const;
export type PolicyReasonCode = (typeof POLICY_REASON_CODES)[number];

export const RULE_STATUSES = ['PASS', 'FAIL', 'REQUIRES_APPROVAL', 'NOT_APPLICABLE'] as const;
export type RuleStatus = (typeof RULE_STATUSES)[number];

/** One rule's verdict, with a human-readable explanation for the UI. */
export interface RuleResult {
  rule: PolicyRuleName;
  status: RuleStatus;
  /** Present when status is FAIL or REQUIRES_APPROVAL. */
  code: PolicyReasonCode | null;
  /** Concise explanation for an operator; never internal model reasoning. */
  reason: string;
}

/**
 * Everything the evaluator needs, and deliberately nothing more.
 *
 * Note what is absent by design:
 *   - no database row, no Payment entity (avoids coupling to persistence)
 *   - no expected recovery value (value must not influence authorization)
 *   - no ground truth (evaluation labels never reach this layer)
 *   - no AI reasoning text (only the structured recommendation matters)
 */
export interface PolicyInput {
  /** Payment identifier. Missing/blank is itself a blocking condition. */
  paymentId: string;
  amount: MinorUnits;
  currency: Currency;
  paymentStatus: PaymentStatus | string;
  failureReason: FailureReason | string | null;
  /** Retry attempts already made against this payment. */
  attemptCount: number;
  /** Seconds since the most recent attempt, or null when never attempted. */
  secondsSinceLastAttempt: number | null;
  /** The action the decision layer proposes. */
  proposedAction: RecoveryActionType | string;
  /** AI (or deterministic baseline) confidence in [0,1]. */
  confidence: number;
  /**
   * Whether an equivalent action already exists for this payment. The caller
   * establishes this from persisted state; the evaluator stays pure.
   */
  duplicateActionExists: boolean;
  /** Whether the payment is already verifiably recovered. */
  alreadyRecovered: boolean;
  /** Reminders already sent for this payment. */
  remindersSent: number;
  /** Detector or AI flagged this as needing a human regardless of thresholds. */
  humanReviewRequested: boolean;
}

/** The evaluator's verdict. */
export interface PolicyResult {
  /** True ONLY when every rule passed. Approval-gated is never authorized. */
  authorized: boolean;
  requiresHumanApproval: boolean;
  /** The action evaluated, echoed back for the audit record. */
  action: RecoveryActionType | string;
  /** Coarse decision, reusing the existing domain vocabulary. */
  decision: PolicyDecision;
  /** Every rule evaluated, in a stable order, for explainability. */
  rules: RuleResult[];
  /** Codes for rules that failed outright. */
  denialReasons: PolicyReasonCode[];
  /** Codes for rules that require a human rather than failing. */
  approvalReasons: PolicyReasonCode[];
  policyVersion: string;
}

/** Raised only for programmer error; policy violations are results, not throws. */
export class PolicyInputError extends Error {
  override name = 'PolicyInputError';
}
