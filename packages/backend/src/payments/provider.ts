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
 * The provider contract.
 *
 * `executeAction` may throw. A throw is treated by the executor as UNKNOWN
 * rather than FAILED, because a thrown exception (a socket error, an aborted
 * request) does not prove the remote side did nothing.
 */
export interface RecoveryProvider {
  /** Stable identifier recorded on the action and in the audit trail. */
  readonly name: string;
  executeAction(request: ProviderActionRequest): Promise<ProviderResult>;
}

/** Actions a provider can actually perform today. */
export const EXECUTABLE_ACTIONS: readonly RecoveryActionType[] = Object.freeze(['RETRY']);

export function isExecutableAction(action: string): action is RecoveryActionType {
  return (EXECUTABLE_ACTIONS as readonly string[]).includes(action);
}
