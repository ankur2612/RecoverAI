import type {
  ObservedPaymentState,
  ProviderActionRequest,
  ProviderPaymentStatus,
  ProviderResult,
  RecoveryProvider,
} from '../provider.ts';

/**
 * ============================================================================
 * RAZORPAY TEST MODE PROVIDER
 * ============================================================================
 *
 * The ONLY module in the codebase that knows Razorpay exists. Everything above
 * it — executor, verifier, policy engine, AI layer — depends on the
 * RecoveryProvider abstraction and never sees a Razorpay type, URL, or
 * response shape. Architectural tests enforce that.
 *
 * TEST MODE ONLY. Two independent guards:
 *   1. loadConfig() rejects any RAZORPAY_KEY_ID that is not rzp_test_*
 *   2. this constructor rejects it again
 *
 * The duplication is deliberate: a provider constructed directly in a test or
 * a script bypasses config, so the class must defend itself.
 *
 * Implemented with direct HTTP rather than the Razorpay SDK. The surface we
 * need is two endpoints; pulling in an SDK would add a dependency whose types
 * could leak, and `fetch` is built into Node 22.
 */

/** Razorpay's public API base. Test and live share a host; the KEY selects mode. */
const RAZORPAY_API_BASE = 'https://api.razorpay.com/v1';

/** Wall-clock ceiling for a single request. */
const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Minimal HTTP surface, injectable so unit tests never touch the network.
 * Mirrors the shape of `fetch` but only the parts this provider uses.
 */
export interface HttpTransport {
  (
    url: string,
    init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal },
  ): Promise<{ status: number; ok: boolean; text(): Promise<string> }>;
}

export interface RazorpayProviderOptions {
  keyId: string;
  keySecret: string;
  /** Injected in tests. Defaults to global fetch. */
  transport?: HttpTransport;
  timeoutMs?: number;
  /** Base URL override, for a sandbox or a test double. */
  baseUrl?: string;
}

export class RazorpayConfigurationError extends Error {
  override name = 'RazorpayConfigurationError';
}

/**
 * Razorpay payment statuses, mapped to our provider-agnostic vocabulary.
 *
 * `authorized` is deliberately PENDING, not SUCCEEDED: the money is held but
 * not captured, so the revenue is not recovered yet. Mapping it to SUCCEEDED
 * would let the verifier declare a recovery that has not happened.
 */
const STATUS_MAP: Readonly<Record<string, ObservedPaymentState>> = Object.freeze({
  captured: 'SUCCEEDED',
  refunded: 'FAILED',
  authorized: 'PENDING',
  created: 'PENDING',
  pending: 'PENDING',
  failed: 'FAILED',
});

function mapStatus(razorpayStatus: string | undefined): ObservedPaymentState {
  if (typeof razorpayStatus !== 'string') return 'UNKNOWN';
  // An unrecognised status is UNKNOWN, never optimistically SUCCEEDED.
  return STATUS_MAP[razorpayStatus.toLowerCase()] ?? 'UNKNOWN';
}

/** Shape of the Razorpay fields we read. Everything else is discarded. */
interface RazorpayPayment {
  id?: string;
  status?: string;
  error_description?: string;
}

export class RazorpayTestProvider implements RecoveryProvider {
  readonly name = 'razorpay';

  readonly #keyId: string;
  readonly #keySecret: string;
  readonly #transport: HttpTransport;
  readonly #timeoutMs: number;
  readonly #baseUrl: string;

  constructor(options: RazorpayProviderOptions) {
    const { keyId, keySecret } = options;

    // ---- Test-mode enforcement, independent of config -------------------
    if (typeof keyId !== 'string' || keyId.trim() === '') {
      throw new RazorpayConfigurationError('RAZORPAY_KEY_ID is required.');
    }
    if (typeof keySecret !== 'string' || keySecret.trim() === '') {
      throw new RazorpayConfigurationError('RAZORPAY_KEY_SECRET is required.');
    }
    if (keyId.startsWith('rzp_live_')) {
      throw new RazorpayConfigurationError(
        'Refusing to construct a Razorpay provider with a LIVE Mode key. ' +
          'RecoverAI must never be pointed at real money.',
      );
    }
    if (!/^rzp_test_[A-Za-z0-9]+$/.test(keyId)) {
      // Fail closed: anything not recognisably a test key is rejected, rather
      // than only blocking the known-live prefix.
      throw new RazorpayConfigurationError(
        'RAZORPAY_KEY_ID must be a Test Mode key of the form "rzp_test_<alphanumeric>".',
      );
    }

    this.#keyId = keyId;
    this.#keySecret = keySecret;
    this.#transport = options.transport ?? defaultTransport;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#baseUrl = options.baseUrl ?? RAZORPAY_API_BASE;
  }

