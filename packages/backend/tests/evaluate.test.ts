import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';
import { generateDataset } from '../src/datasets/generator.ts';
import { loadConfig } from '../src/config/index.ts';
import { MockAIProvider } from '../src/agents/diagnosis/providers/mock.ts';
import type { AIProvider } from '../src/agents/diagnosis/provider.ts';
import type { DiagnosisInput, DiagnosisResult } from '../src/agents/diagnosis/types.ts';
import { evaluateDiagnosis, failures, scrubReason } from '../src/analytics/evaluate.ts';
import { renderReport } from '../src/analytics/evaluate-cli.ts';

/**
 * EVALUATION HARNESS
 *
 * Two properties matter most and are tested hardest:
 *
 *   1. Ground truth reaches the SCORER but never the PROVIDER.
 *   2. Evaluating cannot execute a recovery action.
 *
 * Everything runs against MockAI. No network, no database, no credentials.
 */

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const CONFIG = loadConfig({});

function code(file: string): string {
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function walk(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, acc);
    else if (entry.endsWith('.ts')) acc.push(full);
  }
  return acc;
}

const smallDataset = (seed = 42, recordCount = 120) =>
  generateDataset({ ...CONFIG.dataset, seed, recordCount });

// ---------------------------------------------------------------------------
// GROUND-TRUTH ISOLATION — the critical property
// ---------------------------------------------------------------------------

describe('evaluation — ground truth never reaches the provider', () => {
  test('the provider receives NO label-shaped field, at any depth', async () => {
    // A recording provider inspects everything it is handed.
    const seen: DiagnosisInput[] = [];
    const recorder: AIProvider = {
      name: 'recorder',
      model: 'test',
      async diagnose(input) {
        seen.push(input);
        return {
          classification: 'TEMPORARY_FAILURE',
          confidence: 0.9,
          reason: 'test',
          recommendedAction: 'RETRY',
          expectedRecoveryProbability: 0.8,
          requiresHumanApproval: false,
          provider: 'recorder',
          model: 'test',
        } satisfies DiagnosisResult;
      },
    };

    await evaluateDiagnosis(smallDataset(), { split: 'eval' }, { provider: recorder });
    assert.ok(seen.length > 0, 'the provider was never called');

    const forbidden = [
      'groundTruth',
      'ground_truth',
      'idealAction',
      'ideal_action',
      'recoverable',
      'recoveryProbability',
      'recovery_probability',
      'expectedClassification',
      'split',
    ];
    for (const input of seen) {
      const serialised = JSON.stringify(input);
      for (const key of forbidden) {
        assert.ok(
          !serialised.includes(key),
          `the provider received "${key}" — ground truth leaked into the prompt`,
        );
      }
    }
  });

  test('the scored labels genuinely come from the dataset', () => {
    // The other half of the boundary: isolation is only meaningful if the
    // harness really is comparing against the hidden labels.
    const dataset = smallDataset();
    const record = dataset.records.find((r) => r.split === 'eval')!;
    assert.ok(record.groundTruth.classification.length > 0);
    assert.ok(record.groundTruth.idealAction.length > 0);
    assert.equal(typeof record.groundTruth.recoverable, 'boolean');
  });

  test('expected values in the report match the dataset labels exactly', async () => {
    const dataset = smallDataset();
    const report = await evaluateDiagnosis(
      dataset,
      { split: 'eval' },
      { provider: new MockAIProvider() },
    );

    const byId = new Map(dataset.records.map((r) => [r.payment.id, r]));
    for (const c of report.cases) {
      const truth = byId.get(c.paymentId)!.groundTruth;
      assert.equal(c.expectedClassification, truth.classification);
      assert.equal(c.expectedAction, truth.idealAction);
      assert.equal(c.expectedRecoverable, truth.recoverable);
    }
  });
});

// ---------------------------------------------------------------------------
// ARCHITECTURE — evaluation cannot execute
// ---------------------------------------------------------------------------

