import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AppConfig } from '../config/index.ts';
import { isPublicPath } from './auth.ts';

/**
 * ============================================================================
 * HTTP RATE LIMITING
 * ============================================================================
 *
 * A fixed-window counter keyed by client IP, applied at the HTTP boundary.
 *
 * WHY THIS EXISTS
 *
 * Authentication is a single shared token compared in constant time. Constant
 * time stops an attacker learning the token from response timing; it does
 * nothing about how MANY guesses they may make. Without a limit, an attacker
 * gets unlimited attempts at network speed. This bounds that.
 *
 * WHY IT IS HAND-ROLLED RATHER THAN A PLUGIN
 *
 * @fastify/rate-limit is the usual answer and would be a fine choice. It is
 * not a dependency of this repository, and adding one to obtain ~60 lines of
 * counting is a poor trade in a codebase whose dependency list is
 * deliberately three packages long. The limitation of this implementation is
 * stated plainly below rather than hidden.
 *
 * WHAT THIS IS NOT
 *
 *   - NOT distributed. Counters live in this process's memory, so N replicas
 *     permit N times the limit. A real deployment should put a limiter in the
 *     reverse proxy or gateway; this is defence in depth, not the only line.
 *   - NOT account lockout. A blocked caller is throttled, never disabled.
 *   - NOT authorization. It cannot permit anything; it only refuses.
 *
 * It has no opinion on policy, execution, or recovery semantics, and it
 * imports none of them.
 */

/** One caller's counter for the current window. */
interface WindowState {
  count: number;
  /** Epoch millis at which this window resets. */
  resetAt: number;
}

/**
 * Guard against unbounded memory growth from spoofed source addresses.
 *
 * When the map exceeds this, expired entries are swept. A limiter that can be
 * turned into a memory-exhaustion vector is worse than no limiter.
 */
const MAX_TRACKED_CLIENTS = 10_000;

export interface RateLimitOptions {
  /** Maximum requests per window, per client. */
  max: number;
  /** Window length in milliseconds. */
  windowMs: number;
  /** Injected in tests so windows can be advanced without waiting. */
  now?: () => number;
}

export interface RateLimitDecision {
  allowed: boolean;
  /** Requests still permitted in this window. */
  remaining: number;
  /** Seconds until the window resets. Sent as Retry-After when blocked. */
  retryAfterSeconds: number;
  limit: number;
}

/**
 * A pure-ish counter, separated from Fastify so it is testable directly.
 *
 * Fixed-window rather than sliding: a sliding window needs per-request
 * timestamps, which is more memory and more code for a property this does not
 * need. The known cost is burstiness at a window boundary — up to 2x the
 * limit across two adjacent windows — which is acceptable for a guard whose
 * job is bounding brute force, not shaping traffic.
 */
export class RateLimiter {
  readonly #max: number;
  readonly #windowMs: number;
  readonly #now: () => number;
  readonly #clients = new Map<string, WindowState>();

  constructor(options: RateLimitOptions) {
    this.#max = Math.max(1, options.max);
    this.#windowMs = Math.max(1, options.windowMs);
    this.#now = options.now ?? Date.now;
  }

  /** Count one request from `key` and decide whether it may proceed. */
  consume(key: string): RateLimitDecision {
    const now = this.#now();
    const existing = this.#clients.get(key);

    if (existing === undefined || now >= existing.resetAt) {
      if (this.#clients.size >= MAX_TRACKED_CLIENTS) this.#sweep(now);
      const state: WindowState = { count: 1, resetAt: now + this.#windowMs };
      this.#clients.set(key, state);
      return {
        allowed: true,
        remaining: this.#max - 1,
        retryAfterSeconds: Math.ceil(this.#windowMs / 1000),
        limit: this.#max,
      };
    }

    existing.count += 1;
    const retryAfterSeconds = Math.max(1, Math.ceil((existing.resetAt - now) / 1000));

    return {
      allowed: existing.count <= this.#max,
      remaining: Math.max(0, this.#max - existing.count),
      retryAfterSeconds,
      limit: this.#max,
    };
  }

  /** Drop windows that have already expired. */
  #sweep(now: number): void {
    for (const [key, state] of this.#clients) {
      if (now >= state.resetAt) this.#clients.delete(key);
    }
  }

  /** Tracked client count. For tests and diagnostics; never a secret. */
  get size(): number {
    return this.#clients.size;
  }
}

/**
 * Register rate limiting as an `onRequest` hook.
 *
 * Ordering matters and is deliberate: this runs BEFORE authentication, so a
 * flood of unauthenticated guesses is throttled without each one reaching the
 * credential comparison. Both are `onRequest` hooks, and Fastify runs them in
 * registration order.
 *
 * The health endpoint is deliberately EXEMPT. A readiness probe polls on a
 * fixed interval, and throttling it would make an otherwise healthy service
 * look down — turning a protective measure into an outage. It exposes no data
 * and performs one cheap query.
 */
export async function registerRateLimit(
  app: FastifyInstance,
  config: AppConfig,
): Promise<void> {
  if (!config.rateLimit.enabled) {
    app.log.warn({ rateLimitEnabled: false }, 'HTTP rate limiting is DISABLED');
    return;
  }

  const limiter = new RateLimiter({
    max: config.rateLimit.max,
    windowMs: config.rateLimit.windowMs,
  });

  app.log.info(
    { rateLimitEnabled: true, max: config.rateLimit.max, windowMs: config.rateLimit.windowMs },
    'HTTP rate limiting is enabled',
  );

  app.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    // Readiness probes must never be throttled.
    if (isPublicPath(request.url)) return;

    // Keyed by IP. With a shared token there is no per-user identity to key
    // on, and keying on the TOKEN would mean one leaked credential exhausts
    // every legitimate caller's budget.
    const key = request.ip;
    const decision = limiter.consume(key);

    reply.header('X-RateLimit-Limit', String(decision.limit));
    reply.header('X-RateLimit-Remaining', String(decision.remaining));

    if (decision.allowed) return;

    // The log records the route and the reason, never a credential. `request.ip`
    // is client metadata, not a secret, and is already present in Fastify's
    // own request logs.
    request.log.warn(
      { reason: 'rate_limited', method: request.method, path: request.url },
      'request rejected by the rate limiter',
    );

    return reply
      .code(429)
      .header('Retry-After', String(decision.retryAfterSeconds))
      .send({
        error: 'rate_limited',
        message: 'Too many requests. Please retry later.',
      });
  });
}
