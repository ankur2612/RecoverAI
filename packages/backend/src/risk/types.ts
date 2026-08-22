import type {
  Classification,
  FailureReason,
  MinorUnits,
  Payment,
  RecoveryActionType,
} from '../shared/types.ts';

/**
 * How confident the deterministic detector is that revenue can be recovered.
 * This is a coarse band, distinct from the AI's numeric confidence.
 */
export const RECOVERABILITY_BANDS = ['HIGH', 'MEDIUM', 'LOW', 'NONE'] as const;
export type RecoverabilityBand = (typeof RECOVERABILITY_BANDS)[number];

/**
 * Operational history for a customer, derived from stored payments only.
 *
 * Every field here is an observation of the past. Nothing in this type
 * describes a future or expected outcome — see DiagnosisInput for why that
 * distinction is load-bearing.
 */
export interface CustomerHistory {
  totalPayments: number;
  successfulPayments: number;
  failedPayments: number;
  /** Successful payments as a fraction of total, or null when there is no history. */
  successRate: number | null;
  /** Sum of all successfully captured amounts, in minor units. */
  lifetimeValue: MinorUnits;
}

/** A customer with no recorded history. */
export const EMPTY_CUSTOMER_HISTORY: CustomerHistory = Object.freeze({
  totalPayments: 0,
  successfulPayments: 0,
  failedPayments: 0,
  successRate: null,
  lifetimeValue: 0,
});

/** Everything the detector needs, all of it observable from the payments table. */
export interface RiskAssessmentInput {
  payment: Payment;
  customerHistory: CustomerHistory;
  /** Evaluation instant. Injected rather than read from the clock, so the
   *  detector is a pure function and its tests are deterministic. */
  now: Date;
}

/**
 * The deterministic detector's verdict.
 *
 * This exists so the system has a defensible baseline WITHOUT any LLM. If the
 * AI provider is unavailable, misbehaves, or returns garbage, this assessment
 * is still a complete, explainable answer (PRD section 6).
 */
export interface RiskAssessment {
  paymentId: string;
  /** False for captured payments; they are not at risk by definition. */
  atRisk: boolean;
  /** Amount at stake, in minor units. Zero when not at risk. */
  revenueAtRisk: MinorUnits;
  /** Deterministic baseline classification, before any AI involvement. */
  classification: Classification;
  /** Coarse recoverability band. */
  recoverability: RecoverabilityBand;
  /** Normalised [0,1] score for ranking and storage. */
  recoverabilityScore: number;
  /** Normalised [0,1] risk score: how much attention this payment warrants. */
  riskScore: number;
  /** The action the deterministic layer would take with no AI available. */
  baselineAction: RecoveryActionType;
  /** Whether an AI diagnosis would add value for this payment. */
  requiresAiDiagnosis: boolean;
  /** Whether this payment must go to a human regardless of AI opinion. */
  requiresHumanReview: boolean;
  /** Human-readable justification, built from the factors below. */
  reason: string;
  /** The specific signals that produced this assessment, for explainability. */
  factors: string[];
  /** Hours between payment creation and the evaluation instant. */
  ageHours: number;
}

/**
 * Maps a raw gateway failure reason to a PRD classification.
 *
 * Deliberately exhaustive over FailureReason so that adding a new reason to
 * the domain is a compile error here rather than a silent UNKNOWN at runtime.
 */
export const FAILURE_REASON_CLASSIFICATION: Readonly<Record<FailureReason, Classification>> =
  Object.freeze({
    gateway_timeout: 'TEMPORARY_FAILURE',
    issuer_down: 'TEMPORARY_FAILURE',
    network_error: 'TEMPORARY_FAILURE',
    insufficient_funds: 'CUSTOMER_ACTION_REQUIRED',
    card_expired: 'PAYMENT_METHOD_PROBLEM',
    card_declined: 'PAYMENT_METHOD_PROBLEM',
    invalid_cvv: 'PAYMENT_METHOD_PROBLEM',
    authentication_failed: 'CUSTOMER_ACTION_REQUIRED',
    payment_method_unsupported: 'PAYMENT_METHOD_PROBLEM',
    customer_dropped_off: 'CHECKOUT_ABANDONMENT',
    session_expired: 'CHECKOUT_ABANDONMENT',
    subscription_charge_failed: 'SUBSCRIPTION_FAILURE',
    unknown: 'UNKNOWN',
  });
