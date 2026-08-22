import type {
  ProviderActionRequest,
  ProviderOutcome,
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
}

export class MockRecoveryProvider implements RecoveryProvider {
  readonly name = 'mock';

  #defaultOutcome: ProviderOutcome;
  #queue: ProviderOutcome[];
  #throwOnCall: boolean;
  #delayMs: number;

  /** Every request received, in order. Tests assert on length and content. */
  readonly calls: ProviderActionRequest[] = [];

  constructor(options: MockProviderOptions = {}) {
    this.#defaultOutcome = options.defaultOutcome ?? 'SUCCESS';
    this.#queue = [...(options.outcomeQueue ?? [])];
    this.#throwOnCall = options.throwOnCall ?? false;
    this.#delayMs = options.delayMs ?? 0;
  }

  /** Number of times the provider was actually invoked. */
  get callCount(): number {
    return this.calls.length;
  }

  /** Change the outcome of the next call, for multi-step tests. */
  setNextResult(outcome: ProviderOutcome): void {
    this.#queue.push(outcome);
  }

  reset(): void {
    this.calls.length = 0;
    this.#queue = [];
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
