/**
 * Core domain vocabulary for RecoverAI.
 *
 * Money rule: every amount in this system is an integer in the smallest
 * currency unit (paise for INR). Never use floats for money.
 */

/** Integer amount in the smallest currency unit (e.g. paise). */
export type MinorUnits = number;

export const CURRENCIES = ['INR'] as const;
export type Currency = (typeof CURRENCIES)[number];

/** Lifecycle state of a payment, mirroring Razorpay's vocabulary. */
export const PAYMENT_STATUSES = [
  'created',
  'authorized',
  'captured',
  'failed',
  'refunded',
  'abandoned',
] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

/**
 * Raw failure reasons as they arrive from the gateway. These are observations,
 * not diagnoses — the AI maps these to a FailureClassification.
 */
export const FAILURE_REASONS = [
  'gateway_timeout',
  'issuer_down',
  'network_error',
  'insufficient_funds',
  'card_expired',
  'card_declined',
  'invalid_cvv',
  'authentication_failed',
  'payment_method_unsupported',
  'customer_dropped_off',
  'session_expired',
  'subscription_charge_failed',
  'unknown',
] as const;
export type FailureReason = (typeof FAILURE_REASONS)[number];

/** AI diagnosis categories (PRD section 7). */
export const CLASSIFICATIONS = [
  'TEMPORARY_FAILURE',
  'CUSTOMER_ACTION_REQUIRED',
  'PAYMENT_METHOD_PROBLEM',
  'CHECKOUT_ABANDONMENT',
  'SUBSCRIPTION_FAILURE',
  'REPEATED_FAILURE',
  'UNKNOWN',
] as const;
export type Classification = (typeof CLASSIFICATIONS)[number];

/** The complete, bounded set of recovery actions (PRD section 8). */
export const RECOVERY_ACTIONS = [
  'RETRY',
  'REMINDER',
  'CHECKOUT_RECOVERY',
  'SUBSCRIPTION_RETRY',
  'ESCALATE',
  'NO_ACTION',
] as const;
export type RecoveryActionType = (typeof RECOVERY_ACTIONS)[number];

/** Outcome of the deterministic policy engine (PRD section 9). */
export const POLICY_DECISIONS = ['ALLOWED', 'BLOCKED', 'REQUIRES_APPROVAL'] as const;
export type PolicyDecision = (typeof POLICY_DECISIONS)[number];

/**
 * Execution lifecycle of one recovery action.
 *
 *   PENDING            row created, idempotency key claimed, provider not called
 *   EXECUTING          provider request in flight
 *   SUCCESS            provider accepted/completed the request
 *   FAILED             provider explicitly rejected the request
 *   UNCONFIRMED        provider outcome is UNKNOWN (timeout, no response)
 *   SKIPPED_DUPLICATE  an equivalent action already owned the idempotency key
 *
 * UNCONFIRMED is a safety state, not a failure. It means "we do not know
 * whether this happened", and it must never be collapsed into FAILED or
 * resolved by an automatic retry — only by verifying provider/payment state.
 *
 * SUCCESS means the provider accepted the action. It does NOT mean revenue was
 * recovered; that requires separate outcome verification.
 */
export const EXECUTION_STATUSES = [
  'PENDING',
  'EXECUTING',
  'SUCCESS',
  'FAILED',
  'UNCONFIRMED',
  'SKIPPED_DUPLICATE',
] as const;
export type ExecutionStatus = (typeof EXECUTION_STATUSES)[number];

export const RECOVERY_CASE_STATUSES = [
  'OPEN',
  'AWAITING_APPROVAL',
  'EXECUTING',
  'RECOVERED',
  'FAILED',
  'ESCALATED',
  'CLOSED',
] as const;
export type RecoveryCaseStatus = (typeof RECOVERY_CASE_STATUSES)[number];

export interface Merchant {
  id: string;
  name: string;
  currency: Currency;
  createdAt: Date;
}

export interface Customer {
  id: string;
  merchantId: string;
  name: string;
  email: string;
  createdAt: Date;
}

export interface Payment {
  id: string;
  merchantId: string;
  customerId: string;
  orderId: string;
  amount: MinorUnits;
  currency: Currency;
  status: PaymentStatus;
  failureReason: FailureReason | null;
  /** Number of retry attempts already made against this payment. */
  attemptCount: number;
  /** True when this payment belongs to a subscription cycle. */
  isSubscription: boolean;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Ground-truth labels for a synthetic record. These exist ONLY in the
 * generated dataset so the evaluation harness can score the AI against them.
 * They are never shown to the AI provider and never used by the policy engine.
 */
export interface GroundTruth {
  /** The correct classification a perfect diagnoser would produce. */
  classification: Classification;
  /** Whether this payment's revenue is genuinely recoverable. */
  recoverable: boolean;
  /**
   * Probability that a permitted recovery action actually succeeds. The
   * simulated executor samples against this to decide the real outcome, so
   * "revenue recovered" reflects simulated evidence, never an AI claim.
   */
  recoveryProbability: number;
  /** The action an ideal agent would choose. */
  idealAction: RecoveryActionType;
}

/** One synthetic record: the payment plus its hidden labels. */
export interface SyntheticRecord {
  payment: Payment;
  groundTruth: GroundTruth;
  /** 'dev' for development/tuning, 'eval' for the held-out set. */
  split: 'dev' | 'eval';
}

export interface SyntheticDataset {
  seed: number;
  generatedAt: string;
  merchants: Merchant[];
  customers: Customer[];
  records: SyntheticRecord[];
}
