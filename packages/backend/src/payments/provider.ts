import type { MinorUnits, RecoveryActionType } from '../shared/types.ts';

/**
 * ============================================================================
 * RECOVERY PROVIDER ABSTRACTION
 * ============================================================================
 *
 * The boundary between "we decided to act" and "something outside this process
 * acted". The executor depends on this interface only, never on a vendor SDK,
 * so a Razorpay implementation can be added later without touching the
 * executor, the policy engine, or the API.
 *
 * A provider is deliberately given no authority: it receives an already
 * authorized instruction and reports what happened. It cannot decide whether
 * an action is permitted, and it is never asked to.
 */

/**
 * What the provider reports back.
 *
 * The three outcomes are NOT interchangeable:
 *
 *   SUCCESS  the provider accepted/completed the request. This says nothing
 *            about whether revenue was recovered — that needs verification.
 *   FAILED   the provider explicitly rejected the request. Definitively did
 *            not happen.
 *   UNKNOWN  no usable answer (timeout, connection dropped mid-flight). The
 *            action may or may not have taken effect. This is the dangerous
 *            one: it must never be treated as FAILED and never blindly retried.
 */
export const PROVIDER_OUTCOMES = ['SUCCESS', 'FAILED', 'UNKNOWN'] as const;
export type ProviderOutcome = (typeof PROVIDER_OUTCOMES)[number];

/** An instruction to perform, already authorized by the policy engine. */
export interface ProviderActionRequest {
  /** The logical action key; also what the provider should deduplicate on. */
  idempotencyKey: string;
  action: RecoveryActionType;
  paymentId: string;
  amount: MinorUnits;
  currency: string;
}

/** The provider's structured report. */
export interface ProviderResult {
  outcome: ProviderOutcome;
  /** The provider's own identifier for the action it performed, if any. */
  providerActionId: string | null;
  /**
   * The payment status the provider observed AFTER the action, when it can
   * report one. Null when unknown — never guessed.
   */
  paymentStatus: string | null;
  /** Opaque provider reference for reconciliation (e.g. a request id). */
  rawReference: string | null;
  /** Present for FAILED and UNKNOWN; must never contain a credential. */
  errorMessage: string | null;
}

/**
 * The payment state a provider can observe, independent of what it said about
 * our request.
 *
 *   SUCCEEDED  the payment completed
 *   PENDING    still in flight; no conclusion is available yet
 *   FAILED     the payment definitively did not complete
 *   UNKNOWN    the provider cannot tell us (lookup failed, unrecognised state)
 *
 * UNKNOWN is distinct from PENDING: PENDING means "not yet", UNKNOWN means
 * "we could not find out". Both fail closed, but they are different facts and
 * an operator needs to tell them apart.
 */
export const OBSERVED_PAYMENT_STATES = ['SUCCEEDED', 'PENDING', 'FAILED', 'UNKNOWN'] as const;
export type ObservedPaymentState = (typeof OBSERVED_PAYMENT_STATES)[number];

/** What the provider observed when asked about a payment's current state. */
export interface ProviderPaymentStatus {
  state: ObservedPaymentState;
  /** The provider's own status string, for the audit trail. Never a secret. */
  rawStatus: string | null;
  /** Opaque reference for reconciliation. */
  reference: string | null;
  /** Present when the lookup itself failed. */
  errorMessage: string | null;
}

/**
 * The provider contract.
 *
 * `executeAction` may throw. A throw is treated by the executor as UNKNOWN
 * rather than FAILED, because a thrown exception (a socket error, an aborted
 * request) does not prove the remote side did nothing.
 *
 * `getPaymentStatus` is a READ. It is what lets an UNCONFIRMED execution be
 * resolved without re-executing anything: verification asks "what happened?",
 * never "do it again". A provider that cannot answer must report UNKNOWN
 * rather than guessing.
 */
export interface RecoveryProvider {
  /** Stable identifier recorded on the action and in the audit trail. */
  readonly name: string;
  executeAction(request: ProviderActionRequest): Promise<ProviderResult>;
  /** Observe a payment's current state. Must have no side effects. */
  getPaymentStatus(paymentId: string): Promise<ProviderPaymentStatus>;
}

/** Actions a provider can actually perform today. */
export const EXECUTABLE_ACTIONS: readonly RecoveryActionType[] = Object.freeze(['RETRY']);

export function isExecutableAction(action: string): action is RecoveryActionType {
  return (EXECUTABLE_ACTIONS as readonly string[]).includes(action);
}
