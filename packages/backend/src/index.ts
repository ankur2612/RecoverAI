import { buildApp } from './app.ts';
import { loadConfig } from './config/index.ts';
import { closePool } from './db/pool.ts';

const config = loadConfig();
const app = await buildApp();

/** Drain in-flight requests and close the pool before exiting. */
async function shutdown(signal: string): Promise<void> {
  app.log.info({ signal }, 'shutting down');
  try {
    await app.close();
    await closePool();
    process.exit(0);
  } catch (error) {
    app.log.error({ err: error }, 'shutdown failed');
    process.exit(1);
  }
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => void shutdown(signal));
}

try {
  await app.listen({ port: config.port, host: '0.0.0.0' });
} catch (error) {
  app.log.error({ err: error }, 'failed to start');
  process.exit(1);
}
