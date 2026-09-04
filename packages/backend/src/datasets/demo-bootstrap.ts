/**
 * ============================================================================
 * DEMO BOOTSTRAP — idempotent demo-data provisioning for the public demo
 * ============================================================================
 *
 * This exists so a fresh deployment of the PUBLIC DEMO is not an empty
 * dashboard. It composes the pieces that already exist rather than adding a
 * second data path:
 *
 *   generateDataset()   deterministic synthetic payments (seeded PRNG)
 *   persistDataset()    upserts by id — safe to re-run
 *   runBatchRecovery()  the real pipeline: risk -> diagnosis -> policy ->
 *                       recovery cases, approvals, audit events
 *
 * IT NEVER DELETES ANYTHING. It only inserts, and only when the database
 * looks empty.
 *
 * THREE CONDITIONS must all hold or it does nothing at all:
 *   1. config.demo.mode          — this deployment is a declared demo
 *   2. the mock providers        — no real money, no real model spend
 *   3. no payments already exist — an already-populated database is left alone
 *
 * (3) is what makes a Render restart cheap: the second boot sees rows and
 * returns immediately, so nothing is duplicated and no AI/provider call is
 * made. It is a guard against re-doing work, not a lock — a single-instance
 * free-plan deployment is the only shape this targets.
 */
import type { AppConfig } from '../config/index.ts';
import { generateDataset } from './generator.ts';
import { persistDataset } from './persist.ts';
import { listPayments } from '../payments/repository.ts';
import { runBatchRecovery } from '../jobs/batch-recovery.ts';
import { createAIProvider } from '../agents/diagnosis/factory.ts';
import { createRecoveryProvider } from '../payments/factory.ts';

/**
 * How many payments the demo generates.
 *
 * Small on purpose. The free Render instance shares a CPU, and the batch run
 * below analyzes every eligible payment synchronously at boot; a large corpus
 * would delay the first response. This is enough to populate every dashboard
 * panel with a realistic spread.
 */
const DEMO_RECORD_COUNT = 120;

/** Cap on payments analyzed at boot, for the same reason. */
const DEMO_ANALYZE_LIMIT = 40;

/**
 * The logging surface this module needs.
 *
 * Structurally typed rather than importing Fastify's logger, so the CLI can
 * pass a plain console-backed object without the module depending on the HTTP
 * framework. A Fastify logger satisfies this shape as-is.
 */
export interface BootstrapLogger {
  info(payload: Record<string, unknown>, msg: string): void;
  warn(payload: Record<string, unknown>, msg: string): void;
}

export interface DemoBootstrapResult {
  /** Why the bootstrap did nothing, or 'seeded' when it ran. */
  outcome: 'seeded' | 'already_populated' | 'not_demo_mode' | 'not_mock_providers';
  payments?: number;
  casesAnalyzed?: number;
}

/**
 * Ensure the demo database has data. Safe to call on every boot.
 *
 * Never throws: a demo that cannot seed should still serve the API (with an
 * empty dashboard) rather than crash-loop the deployment. The reason is
 * logged instead.
 */
export async function ensureDemoData(
  config: AppConfig,
  log: BootstrapLogger,
): Promise<DemoBootstrapResult> {
  if (!config.demo.mode) return { outcome: 'not_demo_mode' };

  // Belt and braces: config already forbids a non-mock demo without auth, but
  // seeding is what writes fabricated rows, so it re-checks rather than trusts.
  if (config.ai.provider !== 'mock' || config.payments.provider !== 'mock') {
    log.warn(
      { aiProvider: config.ai.provider, paymentProvider: config.payments.provider },
      'demo bootstrap skipped: demo data is only generated for mock providers',
    );
    return { outcome: 'not_mock_providers' };
  }

  const existing = await listPayments({ limit: 1, offset: 0 });
  if (existing.payments.length > 0) {
    log.info({ event: 'demo_bootstrap_skipped' }, 'demo data already present; nothing seeded');
    return { outcome: 'already_populated' };
  }

  log.info({ event: 'demo_bootstrap_started' }, 'seeding demo data');

  const dataset = generateDataset({
    seed: config.dataset.seed,
    recordCount: DEMO_RECORD_COUNT,
    evalSplit: config.dataset.evalSplit,
    avgTransactionValue: config.dataset.avgTransactionValue,
    customerRepeatRate: config.dataset.customerRepeatRate,
  });

  const counts = await persistDataset(dataset);

  /*
   * Run the REAL pipeline so the demo shows genuine output: risk assessment,
   * a mock-provider diagnosis, policy authorization, recovery cases, and the
   * audit trail each of those writes.
   *
   * execute: true is safe here precisely because the providers are mocks —
   * verified twice above. The executor's idempotency key still applies, so a
   * repeat run reports SKIPPED_DUPLICATE rather than acting twice.
   */
  const summary = await runBatchRecovery(
    { limit: DEMO_ANALYZE_LIMIT, execute: true },
    {
      provider: createAIProvider(config),
      recoveryProvider: createRecoveryProvider(config),
      config,
    },
  );

  log.info(
    {
      event: 'demo_bootstrap_completed',
      payments: counts.payments,
      merchants: counts.merchants,
      customers: counts.customers,
      analyzed: summary.analyzed,
      executed: summary.executed,
      recovered: summary.recovered,
    },
    'demo data seeded',
  );

  return { outcome: 'seeded', payments: counts.payments, casesAnalyzed: summary.analyzed };
}
