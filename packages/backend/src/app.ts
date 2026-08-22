import Fastify, { type FastifyInstance, type FastifyError } from 'fastify';
import { loadConfig } from './config/index.ts';
import { registerHealthRoutes } from './api/health.ts';
import { registerPaymentRoutes } from './api/payments.ts';
import { registerRecoveryRoutes } from './api/recovery.ts';
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
}

export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const config = loadConfig();

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

  await registerHealthRoutes(app);
  await registerPaymentRoutes(app);
  await registerRecoveryRoutes(app, {
    ...(options.provider === undefined ? {} : { provider: options.provider }),
    ...(options.recoveryProvider === undefined
      ? {}
      : { recoveryProvider: options.recoveryProvider }),
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
