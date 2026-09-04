import Fastify, { type FastifyInstance, type FastifyError } from 'fastify';
import cors from '@fastify/cors';
import { loadConfig, type AppConfig } from './config/index.ts';
import { registerAuth } from './api/auth.ts';
import { registerRateLimit } from './api/rate-limit.ts';
import { registerHealthRoutes } from './api/health.ts';
import { registerPaymentRoutes } from './api/payments.ts';
import { registerRecoveryRoutes } from './api/recovery.ts';
import { registerAnalyticsRoutes } from './api/analytics.ts';
import type { AIProvider } from './agents/diagnosis/provider.ts';
import type { RecoveryProvider } from './payments/provider.ts';

/**
 * Build the Fastify instance without starting it.
 *
 * Kept separate from index.ts so integration tests can exercise routes via
 * app.inject() with no listening socket.
 */
export interface BuildAppOptions {
  /** Injected in tests so routes can run against a deterministic provider. */
  provider?: AIProvider;
  /** Injected in tests so execution runs against a controllable provider. */
  recoveryProvider?: RecoveryProvider;
  /**
   * Overrides the environment-derived configuration.
   *
   * Exists so authentication tests can build an app with a known token without
   * mutating process.env, which would leak across concurrently running test
   * files. Production (index.ts) passes nothing and reads the environment.
   */
  config?: AppConfig;
}

export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const config = options.config ?? loadConfig();

  const app = Fastify({
    logger: {
      level: config.logLevel,
      // Structured logs, with request headers redacted so an Authorization or
      // cookie header can never be written to disk (PRD section 30).
      redact: {
        paths: [
          'req.headers.authorization',
          'req.headers.cookie',
          'req.headers["x-api-key"]',
          'res.headers["set-cookie"]',
        ],
        censor: '[redacted]',
      },
    },
    // Never echo an unbounded request body back to the client on error.
    bodyLimit: 1_048_576,
  });
  // CORS is registered FIRST, before the rate limiter and the auth hook.
  //
  // A preflight OPTIONS request carries no credentials by definition, so if
  // authentication ran first every cross-origin call would fail at the
  // preflight with a 401 that the browser reports only as an opaque CORS
  // error. Registering cors first lets it answer preflights directly.
  //
  // The origin list is an exact-match allowlist from config (CORS_ORIGINS),
  // never a wildcard: this API is credentialed, and `*` would let any page an
  // operator visits read authenticated responses.
  await app.register(cors, {
    origin: config.corsOrigins.length === 0 ? false : config.corsOrigins,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    // Both accepted credential headers (see api/auth.ts), plus the headers the
    // frontend actually sends. A header absent here is stripped by the browser.
    allowedHeaders: ['Content-Type', 'Accept', 'Authorization', 'x-api-key'],
    // The token travels in a header, not a cookie, so credentialed mode is
    // unnecessary — and enabling it would forbid ever relaxing the origin list.
    credentials: false,
    maxAge: 86_400,
  });

  // Rate limiting BEFORE authentication, so a flood of credential guesses is
  // throttled without each one reaching the token comparison. Both are
  // onRequest hooks and Fastify runs them in registration order.
  await registerRateLimit(app, config);

  // Registered BEFORE any route. An onRequest hook added here applies to every
  // route registered afterwards, so no handler can run for a request that
  // failed authentication.
  await registerAuth(app, config);

  await registerHealthRoutes(app, config);
  await registerPaymentRoutes(app);
  await registerRecoveryRoutes(app, {
    ...(options.provider === undefined ? {} : { provider: options.provider }),
    ...(options.recoveryProvider === undefined
      ? {}
      : { recoveryProvider: options.recoveryProvider }),
  });
  // Batch runs and analytics. Registered after the auth hook like every other
  // route, so both are protected when AUTH_ENABLED=true.
  await registerAnalyticsRoutes(app, {
    ...(options.provider === undefined ? {} : { provider: options.provider }),
    ...(options.recoveryProvider === undefined
      ? {}
      : { recoveryProvider: options.recoveryProvider }),
    config,
  });

  app.setNotFoundHandler((request, reply) => {
    reply.code(404).send({ error: 'not_found', path: request.url });
  });

  app.setErrorHandler((error: FastifyError, request, reply) => {
    request.log.error({ err: error }, 'request failed');
    const statusCode = error.statusCode ?? 500;
    // Internal errors return a generic message; details stay in the logs.
    reply.code(statusCode).send({
      error: statusCode >= 500 ? 'internal_error' : error.code ?? 'request_error',
      message: statusCode >= 500 ? 'An internal error occurred.' : error.message,
    });
  });

  return app;
}
