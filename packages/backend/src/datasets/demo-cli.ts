/**
 * Demo bootstrap CLI — `npm run demo:ensure` (compiled: dist/datasets/demo-cli.js).
 *
 * A SEPARATE ENTRYPOINT ON PURPOSE.
 *
 * The application's own startup (src/index.ts) must never be able to write
 * synthetic rows — a deployment-config test asserts that index.ts does not so
 * much as reference `datasets/`, precisely so no real production boot can
 * populate itself with fabricated payments. Putting the bootstrap in its own
 * process keeps that guarantee intact while still letting a demo deployment
 * run it as an explicit, separate step in its start command.
 *
 * Exits 0 in every non-error case, including when it deliberately does
 * nothing, so it can be chained ahead of the server with `&&` without ever
 * blocking a normal deployment from starting.
 */
import { loadConfig } from '../config/index.ts';
import { closePool } from '../db/pool.ts';
import { ensureDemoData } from './demo-bootstrap.ts';

/** Minimal logger with the pino-shaped surface ensureDemoData expects. */
function line(level: string, payload: Record<string, unknown>, msg: string): void {
  console.log(JSON.stringify({ level, ...payload, msg }));
}

const log = {
  info: (payload: Record<string, unknown>, msg: string) => line('info', payload, msg),
  warn: (payload: Record<string, unknown>, msg: string) => line('warn', payload, msg),
  error: (payload: Record<string, unknown>, msg: string) => line('error', payload, msg),
};

try {
  const config = loadConfig();
  const result = await ensureDemoData(config, log);
  console.log(`demo bootstrap: ${result.outcome}`);
} catch (error) {
  /*
   * Never fail the deployment. An empty demo dashboard is a far better
   * outcome than a service that will not start, so this reports and exits 0.
   */
  console.error(`demo bootstrap failed (continuing): ${(error as Error).message}`);
} finally {
  await closePool();
}
