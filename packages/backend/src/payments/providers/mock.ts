import type {
  ObservedPaymentState,
  ProviderActionRequest,
  ProviderOutcome,
  ProviderPaymentStatus,
  ProviderResult,
  RecoveryProvider,
} from '../provider.ts';

/**
 * Deterministic mock recovery provider.
 *
 * No randomness anywhere: the outcome is whatever the test configured, so
 * success, explicit failure, and the ambiguous timeout path are all reachable
 * and reproducible. This is what makes the UNKNOWN safety behaviour testable
 * without a flaky network.
 *
 * It also counts its own calls, which is how the concurrency and idempotency
 * tests prove the provider was invoked exactly once.
 */
export interface MockProviderOptions {
  /** Outcome for every call unless a queue entry overrides it. */
  defaultOutcome?: ProviderOutcome;
  /** Outcomes consumed in order, one per call, before falling back. */
  outcomeQueue?: ProviderOutcome[];
  /** Throw instead of returning. The executor must treat this as UNKNOWN. */
  throwOnCall?: boolean;
  /** Artificial delay in ms, used to widen the window in concurrency tests. */
  delayMs?: number;
  /**
   * The payment state getPaymentStatus() reports, independent of the execution
   * outcome. Kept separate on purpose: a provider can accept a request and the
   * payment still end up PENDING or FAILED, which is exactly the ambiguity the
   * verification layer exists to handle.
   */
  observedState?: ObservedPaymentState;
  /** Per-payment overrides, so one test can hold several payments at once. */
  observedStateByPayment?: Record<string, ObservedPaymentState>;
  /** Make the status lookup itself fail, exercising the fail-closed path. */
  throwOnStatusLookup?: boolean;
}

export class MockRecoveryProvider implements RecoveryProvider {
  readonly name = 'mock';

  #defaultOutcome: ProviderOutcome;
  #queue: ProviderOutcome[];
  #throwOnCall: boolean;
  #delayMs: number;
  #observedState: ObservedPaymentState;
  #observedByPayment: Record<string, ObservedPaymentState>;
  #throwOnStatusLookup: boolean;

  /** Every request received, in order. Tests assert on length and content. */
  readonly calls: ProviderActionRequest[] = [];

  /** Every payment id whose status was looked up, in order. */
  readonly statusLookups: string[] = [];

  constructor(options: MockProviderOptions = {}) {
    this.#defaultOutcome = options.defaultOutcome ?? 'SUCCESS';
    this.#queue = [...(options.outcomeQueue ?? [])];
    this.#throwOnCall = options.throwOnCall ?? false;
    this.#delayMs = options.delayMs ?? 0;
    this.#observedState = options.observedState ?? 'SUCCEEDED';
    this.#observedByPayment = { ...(options.observedStateByPayment ?? {}) };
    this.#throwOnStatusLookup = options.throwOnStatusLookup ?? false;
  }

  /** Number of times the provider was actually invoked. */
  get callCount(): number {
    return this.calls.length;
  }

  /** Number of status lookups. Proves verification did not re-execute. */
  get statusLookupCount(): number {
    return this.statusLookups.length;
  }

  /** Change the outcome of the next call, for multi-step tests. */
  setNextResult(outcome: ProviderOutcome): void {
    this.#queue.push(outcome);
  }

  /** Change the observed payment state, e.g. to simulate a pending settling. */
  setObservedState(state: ObservedPaymentState, paymentId?: string): void {
    if (paymentId === undefined) this.#observedState = state;
    else this.#observedByPayment[paymentId] = state;
  }

  reset(): void {
    this.calls.length = 0;
    this.statusLookups.length = 0;
    this.#queue = [];
  }

  /**
   * Observe a payment's current state.
   *
   * A pure read: it never executes an action, never mutates provider state,
   * and is safe to call repeatedly. That is what makes verification idempotent
   * and what allows an UNCONFIRMED execution to be resolved without retrying.
   */
  async getPaymentStatus(paymentId: string): Promise<ProviderPaymentStatus> {
    this.statusLookups.push(paymentId);

    if (this.#delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.#delayMs));
    }

    if (this.#throwOnStatusLookup) {
      // The lookup failed, so we know nothing. Reporting UNKNOWN rather than
      // throwing keeps the verifier's fail-closed path simple and explicit.
      return {
        state: 'UNKNOWN',
        rawStatus: null,
        reference: null,
        errorMessage: 'mock provider: status lookup failed',
      };
    }

    const state = this.#observedByPayment[paymentId] ?? this.#observedState;

    return {
      state,
      rawStatus: MOCK_RAW_STATUS[state],
      reference: `mockstatus_${paymentId}`,
      errorMessage: null,
    };
  }

  async executeAction(request: ProviderActionRequest): Promise<ProviderResult> {
    this.calls.push(request);

    if (this.#delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.#delayMs));
    }

    if (this.#throwOnCall) {
      // A thrown transport error, not a rejection: the remote side may well
      // have acted. The executor is responsible for classifying this UNKNOWN.
      throw new Error('mock provider: connection reset');
    }

    const outcome = this.#queue.shift() ?? this.#defaultOutcome;

    // Derived from the idempotency key so the reference is stable across runs.
    const reference = `mock_${request.idempotencyKey}`;

    switch (outcome) {
      case 'SUCCESS':
        return {
          outcome: 'SUCCESS',
          providerActionId: `mact_${request.idempotencyKey}`,
          // The provider reports the observed status. Note this is the
          // provider's claim, not verified recovery evidence.
          paymentStatus: 'captured',
          rawReference: reference,
          errorMessage: null,
        };

      case 'FAILED':
        return {
          outcome: 'FAILED',
          providerActionId: null,
          paymentStatus: 'failed',
          rawReference: reference,
          errorMessage: 'mock provider: action rejected by gateway',
        };

      case 'UNKNOWN':
        return {
          outcome: 'UNKNOWN',
          providerActionId: null,
          // Deliberately null: an unknown outcome means we cannot claim to
          // know the payment's state either.
          paymentStatus: null,
          rawReference: reference,
          errorMessage: 'mock provider: request timed out with no response',
        };
    }
  }
}

/** Provider-native status strings, recorded as evidence. Never a secret. */
const MOCK_RAW_STATUS: Readonly<Record<ObservedPaymentState, string | null>> = Object.freeze({
  SUCCEEDED: 'captured',
  PENDING: 'authorized',
  FAILED: 'failed',
  UNKNOWN: null,
});
