/**
 * Dataset CLI — `npm run seed [-- options]`
 *
 *   --seed=42          PRNG seed (default: DATASET_SEED)
 *   --count=1000       number of payment records
 *   --eval-split=0.3   fraction held out for evaluation
 *   --out=path.json    write the dataset to a file
 *   --db               persist the dataset into PostgreSQL
 *   --summary-only     print the summary and exit without writing anything
 *
 * With no --out and no --db, it prints the summary only. Writing to the
 * database is opt-in so an accidental run cannot clobber existing data.
 *
 * THIS GENERATES SYNTHETIC DEVELOPMENT DATA. It is not a production tool. A
 * production database must contain real payments ingested through the API, so
 * `--db` REFUSES TO RUN when NODE_ENV=production: a seeded production
 * deployment would show operators fabricated recovery cases, fabricated
 * executions, and fabricated verified outcomes, and nothing in the product
 * would distinguish them from real ones.
 */
import { writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { loadConfig } from '../config/index.ts';
import { generateDataset, summariseDataset } from './generator.ts';
import { persistDataset } from './persist.ts';
import { closePool } from '../db/pool.ts';
import type { SyntheticDataset } from '../shared/types.ts';

interface CliArgs {
  seed: number | undefined;
  count: number | undefined;
  evalSplit: number | undefined;
  out: string | undefined;
  db: boolean;
  summaryOnly: boolean;
}

function parseArgs(argv: readonly string[]): CliArgs {
  const args: CliArgs = {
    seed: undefined,
    count: undefined,
    evalSplit: undefined,
    out: undefined,
    db: false,
    summaryOnly: false,
  };

  for (const arg of argv) {
    if (arg === '--db') args.db = true;
    else if (arg === '--summary-only') args.summaryOnly = true;
    else if (arg.startsWith('--seed=')) args.seed = Number(arg.slice(7));
    else if (arg.startsWith('--count=')) args.count = Number(arg.slice(8));
    else if (arg.startsWith('--eval-split=')) args.evalSplit = Number(arg.slice(13));
    else if (arg.startsWith('--out=')) args.out = arg.slice(6);
    else throw new Error(`unrecognised argument: ${arg}`);
  }

  if (args.seed !== undefined && !Number.isInteger(args.seed)) {
    throw new Error('--seed must be an integer');
  }
  if (args.count !== undefined && (!Number.isInteger(args.count) || args.count < 1)) {
    throw new Error('--count must be a positive integer');
  }
  if (args.evalSplit !== undefined && !(args.evalSplit > 0 && args.evalSplit < 1)) {
    throw new Error('--eval-split must be between 0 and 1 (exclusive)');
  }
  return args;
}

/** Serialise with Dates as ISO strings, stable key order, 2-space indent. */
function serialise(dataset: SyntheticDataset): string {
  return `${JSON.stringify(dataset, null, 2)}\n`;
}

function formatMinor(minor: number): string {
  return `INR ${(minor / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;
}

async function main(): Promise<void> {
  const config = loadConfig();
  const args = parseArgs(process.argv.slice(2));

  const dataset = generateDataset({
    seed: args.seed ?? config.dataset.seed,
    recordCount: args.count ?? config.dataset.recordCount,
    evalSplit: args.evalSplit ?? config.dataset.evalSplit,
    avgTransactionValue: config.dataset.avgTransactionValue,
    customerRepeatRate: config.dataset.customerRepeatRate,
  });

  const summary = summariseDataset(dataset);

  console.log('RecoverAI synthetic dataset');
  console.log('---------------------------');
  console.log(`seed                 ${summary.seed}`);
  console.log(`records              ${summary.totalRecords} (dev ${summary.devRecords} / eval ${summary.evalRecords})`);
  console.log(`merchants            ${summary.merchants}`);
  console.log(`customers            ${summary.customers}`);
  console.log(`revenue at risk      ${formatMinor(summary.revenueAtRiskMinor)}`);
  console.log(`  of which recoverable ${formatMinor(summary.recoverableRevenueMinor)}`);
  console.log('\nby payment status');
  for (const [status, count] of Object.entries(summary.byStatus).sort()) {
    console.log(`  ${status.padEnd(22)} ${count}`);
  }
  console.log('\nby ground-truth classification (non-captured only)');
  for (const [cls, count] of Object.entries(summary.byClassification).sort()) {
    console.log(`  ${cls.padEnd(26)} ${count}`);
  }
  console.log('\nby ideal action');
  for (const [action, count] of Object.entries(summary.byIdealAction).sort()) {
    console.log(`  ${action.padEnd(22)} ${count}`);
  }

  if (args.summaryOnly) return;

  if (args.out !== undefined) {
    await mkdir(dirname(args.out), { recursive: true });
    await writeFile(args.out, serialise(dataset), 'utf8');
    console.log(`\nwrote ${args.out}`);
  }

  if (args.db) {
    /*
     * Refuse to seed a production database. Checked here rather than in
     * persistDataset() so the failure names the CLI the operator actually
     * ran, and so the library stays usable by the test suites, which set
     * their own NODE_ENV.
     */
    if (config.nodeEnv === 'production' && !config.demo.mode) {
      throw new Error(
        'refusing to seed a production database. This command writes SYNTHETIC payments, ' +
          'merchants, and ground-truth rows, which would be indistinguishable from real ' +
          'data in the dashboard. Unset NODE_ENV=production to seed a development database, ' +
          'or set DEMO_MODE=true if this deployment is a public demo whose data is ' +
          'labelled as simulated in the UI.',
      );
    }
    const counts = await persistDataset(dataset);
    console.log(
      `\npersisted to database: ${counts.merchants} merchants, ` +
        `${counts.customers} customers, ${counts.payments} payments, ` +
        `${counts.groundTruth} ground-truth rows`,
    );
  }

  if (args.out === undefined && !args.db) {
    console.log('\n(no --out or --db given; nothing was written)');
  }
}

try {
  await main();
} catch (error) {
  console.error(`seed failed: ${(error as Error).message}`);
  process.exitCode = 1;
} finally {
  await closePool();
}
