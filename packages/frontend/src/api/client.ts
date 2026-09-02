import type {
  AuditListResponse,
  Payment,
  BatchRun,
  CaseDetail,
  CaseListResponse,
  CaseStatus,
  DecisionResponse,
  HealthResponse,
  PaymentListResponse,
  PaymentStatus,
  RecoveryActionRecord,
  RecoveryAnalytics,
  SweepRun,
} from '../types/domain.ts';

/**
 * The only place in the frontend that talks to the network.
 *
 * The browser never holds a provider credential; every privileged operation
 * goes through the backend, which re-evaluates policy before anything moves.
 *
 * THE RETRY RULE: GETs may be retried, financial POSTs never. An auto-retried
 * /execute could produce a second provider request, and the correct answer to
 * an ambiguous write is to stop and show the operator, not to try again.
 */

/** Requests that must never be retried automatically. */
export const NON_RETRYABLE_METHODS = ['POST', 'PUT', 'PATCH', 'DELETE'] as const;

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  /** Field-level validation issues, when the backend supplied them. */
  readonly issues: { field: string; message: string }[];

  constructor(status: number, code: string, message: string, issues: { field: string; message: string }[] = []) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.issues = issues;
  }

  /**
   * A message safe and useful to show an operator.
   *
   * Deliberately does not surface raw provider payloads: a provider error can
   * echo a request, and the backend already scrubs its own messages, but the
   * frontend adds a second layer rather than trusting that.
   */
  get operatorMessage(): string {
    switch (this.status) {
      case 401:
        return 'Authentication required. Check the API token and sign in again.';
      case 403:
        return 'You are not authorized to perform this operation.';
      case 404:
        return 'Not found. It may have been removed, or the identifier is wrong.';
      case 409:
        return 'This changed state since you loaded it. Refresh and review the latest state.';
      case 429:
        return 'Too many requests. Please try again shortly.';
      case 400:
        return this.issues.length > 0
          ? `Invalid request: ${this.issues.map((i) => `${i.field} — ${i.message}`).join('; ')}`
          : this.message;
      default:
        return this.status >= 500
          ? 'The server could not complete the request. No recovery outcome was assumed.'
          : this.message;
    }
  }
}

/** Thrown when the request was cancelled, so callers can ignore it silently. */
export class AbortedError extends Error {
  constructor() {
    super('aborted');
    this.name = 'AbortedError';
  }
}


const TOKEN_KEY = 'recoverai.token';

/**
 * The shared API token, held in sessionStorage.
 *
 * HONEST LIMITATION: any token reachable by browser JavaScript is exposed by
 * an XSS. sessionStorage is chosen over localStorage because it dies with the
 * tab rather than persisting, which shortens the window — it does not close
 * it. This is an operator-console posture suitable for a demo and internal
 * use, NOT a production auth model. The real fix is per-user identity with
 * short-lived credentials, which the backend does not yet have.
 *
 * The token is never logged, never placed in a URL, and never rendered.
 */
export const tokenStore = {
  get(): string | null {
    try {
      return sessionStorage.getItem(TOKEN_KEY);
    } catch {
      // Private browsing or blocked storage. Treated as "no token".
      return null;
    }
  },
  set(token: string): void {
    try {
      sessionStorage.setItem(TOKEN_KEY, token);
    } catch {
      // Non-fatal: the session simply will not survive a reload.
    }
  },
  clear(): void {
    try {
      sessionStorage.removeItem(TOKEN_KEY);
    } catch {
    }
  },
};

const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL ?? '').replace(/\/$/, '');
interface RequestOptions {
  method?: string;
  body?: unknown;
  signal?: AbortSignal;
  /** Retries for idempotent reads only. Ignored for any non-GET method. */
  retries?: number;
}

interface ErrorBody {
  error?: string;
  message?: string;
  issues?: { field: string; message: string }[];
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const method = options.method ?? 'GET';
  const token = tokenStore.get();

  const headers: Record<string, string> = { Accept: 'application/json' };
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  // The token travels in a header, never a query string, so it cannot be
  // captured by a proxy access log or a browser history entry.
  if (token !== null) headers.Authorization = `Bearer ${token}`;

  // Retries apply ONLY to GET. This is the load-bearing safety rule of the
  // client: a retried POST /execute could mean a second provider request.
  const maxAttempts =
    method === 'GET' ? Math.max(1, (options.retries ?? 2) + 1) : 1;

  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const response = await fetch(path, {
        method,
        headers,
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });

      if (response.status === 204) return undefined as T;

      const text = await response.text();
      const parsed: unknown = text === '' ? {} : JSON.parse(text);