  /** True when this provider is pointed at Razorpay Test Mode. Always true. */
  get isTestMode(): boolean {
    return this.#keyId.startsWith('rzp_test_');
  }

  /**
   * Execute an authorized recovery action.
   *
   * ---------------------------------------------------------------------
   * RETRY -> RAZORPAY OPERATION MAPPING
   * ---------------------------------------------------------------------
   *
   * Razorpay's Payments API does NOT provide a generic "retry a failed
   * payment" operation. It provides:
   *
   *   GET  /payments/:id           fetch current state
   *   POST /payments/:id/capture   capture an AUTHORIZED payment
   *
   * So RecoverAI's domain action RETRY maps to "the Razorpay operation valid
   * for this payment's CURRENT state", which is decided by reading that state
   * first — never by assuming it:
   *
   *   authorized  -> capture (the one genuinely recoverable case)
   *   captured    -> already recovered; capture again would be a duplicate
   *   failed      -> NOT recoverable through this API. No endpoint is
   *                  invented, and we never claim a retry occurred.
   *   created/    -> not yet actionable
   *    pending
   *   refunded    -> terminal
   *
   * The domain action type is deliberately unchanged: RETRY still means "try
   * to recover this money", and the policy engine and executor are untouched.
   * What changes is that the PROVIDER is honest about which of its operations
   * can serve that intent for a given payment.
   *
   * Note what this does NOT do: it does not decide whether the action is
   * permitted. It receives an instruction the policy engine already authorized.
   */
  async executeAction(request: ProviderActionRequest): Promise<ProviderResult> {
    if (request.action !== 'RETRY') {
      // Reporting FAILED rather than throwing: this is a definite "did not
      // happen", not an ambiguous one.
      return {
        outcome: 'FAILED',
        providerActionId: null,
        paymentStatus: null,
        rawReference: null,
        errorMessage: `Razorpay provider does not implement action "${request.action}".`,
      };
    }

    // ---- Read current state before choosing an operation -----------------
    // Capturing blindly would send a capture for a failed payment, which is
    // meaningless, and would let a duplicate capture reach an already-captured
    // one. The read decides which operation is actually valid.
    const stateLookup = await this.#request('GET', `/payments/${request.paymentId}`);

    if (stateLookup.kind === 'TRANSPORT_ERROR') {
      // We could not establish state, so we must not act. UNKNOWN, never
      // FAILED: the executor treats this as UNCONFIRMED and will not retry.
      return {
        outcome: 'UNKNOWN',
        providerActionId: null,
        paymentStatus: null,
        rawReference: request.idempotencyKey,
        errorMessage: `Could not determine payment state before acting: ${stateLookup.message}`,
      };
    }

    if (stateLookup.kind === 'HTTP_ERROR') {
      const ambiguous = stateLookup.status >= 500 || stateLookup.status === 429;
      return {
        outcome: ambiguous ? 'UNKNOWN' : 'FAILED',
        providerActionId: null,
        paymentStatus: null,
        rawReference: request.idempotencyKey,
        errorMessage: `Could not determine payment state before acting: ${stateLookup.message}`,
      };
    }

    const current = stateLookup.body as RazorpayPayment;
    const currentStatus = typeof current.status === 'string' ? current.status.toLowerCase() : null;

    // ---- Dispatch only to an operation valid for this state --------------
    if (currentStatus !== 'authorized') {
      return this.#unsupportedForState(request, current, currentStatus);
    }

    const response = await this.#request('POST', `/payments/${request.paymentId}/capture`, {
      amount: String(request.amount),
      currency: request.currency,
    });

    if (response.kind === 'TRANSPORT_ERROR') {
      // A transport failure does NOT prove the remote side did nothing. The
      // executor classifies UNKNOWN as UNCONFIRMED, never as FAILED.
      return {
        outcome: 'UNKNOWN',
        providerActionId: null,
        paymentStatus: null,
        rawReference: request.idempotencyKey,
        errorMessage: response.message,
      };
    }

    if (response.kind === 'HTTP_ERROR') {
      // 5xx and 429 leave the outcome genuinely unknown; 4xx is a definite
      // rejection. Treating a 502 as FAILED could invite a double-charge.
      const ambiguous = response.status >= 500 || response.status === 429;
      return {
        outcome: ambiguous ? 'UNKNOWN' : 'FAILED',
        providerActionId: null,
        paymentStatus: null,
        rawReference: request.idempotencyKey,
        errorMessage: response.message,
      };
    }

    const payment = response.body as RazorpayPayment;
    const observed = mapStatus(payment.status);

    return {
      outcome: observed === 'SUCCEEDED' ? 'SUCCESS' : observed === 'FAILED' ? 'FAILED' : 'UNKNOWN',
      providerActionId: payment.id ?? null,
      // The status Razorpay reported. This is a claim about our request, not
      // verified evidence of recovery — the verifier decides that separately.
      paymentStatus: payment.status ?? null,
      rawReference: payment.id ?? request.idempotencyKey,
      errorMessage: payment.error_description ?? null,
    };
  }

  /**
   * Report the outcome for a payment Razorpay cannot recover via this API.
   *
   * The distinction that matters: NONE of these paths claim a retry occurred,
   * and none invent an endpoint. Each says plainly what the payment's state is
   * and why no operation was performed.
   *
   * `captured` deserves special note. The money is already collected, so the
   * request is effectively a duplicate. Reporting SUCCESS here would be wrong
   * — this action did not recover anything — but reporting FAILED would be
   * equally wrong, since the payment is fine. It is reported as SUCCESS with
   * the observed status attached, because the *intent* (money collected) holds;
   * the verifier then establishes the outcome from evidence, exactly as it
   * would for any other execution. Recovery is never claimed here.
   */
  #unsupportedForState(
    request: ProviderActionRequest,
    payment: RazorpayPayment,
    status: string | null,
  ): ProviderResult {
    const reference = payment.id ?? request.idempotencyKey;

    switch (status) {
      case 'captured':
        // Already collected. No capture is issued; a second one would be a
        // duplicate financial operation.
        return {
          outcome: 'SUCCESS',
          providerActionId: payment.id ?? null,
          paymentStatus: 'captured',
          rawReference: reference,
          errorMessage: null,
        };

      case 'failed':
        // The honest answer. Razorpay exposes no operation that revives a
        // failed payment; a new payment would have to be collected from the
        // customer, which is not something this provider can do.
        return {
          outcome: 'FAILED',
          providerActionId: null,
          paymentStatus: 'failed',
          rawReference: reference,
          errorMessage:
            'Payment is in Razorpay state "failed". The Razorpay Payments API provides no ' +
            'operation to retry a failed payment, so no action was performed. Recovery ' +
            'requires a new payment attempt by the customer.',
        };

      case 'refunded':
        return {
          outcome: 'FAILED',
          providerActionId: null,
          paymentStatus: 'refunded',
          rawReference: reference,
          errorMessage:
            'Payment is refunded, which is terminal. No recovery operation was performed.',
        };

      case 'created':
      case 'pending':
        // Not yet authorized, so there is nothing to capture. UNKNOWN rather
        // than FAILED: the payment may still progress on its own.
        return {
          outcome: 'UNKNOWN',
          providerActionId: null,
          paymentStatus: status,
          rawReference: reference,
          errorMessage:
            `Payment is in Razorpay state "${status}" and is not yet authorized, so there is ` +
            'nothing to capture. No action was performed.',
        };

      default:
        // An unrecognised or missing status. Fail closed: we do not know what
        // operation would be valid, so we perform none and claim nothing.
        return {
          outcome: 'UNKNOWN',
          providerActionId: null,
          paymentStatus: payment.status ?? null,
          rawReference: reference,
          errorMessage:
            `Payment is in an unrecognised Razorpay state (${payment.status ?? 'none reported'}). ` +
            'No action was performed.',
        };
    }
  }

  /**
   * Observe a payment's current state.
   *
   * A pure read (GET). This is what lets an UNCONFIRMED execution be resolved
   * without re-executing: verification asks what happened, never "do it again".
   */
  async getPaymentStatus(paymentId: string): Promise<ProviderPaymentStatus> {
    const response = await this.#request('GET', `/payments/${paymentId}`);

    if (response.kind === 'TRANSPORT_ERROR' || response.kind === 'HTTP_ERROR') {
      // We learned nothing. UNKNOWN, never a guess in either direction.
      return {
        state: 'UNKNOWN',
        rawStatus: null,
        reference: null,
        errorMessage: response.message,
      };
    }

    const payment = response.body as RazorpayPayment;
    return {
      state: mapStatus(payment.status),
      rawStatus: payment.status ?? null,
      reference: payment.id ?? paymentId,
      errorMessage: null,
    };
  }

  /**
   * Issue one API request.
   *
   * The Authorization header is constructed here and never returned, logged,
   * or attached to an error. Errors carry a status and a sanitised message
   * only — see `sanitiseError`.
   */
  async #request(
    method: 'GET' | 'POST',
    path: string,
    form?: Record<string, string>,
  ): Promise<RazorpayResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);

    try {
      const headers: Record<string, string> = {
        // Basic auth over the key pair. Never logged.
        Authorization: `Basic ${Buffer.from(`${this.#keyId}:${this.#keySecret}`).toString('base64')}`,
        Accept: 'application/json',
      };

      const init: Parameters<HttpTransport>[1] = {
        method,
        headers,
        signal: controller.signal,
      };

      if (form !== undefined) {
        headers['Content-Type'] = 'application/x-www-form-urlencoded';
        init.body = new URLSearchParams(form).toString();
      }

      const response = await this.#transport(`${this.#baseUrl}${path}`, init);
      const text = await response.text();

      if (!response.ok) {
        return {
          kind: 'HTTP_ERROR',
          status: response.status,
          message: `Razorpay responded ${response.status}: ${sanitiseError(text)}`,
        };
      }

      try {
        return { kind: 'OK', body: JSON.parse(text) as unknown };
      } catch {
        return {
          kind: 'HTTP_ERROR',
          status: response.status,
          message: 'Razorpay returned a response that was not valid JSON.',
        };
      }
    } catch (error) {
      const message =
        (error as Error).name === 'AbortError'
          ? `Razorpay request timed out after ${this.#timeoutMs}ms.`
          : `Razorpay request failed: ${sanitiseError((error as Error).message)}`;
      return { kind: 'TRANSPORT_ERROR', message };
    } finally {
      clearTimeout(timer);
    }
  }
}

type RazorpayResponse =
  | { kind: 'OK'; body: unknown }
  | { kind: 'HTTP_ERROR'; status: number; message: string }
  | { kind: 'TRANSPORT_ERROR'; message: string };

/**
 * Strip anything credential-shaped from text that will be stored or logged.
 *
 * Razorpay error bodies do not normally echo credentials, but an error message
 * ends up in the audit trail and in `error_message` on the action row, so it
 * is scrubbed rather than trusted. Truncated to keep a stray payload out of
 * the database.
 */
export function sanitiseError(text: string): string {
  return text
    .replace(/rzp_(test|live)_[A-Za-z0-9]+/g, '[redacted-key]')
    .replace(/Basic\s+[A-Za-z0-9+/=]+/gi, '[redacted-auth]')
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, '[redacted-auth]')
    .replace(/"(key_secret|secret|password|api_key)"\s*:\s*"[^"]*"/gi, '"$1":"[redacted]"')
    .slice(0, 300);
}

/** Default transport: Node's global fetch, adapted to HttpTransport. */
const defaultTransport: HttpTransport = async (url, init) => {
  const response = await fetch(url, init as RequestInit);
  return {
    status: response.status,
    ok: response.ok,
    text: () => response.text(),
  };
};
