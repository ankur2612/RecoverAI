import type {
  Classification,
  FailureReason,
  PaymentStatus,
  RecoveryActionType,
} from '../shared/types.ts';

/**
 * A scenario is one labelled class of payment outcome (PRD section 17).
 *
 * The generator picks a scenario first, then materialises a payment from it.
 * Ground truth therefore comes from the scenario definition rather than being
 * reverse-engineered from the generated row — which means the labels cannot
 * silently drift out of sync with the data.
 */
export interface Scenario {
  /** Stable identifier, used in dataset summaries and eval reports. */
  readonly key: string;
  /** Relative sampling weight within the dataset. */
  readonly weight: number;
  readonly status: PaymentStatus;
  /** Gateway reasons this scenario can produce; one is sampled per record. */
  readonly failureReasons: readonly FailureReason[];
  /** Correct diagnosis for records drawn from this scenario. */
  readonly classification: Classification;
  /** Whether the revenue is genuinely recoverable. */
  readonly recoverable: boolean;
  /** Range of true recovery probability, sampled per record. */
  readonly recoveryProbability: readonly [number, number];
  /** The action an ideal agent would take. */
  readonly idealAction: RecoveryActionType;
  /** Range of prior attempts already made on this payment. */
  readonly attemptCount: readonly [number, number];
  readonly isSubscription: boolean;
  /**
   * Multiplier applied to the mean transaction value. High-value scenarios use
   * a large multiplier so the policy engine's approval path gets exercised.
   */
  readonly amountMultiplier: readonly [number, number];
  /** Range of hours between payment creation and "now". */
  readonly ageHours: readonly [number, number];
}

/**
 * The scenario catalogue. Weights are tuned so that roughly 55% of records are
 * successful payments (realistic for a healthy merchant) and the remaining 45%
 * spread across the failure classes the PRD requires. Recoverable and
 * non-recoverable cases are both well represented so that precision and recall
 * are both meaningful — a dataset of only recoverable failures would let a
 * trivial "always retry" agent score perfectly.
 */