      if (!response.ok) {
        const body = parsed as ErrorBody;
        const error = new ApiError(
          response.status,
          body.error ?? 'request_failed',
          body.message ?? `Request failed with status ${response.status}.`,
          body.issues ?? [],
        );
        // A 5xx on a GET is worth one more try; a 4xx never is, because the
        // request itself is what the server objected to.
        if (method === 'GET' && response.status >= 500 && attempt < maxAttempts) {
          lastError = error;
          continue;
        }
        throw error;
      }

      return parsed as T;
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        throw new AbortedError();
      }
      if (error instanceof ApiError) throw error;

      // A transport failure on a read may be transient.
      lastError = error;
      if (method !== 'GET' || attempt >= maxAttempts) {
        throw new ApiError(
          0,
          'network_error',
          'Could not reach the RecoverAI API. Check that the backend is running.',
        );
      }
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new ApiError(0, 'network_error', 'The request failed.');
}

function query(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') search.set(key, String(value));
  }
  const encoded = search.toString();
  return encoded === '' ? '' : `?${encoded}`;
}


export const api = {

  health: (signal?: AbortSignal) =>
    request<HealthResponse>('/api/health', signal === undefined ? {} : { signal }),

  listCases: (
    params: { status?: CaseStatus; limit?: number; offset?: number } = {},
    signal?: AbortSignal,
  ) =>
    request<CaseListResponse>(`/api/recovery/cases${query(params)}`, {
      ...(signal === undefined ? {} : { signal }),
    }),

  getCase: (caseId: string, signal?: AbortSignal) =>
    request<CaseDetail>(`/api/recovery/${encodeURIComponent(caseId)}`, {
      ...(signal === undefined ? {} : { signal }),
    }),

  listActions: (caseId: string, signal?: AbortSignal) =>
    request<{ actions: RecoveryActionRecord[] }>(
      `/api/recovery/${encodeURIComponent(caseId)}/actions`,
      { ...(signal === undefined ? {} : { signal }) },
    ),

  listPayments: (
    params: {
      merchant_id?: string;
      customer_id?: string;
      status?: PaymentStatus;
      limit?: number;
      offset?: number;
    } = {},
    signal?: AbortSignal,
  ) =>
    request<PaymentListResponse>(`/api/payments${query(params)}`, {
      ...(signal === undefined ? {} : { signal }),
    }),

  getPayment: (paymentId: string, signal?: AbortSignal) =>
    request<{ payment: Payment }>(`/api/payments/${encodeURIComponent(paymentId)}`, {
      ...(signal === undefined ? {} : { signal }),
    }),

  analytics: (params: { merchant_id?: string } = {}, signal?: AbortSignal) =>
    request<RecoveryAnalytics>(`/api/analytics/recovery${query(params)}`, {
      ...(signal === undefined ? {} : { signal }),
    }),

  listAudit: (
    params: {
      payment_id?: string;
      case_id?: string;
      event_type?: string;
      actor?: string;
      limit?: number;
      offset?: number;
    } = {},
    signal?: AbortSignal,
  ) =>
    request<AuditListResponse>(`/api/audit${query(params)}`, {
      ...(signal === undefined ? {} : { signal }),
    }),

  // ---- writes (NEVER retried) --------------------------------------------
  //
  // Each of these can cause a real effect: a human decision, a provider
  // request, or a state resolution. The client sends them exactly once.

  approveCase: (caseId: string, body: { reason?: string; expected_action?: string }) =>
    request<DecisionResponse>(`/api/recovery/${encodeURIComponent(caseId)}/approve`, {
      method: 'POST',
      body,
    }),

  rejectCase: (caseId: string, body: { reason?: string; expected_action?: string }) =>
    request<DecisionResponse>(`/api/recovery/${encodeURIComponent(caseId)}/reject`, {
      method: 'POST',
      body,
    }),

  executeCase: (caseId: string) =>
    request<unknown>(`/api/recovery/${encodeURIComponent(caseId)}/execute`, { method: 'POST' }),

  verifyCase: (caseId: string) =>
    request<unknown>(`/api/recovery/${encodeURIComponent(caseId)}/verify`, { method: 'POST' }),

  runBatch: (body: {
    merchant_id?: string;
    statuses?: PaymentStatus[];
    limit?: number;
    execute?: boolean;
  }) => request<BatchRun>('/api/recovery/runs', { method: 'POST', body }),

  runSweep: (body: { min_age_seconds?: number; limit?: number } = {}) =>
    request<SweepRun>('/api/recovery/sweep', { method: 'POST', body }),
};

export type Api = typeof api;
