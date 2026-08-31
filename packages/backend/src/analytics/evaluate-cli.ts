import { pathToFileURL } from 'node:url';
import { loadConfig } from '../config/index.ts';
import { generateDataset } from '../datasets/generator.ts';
import { createAIProvider } from '../agents/diagnosis/factory.ts';
import { MockAIProvider } from '../agents/diagnosis/providers/mock.ts';
import type { AIProvider } from '../agents/diagnosis/provider.ts';
import { evaluateDiagnosis, failures, type EvaluationReport } from './evaluate.ts';
import type { ClassificationReport } from './metrics.ts';

/**
 * Evaluation entrypoint.
 *
 *   npm run evaluate -- [--seed=42] [--count=1000] [--split=eval|dev|all]
 *                       [--provider=mock|gemini] [--limit=N] [--json]
 *                       [--errors[=N]]
 *
 * DEFAULTS TO MockAI AND NEVER CONTACTS A NETWORK unless `--provider=gemini`
 * is passed explicitly. There is no environment variable that silently
 * switches it: a live evaluation costs money and quota, so it must be typed.
 *
 * The report is reproducible from its arguments alone — same seed, same split,
 * same provider gives byte-identical output for MockAI. Nothing here reads the
 * clock or the dataset from a database.
 */

interface CliOptions {
  seed: number | undefined;
  count: number | undefined;
  split: 'dev' | 'eval' | 'all';
  provider: 'mock' | 'gemini';
  limit: number | undefined;
  json: boolean;
  errors: number;
}

function parseArgs(argv: string[]): CliOptions {
  const flag = (name: string): string | undefined => {
    const prefix = `--${name}=`;
    const found = argv.find((a) => a.startsWith(prefix));
    return found === undefined ? undefined : found.slice(prefix.length);
  };
  const intFlag = (name: string): number | undefined => {
    const raw = flag(name);
    if (raw === undefined) return undefined;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 0) {
      throw new Error(`--${name} must be a non-negative integer`);
    }
    return value;
  };

  const split = flag('split') ?? 'eval';
  if (split !== 'dev' && split !== 'eval' && split !== 'all') {
    throw new Error('--split must be one of dev | eval | all');
  }

  const provider = flag('provider') ?? 'mock';
  if (provider !== 'mock' && provider !== 'gemini') {
    throw new Error('--provider must be one of mock | gemini');
  }

  // `--errors` alone means "show the default number"; `--errors=N` sets it.
  const errorsRaw = argv.find((a) => a === '--errors' || a.startsWith('--errors='));
  const errors =
    errorsRaw === undefined ? 0 : errorsRaw === '--errors' ? 20 : (intFlag('errors') ?? 20);

  return {
    seed: intFlag('seed'),
    count: intFlag('count'),
    split,
    provider,
    limit: intFlag('limit'),
    json: argv.includes('--json'),
    errors,
  };
}

function bar(label: string, value: number): string {
  // A 20-cell bar makes a table of rates scannable without a chart.
  const filled = Math.round(Math.max(0, Math.min(1, value)) * 20);
  return `${label.padEnd(16)} ${value.toFixed(4)}  ${'#'.repeat(filled)}${'.'.repeat(20 - filled)}`;
}

function renderClassTable(report: ClassificationReport): string[] {
  const lines: string[] = [
    '  class                       support   precision   recall     F1',
    '  ' + '-'.repeat(62),
  ];
  for (const c of report.perClass) {
    // Classes with no support AND no predictions carry no information.
    if (c.support === 0 && c.falsePositives === 0) continue;
    lines.push(
      `  ${c.label.padEnd(26)} ${String(c.support).padStart(6)}   ` +
        `${c.precision.toFixed(4)}    ${c.recall.toFixed(4)}   ${c.f1.toFixed(4)}`,
    );
  }
  return lines;
}