export const SCENARIOS: readonly Scenario[] = [
  {
    key: 'successful_payment',
    weight: 55,
    status: 'captured',
    failureReasons: [],
    classification: 'UNKNOWN', // Not a failure; never diagnosed.
    recoverable: false,
    recoveryProbability: [0, 0],
    idealAction: 'NO_ACTION',
    attemptCount: [0, 1],
    isSubscription: false,
    amountMultiplier: [0.3, 2.5],
    ageHours: [1, 240],
  },
  {
    key: 'temporary_gateway_failure',
    weight: 13,
    status: 'failed',
    failureReasons: ['gateway_timeout', 'issuer_down', 'network_error'],
    classification: 'TEMPORARY_FAILURE',
    recoverable: true,
    recoveryProbability: [0.7, 0.92],
    idealAction: 'RETRY',
    attemptCount: [0, 1],
    isSubscription: false,
    amountMultiplier: [0.2, 2.0],
    ageHours: [1, 36],
  },
  {
    key: 'insufficient_funds',
    weight: 7,
    status: 'failed',
    failureReasons: ['insufficient_funds'],
    classification: 'CUSTOMER_ACTION_REQUIRED',
    recoverable: true,
    // Retrying immediately fails; a reminder gives the customer time to fund.
    recoveryProbability: [0.35, 0.6],
    idealAction: 'REMINDER',
    attemptCount: [0, 2],
    isSubscription: false,
    amountMultiplier: [0.3, 2.2],
    ageHours: [2, 72],
  },
  {
    key: 'payment_method_problem',
    weight: 6,
    status: 'failed',
    failureReasons: ['card_expired', 'card_declined', 'invalid_cvv', 'payment_method_unsupported'],
    classification: 'PAYMENT_METHOD_PROBLEM',
    recoverable: true,
    // Only recoverable if the customer updates their method — never by retry.
    recoveryProbability: [0.25, 0.5],
    idealAction: 'REMINDER',
    attemptCount: [0, 2],
    isSubscription: false,
    amountMultiplier: [0.3, 2.0],
    ageHours: [2, 96],
  },
  {
    key: 'checkout_abandonment',
    weight: 8,
    status: 'abandoned',
    failureReasons: ['customer_dropped_off', 'session_expired'],
    classification: 'CHECKOUT_ABANDONMENT',
    recoverable: true,
    recoveryProbability: [0.2, 0.45],
    idealAction: 'CHECKOUT_RECOVERY',
    attemptCount: [0, 0],
    isSubscription: false,
    amountMultiplier: [0.4, 3.0],
    ageHours: [1, 96],
  },
  {
    key: 'subscription_failure',
    weight: 5,
    status: 'failed',
    failureReasons: ['subscription_charge_failed', 'insufficient_funds', 'card_expired'],
    classification: 'SUBSCRIPTION_FAILURE',
    recoverable: true,
    recoveryProbability: [0.5, 0.78],
    idealAction: 'SUBSCRIPTION_RETRY',
    attemptCount: [0, 2],
    isSubscription: true,
    amountMultiplier: [0.2, 1.2],
    ageHours: [1, 120],
  },
  {
    key: 'repeated_failure',
    weight: 4,
    status: 'failed',
    failureReasons: ['card_declined', 'insufficient_funds', 'authentication_failed'],
    classification: 'REPEATED_FAILURE',
    recoverable: false,
    // Retry limit already exhausted; further automation is waste and friction.
    recoveryProbability: [0.02, 0.12],
    idealAction: 'ESCALATE',
    attemptCount: [3, 5],
    isSubscription: false,
    amountMultiplier: [0.3, 2.5],
    ageHours: [12, 240],
  },
  {
    key: 'high_value_failure',
    weight: 3,
    status: 'failed',
    failureReasons: ['gateway_timeout', 'authentication_failed', 'card_declined'],
    classification: 'TEMPORARY_FAILURE',
    recoverable: true,
    recoveryProbability: [0.55, 0.8],
    // Recoverable, but above the automated ceiling — a human must approve.
    idealAction: 'ESCALATE',
    attemptCount: [0, 1],
    isSubscription: false,
    amountMultiplier: [5.0, 14.0],
    ageHours: [1, 48],
  },
  {
    key: 'unknown_failure',
    weight: 3,
    status: 'failed',
    failureReasons: ['unknown'],
    classification: 'UNKNOWN',
    recoverable: false,
    recoveryProbability: [0.05, 0.25],
    // PRD section 10: UNKNOWN_FAILURE = no automatic action.
    idealAction: 'ESCALATE',
    attemptCount: [0, 2],
    isSubscription: false,
    amountMultiplier: [0.3, 2.5],
    ageHours: [2, 168],
  },
  {
    key: 'permanent_failure',
    weight: 4,
    status: 'failed',
    failureReasons: ['authentication_failed', 'card_declined'],
    classification: 'PAYMENT_METHOD_PROBLEM',
    recoverable: false,
    recoveryProbability: [0.0, 0.08],
    idealAction: 'NO_ACTION',
    attemptCount: [2, 4],
    isSubscription: false,
    amountMultiplier: [0.2, 1.8],
    ageHours: [24, 336],
  },
] as const;

/** Sampling weights keyed by scenario key, for Rng.weighted(). */
export const SCENARIO_WEIGHTS: Readonly<Record<string, number>> = Object.freeze(
  Object.fromEntries(SCENARIOS.map((s) => [s.key, s.weight])),
);

const BY_KEY = new Map(SCENARIOS.map((s) => [s.key, s]));

export function scenarioByKey(key: string): Scenario {
  const scenario = BY_KEY.get(key);
  if (scenario === undefined) throw new Error(`unknown scenario "${key}"`);
  return scenario;
}
