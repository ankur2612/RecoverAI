import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { timingSafeEqual } from 'node:crypto';
import type { AppConfig } from '../config/index.ts';

/**
 * ============================================================================
 * HTTP AUTHENTICATION
 * ============================================================================
 *
 * AUTHENTICATION IS NOT AUTHORIZATION.
 *
 * This module answers exactly one question: "may this caller reach the API?"
 * It has no opinion on whether any recovery action is permitted. That remains
 * the exclusive job of the deterministic policy engine, which runs downstream
 * and is unaware this module exists.
 *
 * A valid token therefore buys a caller the right to ASK. It never:
 *   - satisfies a retry budget
 *   - grants a human approval
 *   - bypasses idempotency
 *   - authorizes an action the policy engine refused
 *
 * The boundary is enforced by direction of dependency: this file imports the
 * config type and Fastify, and nothing in the domain imports this file.
 * Architecture tests assert that in both directions.
 */

/** Paths reachable without credentials, even when authentication is on. */
const PUBLIC_PATHS: readonly string[] = ['/api/health'];

/**
 * The reason a request was rejected.
 *
 * Deliberately coarse. The client is told only that authentication failed —
 * never whether a token was close, well-formed, or the wrong length, since
 * each of those is a probe an attacker can use to narrow a search.
 */
export type AuthFailure =
  | 'missing_credentials'
  | 'malformed_credentials'
  | 'conflicting_credentials'
  | 'invalid_credentials';

export interface AuthOutcome {
  ok: boolean;
  failure?: AuthFailure;
}

/**
 * Constant-time credential comparison.
 *
 * `timingSafeEqual` throws on a length mismatch, and its own length check is
 * not constant-time, so lengths are compared first and an unequal length short
 * -circuits. That leaks the LENGTH of the expected token, which is not secret
 * in the way its contents are, and is unavoidable with a raw byte compare.
 *
 * A naive `a === b` would leak far more: V8 short-circuits on the first
 * differing byte, letting a caller recover the token one character at a time.
 */
export function timingSafeCompare(supplied: string, expected: string): boolean {
  const a = Buffer.from(supplied, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Extract the presented credential from the two accepted header forms.
 *
 * Both headers present is REJECTED rather than resolved by precedence. A
 * request carrying two different credentials is ambiguous about who is
 * calling, and silently picking one would let a caller smuggle a second
 * identity past anything that logs only the other header.
 *
 * Two headers carrying the SAME value is not ambiguous, so it is allowed — a
 * proxy that copies one header into the other is a real deployment shape.
 */
export function extractCredential(headers: {
  authorization?: string | undefined;
  apiKey?: string | undefined;
}): { credential: string } | { failure: AuthFailure } {
  const rawAuth = headers.authorization?.trim();
  const rawKey = headers.apiKey?.trim();

  const hasAuth = rawAuth !== undefined && rawAuth !== '';
  const hasKey = rawKey !== undefined && rawKey !== '';

  if (!hasAuth && !hasKey) return { failure: 'missing_credentials' };

  let bearerToken: string | undefined;
  if (hasAuth) {
    // Scheme must be exactly "Bearer" (case-insensitive per RFC 7235) followed
    // by a single space and a non-empty token. `Basic`, a bare token with no
    // scheme, and `Bearer` with nothing after it are all malformed.
    const match = /^Bearer[ ]+(.+)$/i.exec(rawAuth);
    if (match === null) return { failure: 'malformed_credentials' };
    const token = match[1]!.trim();
    if (token === '') return { failure: 'malformed_credentials' };
    bearerToken = token;
  }

  if (bearerToken !== undefined && hasKey) {
    // Both present: only identical values are unambiguous.
    if (bearerToken !== rawKey) return { failure: 'conflicting_credentials' };
    return { credential: bearerToken };
  }

  return { credential: bearerToken ?? rawKey! };
}

/**
 * Decide a single request.
 *
 * Pure: no I/O, no clock, no `process.env`. Everything it needs is passed in,
 * so its behaviour is fully reproducible from its arguments.
 */
export function authenticateRequest(options: {
  path: string;
  expectedToken: string | undefined;
  authorization?: string | undefined;
  apiKey?: string | undefined;
}): AuthOutcome {
  if (isPublicPath(options.path)) return { ok: true };

  // Fail closed. loadConfig() already refuses to build an enabled-but-
  // tokenless config, so reaching here means something bypassed it — deny
  // rather than accept everything.
  if (options.expectedToken === undefined || options.expectedToken === '') {
    return { ok: false, failure: 'invalid_credentials' };
  }

  const extracted = extractCredential({
    authorization: options.authorization,
    apiKey: options.apiKey,
  });
  if ('failure' in extracted) return { ok: false, failure: extracted.failure };

  if (!timingSafeCompare(extracted.credential, options.expectedToken)) {
    return { ok: false, failure: 'invalid_credentials' };
  }
  return { ok: true };
}

/** Health checks must work before an operator has credentials in hand. */
export function isPublicPath(path: string): boolean {
  // Compare the path only; a query string must not turn a protected route
  // into a public one (or vice versa).
  const withoutQuery = path.split('?')[0] ?? path;
  // Tolerate a trailing slash so /api/health/ is not accidentally protected
  // while /api/health is not.
  const normalised =
    withoutQuery.length > 1 && withoutQuery.endsWith('/')
      ? withoutQuery.slice(0, -1)
      : withoutQuery;
  return PUBLIC_PATHS.includes(normalised);
}

/**
 * Register authentication as an `onRequest` hook.
 *
 * `onRequest` is the earliest hook Fastify offers — it runs before body
 * parsing, before validation, and before any route handler. An unauthenticated
 * request is therefore rejected before it can reach a repository, a provider,
 * or the executor.
 */
export async function registerAuth(app: FastifyInstance, config: AppConfig): Promise<void> {
  if (!config.auth.enabled) {
    // Open posture. Announced at startup so an operator can never be unsure
    // which mode is running. No token is referenced here at all.
    app.log.warn(
      { authEnabled: false },
      'API authentication is DISABLED; every route is publicly reachable',
    );
    return;
  }

  const expectedToken = config.auth.token;
  app.log.info({ authEnabled: true }, 'API authentication is enabled');

  app.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    // A repeated header arrives as an array. That is two credentials in one
    // header — as ambiguous as the two-header case — so it is refused outright
    // rather than reduced to one of its values.
    const rawApiKey = request.headers['x-api-key'];
    const outcome: AuthOutcome = Array.isArray(rawApiKey)
      ? { ok: false, failure: 'conflicting_credentials' }
      : authenticateRequest({
          path: request.url,
          expectedToken,
          authorization: request.headers.authorization,
          apiKey: rawApiKey,
        });

    if (outcome.ok) return;

    // Log the failure WITHOUT the supplied credential. The reason code and the
    // route are enough to diagnose a misconfigured client; echoing the token
    // would write attacker-supplied secrets into the log.
    request.log.warn(
      { reason: outcome.failure, method: request.method, path: request.url },
      'request rejected by authentication',
    );

    // A single generic message for every failure mode. Telling a caller that
    // their header was "malformed" versus "invalid" distinguishes a shape
    // problem from a value problem, which is a probing signal.
    //
    // The reply NEVER contains the supplied credential or the expected one.
    return reply
      .code(401)
      .header('WWW-Authenticate', 'Bearer realm="recoverai"')
      .send({ error: 'unauthorized', message: 'Valid API credentials are required.' });
  });
}