/** Human-readable report. Deterministic: no clock, no locale formatting. */
export function renderReport(report: EvaluationReport, errorLimit: number): string {
  const out: string[] = [
    'RecoverAI evaluation',
    '════════════════════',
    `dataset seed        ${report.datasetSeed}`,
    `dataset size        ${report.datasetSize}`,
    `split               ${report.split}`,
    `scored              ${report.evaluated}`,
    `errored             ${report.errored}`,
    `provider            ${report.provider} (${report.model})`,
    '',
    'AI DIAGNOSIS QUALITY — whole scored population',
    '─'.repeat(54),
    bar('  accuracy', report.classification.accuracy),
    bar('  macro F1', report.classification.macroF1),
    bar('  weighted F1', report.classification.weightedF1),
    '',
    'Classification, per class:',
    ...renderClassTable(report.classification),
    '',
    'Recovery action:',
    bar('  accuracy', report.action.accuracy),
    bar('  macro F1', report.action.macroF1),
    ...renderClassTable(report.action),
    '',
    'Recoverability (binary, threshold ' + report.recoverableThreshold + '):',
    bar('  accuracy', report.recoverability.accuracy),
    bar('  precision', report.recoverability.precision),
    bar('  recall', report.recoverability.recall),
    bar('  F1', report.recoverability.f1),
    `  tp=${report.recoverability.truePositives} fp=${report.recoverability.falsePositives} ` +
      `fn=${report.recoverability.falseNegatives} tn=${report.recoverability.trueNegatives}`,
    '',
    `AT-RISK PAYMENTS ONLY (${report.atRiskOnly.evaluated} records)`,
    '─'.repeat(54),
    '  The population above is dominated by already-captured payments, where',
    '  the correct answer is "do nothing". These figures exclude them.',
    '',
    bar('  classification', report.atRiskOnly.classification.accuracy),
    bar('  action accuracy', report.atRiskOnly.action.accuracy),
    bar('  action macro F1', report.atRiskOnly.action.macroF1),
    '',
  ];

  if (report.policy !== null) {
    out.push(
      'POLICY BEHAVIOUR — not a correctness score',
      '─'.repeat(54),
      '  The deterministic engine has no ground truth to be right against.',
      '  These counts describe what it did, not how well it did it.',
      '',
      `  assessed at risk        ${report.policy.allowed}`,
      `  flagged for review      ${report.policy.requiresApproval}`,
      `  not at risk             ${report.policy.blocked}`,
      '',
    );
  }

  out.push(
    'WHAT THIS REPORT DOES NOT SAY',
    '─'.repeat(54),
    '  These are LABEL-ACCURACY metrics against synthetic ground truth.',
    '  They are not recovered revenue. Recovered revenue has exactly one',
    '  definition in RecoverAI — a VERIFIED provider outcome — and is',
    '  reported by GET /api/analytics/recovery, never here.',
    '',
  );

  if (errorLimit > 0) {
    const wrong = failures(report).slice(0, errorLimit);
    out.push(`ERROR REVIEW (first ${wrong.length})`, '─'.repeat(54));
    for (const c of wrong) {
      out.push(
        `  ${c.paymentId}  ${c.error === null ? '' : `[error: ${c.error}] `}` +
          `class ${c.expectedClassification} -> ${c.predictedClassification}` +
          `${c.classificationCorrect ? ' ok' : ' MISS'}`,
      );
      out.push(
        `    action ${c.expectedAction} -> ${c.predictedAction}` +
          `${c.actionCorrect ? ' ok' : ' MISS'}   confidence ${c.confidence}`,
      );
      if (c.reason !== '') out.push(`    reason: ${c.reason.slice(0, 100)}`);
    }
    out.push('');
  }

  return out.join('\n');
}

/** Build the provider. Only an explicit flag can select a networked one. */
function buildProvider(option: 'mock' | 'gemini'): AIProvider {
  if (option === 'mock') return new MockAIProvider();
  // Goes through the existing factory, so a missing GEMINI_API_KEY throws
  // rather than silently falling back to the mock.
  return createAIProvider(loadConfig({ ...process.env, AI_PROVIDER: 'gemini' }));
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const options = parseArgs(argv);
  const config = loadConfig();

  const dataset = generateDataset({
    ...config.dataset,
    ...(options.seed === undefined ? {} : { seed: options.seed }),
    ...(options.count === undefined ? {} : { recordCount: options.count }),
  });

  const provider = buildProvider(options.provider);

  const report = await evaluateDiagnosis(
    dataset,
    {
      split: options.split,
      policy: config.policy,
      ...(options.limit === undefined ? {} : { limit: options.limit }),
    },
    { provider },
  );

  process.stdout.write(
    options.json
      ? `${JSON.stringify(report, null, 2)}\n`
      : `${renderReport(report, options.errors)}\n`,
  );

  // Non-zero only when the provider failed on some records, so a scheduler can
  // alert on an outage. A LOW SCORE IS NOT A FAILURE: this command reports
  // model quality, it does not gate on it.
  return report.errored > 0 ? 1 : 0;
}

// Windows-safe entrypoint check: import.meta.url is a file:// URL while
// process.argv[1] is a native path.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(await main());
}
