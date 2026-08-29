import { pathToFileURL } from 'node:url';
import { loadConfig } from '../config/index.ts';
import { createRecoveryProvider } from '../payments/factory.ts';
import { closePool } from '../db/pool.ts';
import { sweepStrandedActions } from '../recovery/sweep-service.ts';

/**
 * Explicit entrypoint for the stranded-action sweeper.
 *
 * Deliberately a MANUAL command rather than an in-process timer. A background
 * interval would start resolving ambiguous financial state as a side effect of
 * the server being up; an operator running this after an incident is a
 * decision, which is the right shape for something that settles money
 * questions. A scheduler (cron, systemd timer, k8s CronJob) can call it if a
 * deployment wants it periodic — no queue or extra dependency required.
 *
 * Usage:
 *   node --experimental-strip-types src/jobs/sweep-cli.ts [--min-age=120] [--limit=100]
 */

function parseFlag(argv: string[], name: string): number | undefined {
  const prefix = `--${name}=`;
  const raw = argv.find((arg) => arg.startsWith(prefix));
  if (raw === undefined) return undefined;
  const value = Number(raw.slice(prefix.length));
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`--${name} must be a non-negative integer`);
  }
  return value;
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const config = loadConfig();
  // Constructed from config, so a live Razorpay key still fails closed here.
  const provider = createRecoveryProvider(config);

  const minAge = parseFlag(argv, 'min-age');
  const limit = parseFlag(argv, 'limit');

  const summary = await sweepStrandedActions(
    {
      ...(minAge === undefined ? {} : { minAgeSeconds: minAge }),
      ...(limit === undefined ? {} : { limit }),
    },
    { provider },
  );

  // Plain, credential-free reporting. Every message is already scrubbed.
  process.stdout.write(
    [
      'RecoverAI stranded-action sweep',
      '-------------------------------',
      `provider            ${provider.name}`,
      `stranded found      ${summary.found}`,
      `resolved SUCCESS    ${summary.resolvedSuccess}`,
      `resolved FAILED     ${summary.resolvedFailed}`,
      `still UNCONFIRMED   ${summary.stillUnconfirmed}`,
      `already resolved    ${summary.alreadyResolved}`,
      `errors              ${summary.failed}`,
      '',
    ].join('\n'),
  );

  for (const item of summary.items) {
    process.stdout.write(
      `  ${item.actionId}  ${item.strandedIn} -> ${item.executionStatus ?? '-'}  ` +
        `(observed ${item.observedState ?? '-'})  ${item.outcome}\n`,
    );
  }

  // Non-zero only on an unexpected error, so a scheduler can alert on it.
  // Actions that remain UNCONFIRMED are an expected, safe outcome — not a
  // failure — and must not page anyone.
  return summary.failed > 0 ? 1 : 0;
}

// Windows-safe entrypoint check: import.meta.url is a file:// URL and
// process.argv[1] is a native path, so they are compared through pathToFileURL.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const code = await main();
  await closePool();
  process.exit(code);
}