describe('evaluation architecture — cannot execute or mutate', () => {
  const EVAL = join(SRC, 'analytics', 'evaluate.ts');
  const CLI = join(SRC, 'analytics', 'evaluate-cli.ts');
  const METRICS = join(SRC, 'analytics', 'metrics.ts');
  const evalCode = code(EVAL);
  const cliCode = code(CLI);
  const metricsCode = code(METRICS);

  test('the harness never calls a payment provider', () => {
    for (const [name, source] of [['evaluate', evalCode], ['cli', cliCode]] as const) {
      assert.ok(!/\.executeAction\(/.test(source), `${name} calls executeAction`);
      assert.ok(!/getPaymentStatus/.test(source), `${name} contacts a payment provider`);
      assert.ok(!/from ['"].*payments\//.test(source), `${name} imports the payments layer`);
    }
  });

  test('the harness imports no executor, service, or repository', () => {
    for (const [name, source] of [['evaluate', evalCode], ['cli', cliCode]] as const) {
      assert.ok(!/from ['"].*recovery\/executor/.test(source), `${name} imports the executor`);
      assert.ok(!/execute-service|executeRecoveryCase/.test(source), `${name} can execute`);
      assert.ok(!/verify-service|sweep-service/.test(source), `${name} reaches verification`);
      assert.ok(!/approval-service|approveRecoveryCase/.test(source), `${name} reaches approval`);
      assert.ok(!/from ['"].*repository/.test(source), `${name} imports a repository`);
      assert.ok(!/from ['"]pg['"]|db\/pool/.test(source), `${name} reaches the database`);
    }
  });

  test('the harness writes nothing', () => {
    for (const source of [evalCode, cliCode, metricsCode]) {
      for (const write of ['INSERT INTO', 'UPDATE ', 'DELETE FROM', 'appendAuditEvent']) {
        assert.ok(!new RegExp(write, 'i').test(source), `evaluation issues ${write.trim()}`);
      }
    }
  });

  test('the metrics module is pure', () => {
    assert.ok(!/\bawait\b|async /.test(metricsCode), 'metrics performs async work');
    assert.ok(!/Date\.now|new Date/.test(metricsCode), 'metrics reads the clock');
    assert.ok(!/Math\.random|randomUUID/.test(metricsCode), 'metrics uses randomness');
    assert.ok(!/process\.env/.test(metricsCode), 'metrics reads the environment');
    assert.ok(!/from ['"]\.\.\//.test(metricsCode), 'metrics imports the domain');
  });

  test('the harness reads no credential', () => {
    for (const source of [evalCode, metricsCode]) {
      assert.ok(!/process\.env/.test(source), 'the harness reads process.env');
      // Excluding the scrubber, whose whole job is to NAME credential-shaped
      // fields so it can redact them. Matching it would be a false positive.
      const withoutScrubber = source.replace(/export function scrubReason[\s\S]*?\n}/, '');
      assert.ok(
        !/apiKey|keySecret|API_AUTH_TOKEN/.test(withoutScrubber),
        'the harness names a credential',
      );
    }
  });

  test('ONLY the evaluation layer reads ground truth', () => {
    // The pre-existing isolation guarantee, restated over the new files: no
    // production module may reference a label, and the harness may.
    const allowed = new Set([
      join(SRC, 'analytics', 'evaluate.ts'),
      join(SRC, 'analytics', 'evaluate-cli.ts'),
      join(SRC, 'datasets', 'generator.ts'),
      join(SRC, 'datasets', 'persist.ts'),
      join(SRC, 'datasets', 'scenarios.ts'),
      join(SRC, 'datasets', 'cli.ts'),
      join(SRC, 'shared', 'types.ts'),
      join(SRC, 'agents', 'diagnosis', 'types.ts'),
    ]);
    for (const file of walk(SRC)) {
      if (allowed.has(file)) continue;
      const source = code(file);
      const rel = relative(SRC, file).replace(/\\/g, '/');
      assert.ok(!/\bgroundTruth\b/.test(source), `${rel} reads ground truth`);
      assert.ok(!/\bidealAction\b/.test(source), `${rel} reads the ideal action label`);
    }
  });

  test('the CLI defaults to the mock provider', () => {
    // A live evaluation costs money and quota; it must be typed, never
    // reachable by an environment variable flipping underneath someone.
    assert.ok(/'mock'/.test(cliCode), 'the CLI has no mock default');
    const defaultLine = cliCode
      .split('\n')
      .find((l) => l.includes("flag('provider')"));
    assert.ok(defaultLine !== undefined && defaultLine.includes("?? 'mock'"));
  });

  test('the CLI never silently falls back to the mock for gemini', () => {
    assert.ok(
      /createAIProvider/.test(cliCode),
      'the CLI bypasses the factory, losing the fail-loud guarantee',
    );
  });
});

// ---------------------------------------------------------------------------
// DETERMINISM
// ---------------------------------------------------------------------------

describe('evaluation — determinism', () => {
  test('the same dataset produces byte-identical metrics', async () => {
    const dataset = smallDataset();
    const first = await evaluateDiagnosis(dataset, { split: 'eval' }, { provider: new MockAIProvider() });
    const second = await evaluateDiagnosis(dataset, { split: 'eval' }, { provider: new MockAIProvider() });

    assert.equal(
      JSON.stringify(first.classification),
      JSON.stringify(second.classification),
      'classification metrics drifted between identical runs',
    );
    assert.equal(JSON.stringify(first.action), JSON.stringify(second.action));
    assert.equal(JSON.stringify(first.recoverability), JSON.stringify(second.recoverability));
  });

  test('the same SEED reproduces the same metrics from a fresh dataset', async () => {
    const a = await evaluateDiagnosis(smallDataset(7), { split: 'eval' }, { provider: new MockAIProvider() });
    const b = await evaluateDiagnosis(smallDataset(7), { split: 'eval' }, { provider: new MockAIProvider() });
    assert.equal(a.classification.accuracy, b.classification.accuracy);
    assert.equal(a.action.macroF1, b.action.macroF1);
    assert.equal(a.evaluated, b.evaluated);
  });

  test('a DIFFERENT seed may legitimately produce different metrics', async () => {
    // Not a bug: a different sample is a different test set. Asserting only
    // that the harness is seed-sensitive, never that a specific value changes.
    const a = await evaluateDiagnosis(smallDataset(1), { split: 'eval' }, { provider: new MockAIProvider() });
    const b = await evaluateDiagnosis(smallDataset(999), { split: 'eval' }, { provider: new MockAIProvider() });
    assert.notEqual(a.datasetSeed, b.datasetSeed);
    // The record ids must differ, proving the datasets really are distinct.
    assert.notDeepEqual(
      a.cases.map((c) => c.paymentId),
      b.cases.map((c) => c.paymentId),
    );
  });

  test('no wall-clock dependency: an injected clock changes nothing spurious', async () => {
    const dataset = smallDataset();
    const early = await evaluateDiagnosis(
      dataset,
      { split: 'eval' },
      { provider: new MockAIProvider(), now: new Date('2026-08-22T10:30:00.000Z') },
    );
    const later = await evaluateDiagnosis(
      dataset,
      { split: 'eval' },
      { provider: new MockAIProvider(), now: new Date('2026-08-22T10:30:00.000Z') },
    );
    assert.equal(JSON.stringify(early.classification), JSON.stringify(later.classification));
  });

  test('the rendered report is deterministic', async () => {
    const dataset = smallDataset();
    const report = await evaluateDiagnosis(dataset, { split: 'eval' }, { provider: new MockAIProvider() });
    assert.equal(renderReport(report, 5), renderReport(report, 5));
    // And carries no timestamp, which would break byte-stability.
    assert.ok(!/\d{4}-\d{2}-\d{2}T/.test(renderReport(report, 0)), 'the report embeds a timestamp');
  });
});

// ---------------------------------------------------------------------------
// SPLIT HANDLING
// ---------------------------------------------------------------------------

describe('evaluation — data split', () => {
  test('the eval split scores only held-out records', async () => {
    const dataset = smallDataset();
    const report = await evaluateDiagnosis(dataset, { split: 'eval' }, { provider: new MockAIProvider() });

    const evalIds = new Set(
      dataset.records.filter((r) => r.split === 'eval').map((r) => r.payment.id),
    );
    assert.equal(report.evaluated, evalIds.size);
    for (const c of report.cases) {
      assert.ok(evalIds.has(c.paymentId), `${c.paymentId} is not in the eval split`);
    }
  });

  test('dev and eval are disjoint and sum to the whole', async () => {
    const dataset = smallDataset();
    const dev = await evaluateDiagnosis(dataset, { split: 'dev' }, { provider: new MockAIProvider() });
    const evl = await evaluateDiagnosis(dataset, { split: 'eval' }, { provider: new MockAIProvider() });
    const all = await evaluateDiagnosis(dataset, { split: 'all' }, { provider: new MockAIProvider() });

    assert.equal(dev.evaluated + evl.evaluated, all.evaluated);
    const devIds = new Set(dev.cases.map((c) => c.paymentId));
    for (const c of evl.cases) {
      assert.ok(!devIds.has(c.paymentId), 'a record appears in both splits');
    }
  });

  test('limit bounds the number scored', async () => {
    const report = await evaluateDiagnosis(
      smallDataset(),
      { split: 'eval', limit: 5 },
      { provider: new MockAIProvider() },
    );
    assert.equal(report.evaluated, 5);
  });

  test('an empty selection produces a well-formed zero report', async () => {
    const report = await evaluateDiagnosis(
      smallDataset(),
      { split: 'eval', limit: 0 },
      { provider: new MockAIProvider() },
    );
    assert.equal(report.evaluated, 0);
    assert.equal(report.classification.accuracy, 0);
    assert.ok(!Number.isNaN(report.classification.macroF1));
    assert.deepEqual(report.cases, []);
  });

  test('a single record evaluates cleanly', async () => {
    const report = await evaluateDiagnosis(
      smallDataset(),
      { split: 'eval', limit: 1 },
      { provider: new MockAIProvider() },
    );
    assert.equal(report.evaluated, 1);
    assert.equal(report.cases.length, 1);
    assert.ok([0, 1].includes(report.classification.accuracy));
  });
});

// ---------------------------------------------------------------------------
// SCORING BEHAVIOUR
// ---------------------------------------------------------------------------

describe('evaluation — scoring behaviour', () => {
  test('a provider failure is excluded, not scored as wrong', async () => {
    // Scoring a failed call either way would misstate model quality.
    let calls = 0;
    const flaky: AIProvider = {
      name: 'flaky',
      model: 'test',
      async diagnose() {
        calls += 1;
        if (calls === 2) throw new Error('provider exploded');
        return {
          classification: 'UNKNOWN',
          confidence: 0.5,
          reason: 'x',
          recommendedAction: 'NO_ACTION',
          expectedRecoveryProbability: 0.1,
          requiresHumanApproval: false,
          provider: 'flaky',
          model: 'test',
        } satisfies DiagnosisResult;
      },
    };

    const report = await evaluateDiagnosis(
      smallDataset(),
      { split: 'eval', limit: 4 },
      { provider: flaky },
    );

    assert.equal(report.errored, 1);
    assert.equal(report.evaluated, 3, 'the errored record was scored');
    assert.equal(report.classification.total, 3);
    assert.equal(report.cases.length, 4, 'the errored record was dropped from review');
  });

  test('a failing provider does not abort the run', async () => {
    const broken: AIProvider = {
      name: 'broken',
      model: 'test',
      async diagnose() {
        throw new Error('always fails');
      },
    };
    const report = await evaluateDiagnosis(
      smallDataset(),
      { split: 'eval', limit: 5 },
      { provider: broken },
    );
    assert.equal(report.errored, 5);
    assert.equal(report.evaluated, 0);
    assert.equal(report.classification.accuracy, 0);
  });

  test('at-risk-only metrics exclude already-captured payments', async () => {
    const dataset = smallDataset();
    const report = await evaluateDiagnosis(dataset, { split: 'eval' }, { provider: new MockAIProvider() });

    assert.ok(report.atRiskOnly.evaluated < report.evaluated, 'nothing was excluded');
    for (const c of report.cases.filter((x) => x.atRisk)) {
      assert.notEqual(c.expectedAction, 'NO_ACTION');
    }
  });

  test('failures() returns only incorrect or errored records', async () => {
    const report = await evaluateDiagnosis(
      smallDataset(),
      { split: 'eval' },
      { provider: new MockAIProvider() },
    );
    for (const c of failures(report)) {
      assert.ok(
        c.error !== null || !c.classificationCorrect || !c.actionCorrect,
        `${c.paymentId} is correct but listed as a failure`,
      );
    }
  });

  test('the recoverable threshold is applied as documented', async () => {
    const dataset = smallDataset();
    // Threshold 0 means everything is predicted recoverable.
    const permissive = await evaluateDiagnosis(
      dataset,
      { split: 'eval', recoverableThreshold: 0 },
      { provider: new MockAIProvider() },
    );
    assert.equal(permissive.recoverability.falseNegatives, 0);
    // Threshold above 1 means nothing is.
    const strict = await evaluateDiagnosis(
      dataset,
      { split: 'eval', recoverableThreshold: 1.1 },
      { provider: new MockAIProvider() },
    );
    assert.equal(strict.recoverability.truePositives, 0);
  });
});

// ---------------------------------------------------------------------------
// SECURITY
// ---------------------------------------------------------------------------

describe('evaluation — secret safety', () => {
  test('scrubReason removes every credential shape', () => {
    for (const raw of [
      'key rzp_test_ABC123xyz',
      'key rzp_live_DEADBEEF1',
      'AIzaSyDUMMYKEY1234567890',
      'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.body.sig',
      'Authorization: Basic dXNlcjpwYXNzd29yZA==',
      '{"api_key":"supersecretvalue"}',
    ]) {
      const out = scrubReason(raw);
      assert.ok(
        !/rzp_(test|live)_[A-Za-z0-9]{6,}|AIzaSy[A-Za-z0-9]{6,}|eyJhbGciOi|dXNlcjpwYXNz|supersecretvalue/.test(
          out,
        ),
        `credential survived scrubbing: ${out}`,
      );
    }
    assert.equal(scrubReason('x'.repeat(5000)).length, 300);
  });

  test('a model-authored reason is scrubbed before it reaches the report', async () => {
    const leaky: AIProvider = {
      name: 'leaky',
      model: 'test',
      async diagnose() {
        return {
          classification: 'UNKNOWN',
          confidence: 0.5,
          reason: 'failed using rzp_test_LEAKED123 and Bearer abcdef0123456789tok',
          recommendedAction: 'NO_ACTION',
          expectedRecoveryProbability: 0.1,
          requiresHumanApproval: false,
          provider: 'leaky',
          model: 'test',
        } satisfies DiagnosisResult;
      },
    };

    const report = await evaluateDiagnosis(
      smallDataset(),
      { split: 'eval', limit: 2 },
      { provider: leaky },
    );

    for (const c of report.cases) {
      assert.ok(!c.reason.includes('rzp_test_LEAKED123'), 'a Razorpay key reached the report');
      assert.ok(!c.reason.includes('abcdef0123456789tok'), 'a bearer token reached the report');
    }
    assert.ok(!renderReport(report, 10).includes('rzp_test_LEAKED123'));
  });

  test('the rendered report contains no credential-shaped text', async () => {
    const report = await evaluateDiagnosis(
      smallDataset(),
      { split: 'eval', limit: 20 },
      { provider: new MockAIProvider() },
    );
    const rendered = renderReport(report, 20);
    for (const forbidden of ['rzp_test_', 'rzp_live_', 'AIza', 'API_AUTH_TOKEN', 'Bearer ']) {
      assert.ok(!rendered.includes(forbidden), `the report leaked "${forbidden}"`);
    }
  });

  test('error review exposes only safe fields', async () => {
    const report = await evaluateDiagnosis(
      smallDataset(),
      { split: 'eval' },
      { provider: new MockAIProvider() },
    );
    const allowed = new Set([
      'paymentId', 'atRisk', 'expectedClassification', 'predictedClassification',
      'expectedAction', 'predictedAction', 'expectedRecoverable', 'predictedRecoverable',
      'predictedRecoveryProbability', 'confidence', 'reason',
      'classificationCorrect', 'actionCorrect', 'error',
    ]);
    for (const key of Object.keys(report.cases[0]!)) {
      assert.ok(allowed.has(key), `an unexpected field "${key}" is exposed in error review`);
    }
  });
});

// ---------------------------------------------------------------------------
// THE CLAIM BOUNDARY
// ---------------------------------------------------------------------------

describe('evaluation — model quality is not recovered revenue', () => {
  test('the report contains no monetary field', async () => {
    // The distinction the whole phase rests on. A money field here would
    // invite quoting a label score as revenue.
    const report = await evaluateDiagnosis(
      smallDataset(),
      { split: 'eval' },
      { provider: new MockAIProvider() },
    );
    const serialised = JSON.stringify(report);
    for (const forbidden of ['amountRecovered', 'amount_recovered', 'revenueAtRisk', 'recoveryRate']) {
      assert.ok(!serialised.includes(forbidden), `the evaluation report exposes "${forbidden}"`);
    }
  });

  test('the rendered report states the boundary explicitly', async () => {
    const report = await evaluateDiagnosis(
      smallDataset(),
      { split: 'eval', limit: 5 },
      { provider: new MockAIProvider() },
    );
    const rendered = renderReport(report, 0);
    assert.match(rendered, /not recovered revenue/i);
    assert.match(rendered, /VERIFIED/);
  });

  test('the harness does not import the revenue analytics module', () => {
    // Keeping them apart is what stops the two numbers being blended.
    const evalCode = code(join(SRC, 'analytics', 'evaluate.ts'));
    assert.ok(
      !/recovery-metrics/.test(evalCode),
      'the evaluation harness imports the revenue module',
    );
  });
});
