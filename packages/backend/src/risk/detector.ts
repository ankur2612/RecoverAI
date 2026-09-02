import type { PolicyConfig } from '../config/index.ts';
import type { Classification, RecoveryActionType } from '../shared/types.ts';
import {
  FAILURE_REASON_CLASSIFICATION,
  type RecoverabilityBand,
  type RiskAssessment,
  type RiskAssessmentInput,
} from './types.ts';

/**
 * Deterministic revenue-risk detection (PRD section 6).
 *
 * This module is a pure function of its input: no clock, no randomness, no
 * database, no network, no LLM. It runs BEFORE any AI involvement and gives
 * the system a defensible baseline that holds even when the AI is unavailable
 * or returns nonsense.
 *
 * The AI may later disagree with the classification here. That disagreement is
 * information, not authority — the policy engine (a later phase) decides what
 * actually happens.
 */

/** Statuses that represent money the merchant has not collected. */
const AT_RISK_STATUSES = new Set(['failed', 'abandoned', 'created', 'authorized']);

/** Statuses where intervention is pointless or actively wrong. */
const TERMINAL_STATUSES = new Set(['captured', 'refunded']);

/**
 * Reasons that never resolve by retrying the same instrument. Retrying these
 * burns a retry budget and, for card_declined, can trip issuer fraud rules.
 */
const NON_RETRYABLE_REASONS = new Set([
  'card_expired',
  'invalid_cvv',
  'payment_method_unsupported',
  'card_declined',
]);

