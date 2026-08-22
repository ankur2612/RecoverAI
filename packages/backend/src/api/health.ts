import type { FastifyInstance } from 'fastify';
import { loadConfig, redactedConfig } from '../config/index.ts';
import { getPool } from '../db/pool.ts';

/**
 * GET /api/health
 *
 * Reports process liveness and database reachability. The config block is
 * passed through redactedConfig() so no secret ever reaches this response.
 */
export async function registerHealthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/health', async (_request, reply) => {
    const config = loadConfig();

    let database: { reachable: boolean; error?: string };
    try {
      await getPool().query('SELECT 1');
      database = { reachable: true };
    } catch (error) {
      // Surface that the DB is down without leaking the connection string.
      database = { reachable: false, error: (error as Error).message.slice(0, 200) };
    }

    const status = database.reachable ? 'ok' : 'degraded';
    return reply.code(database.reachable ? 200 : 503).send({
      status,
      service: 'recoverai-backend',
      version: '0.1.0',
      timestamp: new Date().toISOString(),
      database,
      config: redactedConfig(config),
    });
  });
}