function bandFromScore(score: number): RecoverabilityBand {
  if (score <= 0) return 'NONE';
  if (score >= 0.65) return 'HIGH';
  if (score >= 0.35) return 'MEDIUM';
  return 'LOW';
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/** Round to 4dp so scores are stable across platforms and in snapshots. */
function round4(value: number): number {
  return Number(value.toFixed(4));
}

/**
 * Assess a single payment.
 *
 * `policy` is read for thresholds only (retry ceiling, high-value line). The
 * detector never mutates policy and never decides authorization.
 */
export function assessRisk(input: RiskAssessmentInput, policy: PolicyConfig): RiskAssessment {
  const { payment, customerHistory, now } = input;

  const ageMs = now.getTime() - payment.createdAt.getTime();
  // A negative age means clock skew or bad data; clamp rather than produce
  // nonsense downstream.
  const ageHours = round4(Math.max(0, ageMs) / 3_600_000);

  const factors: string[] = [];

  // ---- Not at risk -------------------------------------------------------
  if (TERMINAL_STATUSES.has(payment.status)) {
    const settled = payment.status === 'captured' ? 'captured' : 'refunded';
    return {
      paymentId: payment.id,
      atRisk: false,
      revenueAtRisk: 0,
      classification: 'UNKNOWN',
      recoverability: 'NONE',
      recoverabilityScore: 0,
      riskScore: 0,
      baselineAction: 'NO_ACTION',
      requiresAiDiagnosis: false,
      requiresHumanReview: false,
      reason: `Payment is ${settled}; no revenue is at risk.`,
      factors: [`payment_status=${payment.status}`],
      ageHours,
    };
  }

  if (!AT_RISK_STATUSES.has(payment.status)) {
    // Unrecognised status: stay conservative rather than guessing.
    return {
      paymentId: payment.id,
      atRisk: false,
      revenueAtRisk: 0,
      classification: 'UNKNOWN',
      recoverability: 'NONE',
      recoverabilityScore: 0,
      riskScore: 0,
      baselineAction: 'ESCALATE',
      requiresAiDiagnosis: false,
      requiresHumanReview: true,
      reason: `Unrecognised payment status "${payment.status}"; escalating for manual review.`,
      factors: [`payment_status=${payment.status}`, 'unrecognised_status'],
      ageHours,
    };
  }

  // ---- Classification ----------------------------------------------------
  // An unrecognised reason falls back to UNKNOWN rather than undefined.
  let classification: Classification =
    payment.failureReason === null
      ? payment.status === 'abandoned'
        ? 'CHECKOUT_ABANDONMENT'
        : 'UNKNOWN'
      : (FAILURE_REASON_CLASSIFICATION[payment.failureReason] ?? 'UNKNOWN');

  factors.push(`failure_reason=${payment.failureReason ?? 'none'}`);

  // Repeated failure dominates the underlying reason: whatever the original
  // cause, a payment that has already exhausted its retries is a different
  // problem and must not be treated as a fresh temporary blip.
  const retriesExhausted = payment.attemptCount >= policy.maxRetryAttempts;
  if (retriesExhausted) {
    classification = 'REPEATED_FAILURE';
    factors.push(`attempts=${payment.attemptCount}>=max=${policy.maxRetryAttempts}`);
  } else if (payment.attemptCount > 0) {
    factors.push(`attempts=${payment.attemptCount}`);
  }

  // Subscription context overrides only when the failure is not already
  // terminal for this payment.
  if (payment.isSubscription && !retriesExhausted && classification !== 'UNKNOWN') {
    classification = 'SUBSCRIPTION_FAILURE';
    factors.push('subscription=true');
  }

  // ---- Recoverability ----------------------------------------------------
  let score = baseRecoverability(classification);
  factors.push(`base_recoverability=${score.toFixed(2)}`);

  // Customer history is a genuine signal: someone who has paid before is more
  // likely to pay again.
  if (customerHistory.successRate !== null && customerHistory.totalPayments > 0) {
    const adjustment = (customerHistory.successRate - 0.5) * 0.2;
    score += adjustment;
    factors.push(
      `customer_success_rate=${customerHistory.successRate.toFixed(2)}` +
        ` (${customerHistory.successfulPayments}/${customerHistory.totalPayments})`,
    );
  } else {
    factors.push('customer_history=none');
  }

  // Each prior attempt lowers the odds the next one differs.
  if (payment.attemptCount > 0) {
    score -= payment.attemptCount * 0.12;
  }

  // Staleness: abandonment and reminders decay quickly as the customer's
  // intent fades.
  if (ageHours > policy.recoveryWindowHours) {
    score -= 0.25;
    factors.push(`outside_recovery_window(${ageHours.toFixed(1)}h>${policy.recoveryWindowHours}h)`);
  } else if (ageHours > policy.recoveryWindowHours / 2) {
    score -= 0.1;
    factors.push(`aging(${ageHours.toFixed(1)}h)`);
  }

  score = clamp01(score);
  const recoverability = bandFromScore(score);

  // ---- Risk score --------------------------------------------------------
  // How much attention this deserves: value at stake blended with how
  // recoverable it looks. A large recoverable failure ranks highest.
  const highValue = payment.amount >= policy.highValueThreshold;
  const valueWeight = clamp01(payment.amount / Math.max(1, policy.highValueThreshold));
  const riskScore = round4(clamp01(valueWeight * 0.5 + score * 0.5));

  // ---- Baseline action ---------------------------------------------------
  const baselineAction = chooseBaselineAction({
    classification,
    score,
    retriesExhausted,
    failureReason: payment.failureReason,
    isSubscription: payment.isSubscription,
    withinWindow: ageHours <= policy.recoveryWindowHours,
  });

  // ---- Human review ------------------------------------------------------
  // These are detector-level flags, NOT authorization. The policy engine makes
  // the binding decision in a later phase.
  const requiresHumanReview =
    highValue || payment.amount > policy.maxAutomatedAmount || classification === 'UNKNOWN';

  if (highValue) factors.push(`high_value(${payment.amount}>=${policy.highValueThreshold})`);
  if (classification === 'UNKNOWN') factors.push('unknown_failure_conservative');

  // AI diagnosis adds value where the cause is ambiguous or the deterministic
  // layer is uncertain. For an already-exhausted retry budget or a clearly
  // terminal payment-method problem, the answer is not in doubt.
  const requiresAiDiagnosis =
    classification !== 'REPEATED_FAILURE' && recoverability !== 'NONE' && !retriesExhausted;

  return {
    paymentId: payment.id,
    atRisk: true,
    revenueAtRisk: payment.amount,
    classification,
    recoverability,
    recoverabilityScore: round4(score),
    riskScore,
    baselineAction,
    requiresAiDiagnosis,
    requiresHumanReview,
    reason: buildReason(classification, recoverability, baselineAction, requiresHumanReview),
    factors,
    ageHours,
  };
}

/** Starting recoverability for each classification, before adjustments. */
function baseRecoverability(classification: Classification): number {
  switch (classification) {
    case 'TEMPORARY_FAILURE':
      return 0.8;
    case 'SUBSCRIPTION_FAILURE':
      return 0.65;
    case 'CUSTOMER_ACTION_REQUIRED':
      return 0.5;
    case 'CHECKOUT_ABANDONMENT':
      return 0.4;
    case 'PAYMENT_METHOD_PROBLEM':
      return 0.35;
    case 'REPEATED_FAILURE':
      return 0.1;
    case 'UNKNOWN':
      // Conservative by construction (PRD section 10: UNKNOWN_FAILURE = no
      // automatic action).
      return 0.15;
  }
}

interface BaselineActionInput {
  classification: Classification;
  score: number;
  retriesExhausted: boolean;
  failureReason: string | null;
  isSubscription: boolean;
  withinWindow: boolean;
}

/**
 * The action the system would take with no AI at all.
 *
 * Two invariants this function must never violate:
 *   - a non-retryable failure reason never yields RETRY
 *   - an exhausted retry budget never yields RETRY
 */
function chooseBaselineAction(input: BaselineActionInput): RecoveryActionType {
  const { classification, score, retriesExhausted, failureReason, isSubscription, withinWindow } =
    input;

  if (retriesExhausted) return 'ESCALATE';
  if (classification === 'UNKNOWN') return 'ESCALATE';

  const retryable = failureReason === null || !NON_RETRYABLE_REASONS.has(failureReason);

  switch (classification) {
    case 'TEMPORARY_FAILURE':
      return retryable ? 'RETRY' : 'REMINDER';
    case 'SUBSCRIPTION_FAILURE':
      return retryable ? 'SUBSCRIPTION_RETRY' : 'REMINDER';
    case 'CUSTOMER_ACTION_REQUIRED':
      return 'REMINDER';
    case 'PAYMENT_METHOD_PROBLEM':
      // Never retry the same broken instrument; ask the customer to fix it.
      return score >= 0.25 ? 'REMINDER' : 'NO_ACTION';
    case 'CHECKOUT_ABANDONMENT':
      return withinWindow ? 'CHECKOUT_RECOVERY' : 'NO_ACTION';
    case 'REPEATED_FAILURE':
      return 'ESCALATE';
  }

  // Unreachable given the exhaustive switch, but keeps the failure mode safe.
  return isSubscription ? 'ESCALATE' : 'NO_ACTION';
}

function buildReason(
  classification: Classification,
  recoverability: RecoverabilityBand,
  action: RecoveryActionType,
  requiresHumanReview: boolean,
): string {
  const base = `Classified ${classification} with ${recoverability} recoverability; baseline action ${action}.`;
  return requiresHumanReview ? `${base} Flagged for human review.` : base;
}
