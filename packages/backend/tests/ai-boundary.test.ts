import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';
import {
  assertNoEvaluationData,
  EvaluationDataLeakError,
  FORBIDDEN_EVALUATION_KEYS,
} from '../src/agents/diagnosis/types.ts';
import { buildDiagnosisInput } from '../src/agents/diagnosis/input.ts';
import { renderDiagnosisPrompt, DIAGNOSIS_SYSTEM_PROMPT } from '../src/agents/diagnosis/provider.ts';
import { MockAIProvider } from '../src/agents/diagnosis/providers/mock.ts';
import { assessRisk } from '../src/risk/detector.ts';
import { EMPTY_CUSTOMER_HISTORY } from '../src/risk/types.ts';
import { loadConfig } from '../src/config/index.ts';
import { generateDataset } from '../src/datasets/generator.ts';
import type { Payment } from '../src/shared/types.ts';

const POLICY = loadConfig({}).policy;
const NOW = new Date('2026-08-22T12:00:00.000Z');
const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');

function payment(overrides: Partial<Payment> = {}): Payment {
  return {
    id: 'pay_test',
    merchantId: 'merchant_001',
    customerId: 'cust_001',
    orderId: 'order_test',
    amount: 249_900,
    currency: 'INR',
    status: 'failed',
    failureReason: 'gateway_timeout',
    attemptCount: 0,
    isSubscription: false,
    createdAt: new Date('2026-08-22T10:00:00.000Z'),
    updatedAt: new Date('2026-08-22T10:05:00.000Z'),
    ...overrides,
  };
}

function buildInput(p: Payment = payment()) {
  const assessment = assessRisk(
    { payment: p, customerHistory: EMPTY_CUSTOMER_HISTORY, now: NOW },
    POLICY,
  );
  return buildDiagnosisInput({
    payment: p,
    customerHistory: EMPTY_CUSTOMER_HISTORY,
    assessment,
    policy: POLICY,
  });
}

/** Recursively collect .ts files under a directory. */
function walk(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, acc);
    else if (entry.endsWith('.ts')) acc.push(full);
  }
  return acc;
}

describe('AI boundary — DiagnosisInput contains no evaluation data', () => {
  test('a built input passes the deep evaluation-data check', () => {
    assert.doesNotThrow(() => assertNoEvaluationData(buildInput()));
  });

  test('the input has no forbidden key at any depth', () => {
    const serialised = JSON.stringify(buildInput());
    for (const key of FORBIDDEN_EVALUATION_KEYS) {
      assert.ok(
        !serialised.includes(`"${key}"`),
        `DiagnosisInput leaked forbidden key "${key}"`,
      );
    }
  });

  test('input carries only the expected top-level sections', () => {
    // A new top-level field should be a deliberate decision, not a surprise.
    assert.deepEqual(Object.keys(buildInput()).sort(), [
      'customerHistory',
      'payment',
      'policy',
      'risk',
      'supportedActions',
    ]);
  });

  test('the payment view exposes no label-shaped field', () => {
    const view = buildInput().payment;
    assert.deepEqual(Object.keys(view).sort(), [
      'ageHours',
      'amount',
      'attemptCount',
      'currency',
      'failureReason',
      'isSubscription',
      'paymentId',
      'status',
    ]);
  });
});

describe('AI boundary — runtime leak detection', () => {
  test('detects a top-level groundTruth object', () => {
    assert.throws(
      () => assertNoEvaluationData({ payment: {}, groundTruth: { recoverable: true } }),
      EvaluationDataLeakError,
    );
  });

  test('detects a nested ground-truth label', () => {
    assert.throws(
      () => assertNoEvaluationData({ a: { b: { c: { ideal_action: 'RETRY' } } } }),
      EvaluationDataLeakError,
    );
  });

  test('detects a label inside an array', () => {
    assert.throws(
      () => assertNoEvaluationData({ items: [{ ok: 1 }, { recoverable: false }] }),
      EvaluationDataLeakError,
    );
  });

  test('detects every forbidden key individually', () => {
    for (const key of FORBIDDEN_EVALUATION_KEYS) {
      assert.throws(
        () => assertNoEvaluationData({ [key]: 'x' }),
        EvaluationDataLeakError,
        `key "${key}" was not detected`,
      );
    }
  });

  test('the error names the offending path', () => {
    try {
      assertNoEvaluationData({ outer: { inner: { split: 'eval' } } });
      assert.fail('should have thrown');
    } catch (error) {
      assert.ok(error instanceof EvaluationDataLeakError);
      assert.ok(error.message.includes('outer.inner.split'), error.message);
    }
  });

  test('allows legitimate operational data', () => {
    assert.doesNotThrow(() =>
      assertNoEvaluationData({
        payment: { amount: 100, status: 'failed', attemptCount: 2 },
        customerHistory: { successRate: 0.8 },
      }),
    );
  });
});

describe('AI boundary — the builder cannot be tricked', () => {
  test('a polluted payment object does not leak into the input', () => {
    // Simulates a row fetched with a careless SELECT * that picked up labels.
    const polluted = {
      ...payment(),
      groundTruth: { recoverable: true, idealAction: 'RETRY' },
      recovery_probability: 0.99,
    } as unknown as Payment;

    const assessment = assessRisk(
      { payment: polluted, customerHistory: EMPTY_CUSTOMER_HISTORY, now: NOW },
      POLICY,
    );
    const input = buildDiagnosisInput({
      payment: polluted,
      customerHistory: EMPTY_CUSTOMER_HISTORY,
      assessment,
      policy: POLICY,
    });

    // The builder copies named fields only, so the pollution is dropped.
    const serialised = JSON.stringify(input);
    assert.ok(!serialised.includes('groundTruth'));
    assert.ok(!serialised.includes('recovery_probability'));
    assert.ok(!serialised.includes('0.99'));
  });

  test('a generated dataset record never reaches a provider with its labels', async () => {
    // The synthetic dataset genuinely has ground truth attached; this is the
    // realistic leak scenario the boundary exists to prevent.
    const dataset = generateDataset({
      seed: 42,
      recordCount: 20,
      evalSplit: 0.3,
      avgTransactionValue: 250_000,
      customerRepeatRate: 0.45,
    });

    const record = dataset.records.find((r) => r.payment.status === 'failed');
    assert.ok(record, 'expected a failed record in the dataset');
    assert.ok(record.groundTruth.idealAction, 'record should carry ground truth');

    const assessment = assessRisk(
      { payment: record.payment, customerHistory: EMPTY_CUSTOMER_HISTORY, now: NOW },
      POLICY,
    );
    const input = buildDiagnosisInput({
      payment: record.payment,
      customerHistory: EMPTY_CUSTOMER_HISTORY,
      assessment,
      policy: POLICY,
    });

    const serialised = JSON.stringify(input);
    for (const key of FORBIDDEN_EVALUATION_KEYS) {
      assert.ok(!serialised.includes(`"${key}"`), `leaked "${key}"`);
    }

    // And the rendered prompt a real LLM would receive is equally clean.
    const prompt = renderDiagnosisPrompt(input);
    for (const key of FORBIDDEN_EVALUATION_KEYS) {
      assert.ok(!prompt.includes(key), `prompt leaked "${key}"`);
    }
    assert.ok(!prompt.includes(record.groundTruth.idealAction + '"'));

    // The provider still produces a usable diagnosis from clean input only.
    const result = await new MockAIProvider().diagnose(input);
    assert.ok(result.classification);
  });

  test('the rendered prompt contains no evaluation vocabulary', () => {
    const prompt = renderDiagnosisPrompt(buildInput()).toLowerCase();
    for (const term of ['ground truth', 'ground_truth', 'expected classification', 'label']) {
      assert.ok(!prompt.includes(term), `prompt mentions "${term}"`);
    }
  });
});

describe('AI boundary — the prompt contract forbids execution', () => {
  test('states the recommendation/authorization/execution separation', () => {
    assert.ok(DIAGNOSIS_SYSTEM_PROMPT.includes('RECOMMENDATION != AUTHORIZATION != EXECUTION'));
    assert.ok(DIAGNOSIS_SYSTEM_PROMPT.includes('ADVISORY ONLY'));
  });

  test('forbids inventing information and claiming execution', () => {
    const prompt = DIAGNOSIS_SYSTEM_PROMPT;
    for (const rule of [
      'Invent payment information',
      'Invent API results',
      'Claim that an action was executed',
      'State that money was recovered',
      'endpoint',
    ]) {
      assert.ok(prompt.includes(rule), `prompt is missing the rule about "${rule}"`);
    }
  });

  test('requires structured JSON and escalation when uncertain', () => {
    assert.ok(DIAGNOSIS_SYSTEM_PROMPT.includes('single JSON object'));
    assert.ok(DIAGNOSIS_SYSTEM_PROMPT.includes('ESCALATE'));
  });

  test('instructs the model not to expose internal deliberation', () => {
    // PRD section 21: show a concise explanation, not private reasoning.
    assert.ok(DIAGNOSIS_SYSTEM_PROMPT.includes('Do not include internal deliberation'));
  });
});

describe('AI boundary — the provider has no execution capability', () => {
  test('the provider interface exposes only diagnose()', async () => {
    const provider = new MockAIProvider();
    const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(provider)).filter(
      (name) => name !== 'constructor' && typeof (provider as never)[name] === 'function',
    );
    // Only the public diagnose() plus its private helpers; nothing that acts.
    for (const method of methods) {
      assert.ok(
        !/execute|retry|capture|refund|charge|pay|send|notify/i.test(method),
        `provider exposes an action-shaped method: ${method}`,
      );
    }
  });

  test('diagnose() returns a recommendation, never an outcome', async () => {
    const result = await new MockAIProvider().diagnose(buildInput());
    const keys = Object.keys(result);
    for (const forbidden of ['executed', 'recovered', 'authorized', 'apiResult', 'transactionId']) {
      assert.ok(!keys.includes(forbidden), `result exposes "${forbidden}"`);
    }
    assert.ok(keys.includes('recommendedAction'));
  });
});

/**
 * ARCHITECTURAL DEPENDENCY TEST (PRD section 9, step 13).
 *
 * Enforces the direction of the architecture at the import level:
 *
 *     AIProvider -> DiagnosisResult -> RecoveryCase        (allowed)
 *     AIProvider -> Razorpay / executor / payment provider (forbidden)
 *
 * The executor does not exist yet. This test fails the moment someone adds one
 * and wires it to the AI layer, which is precisely when it matters.
 */
describe('AI boundary — architectural dependency direction', () => {
  const agentFiles = walk(join(SRC, 'agents'));

  test('agent modules exist and are covered by this test', () => {
    assert.ok(agentFiles.length >= 4, `expected agent files, found ${agentFiles.length}`);
  });

  test('no AI module imports a payment provider, executor, or vendor SDK', () => {
    const forbiddenImports = [
      /from ['"].*payments\/razorpay/,
      /from ['"].*payments\/provider/,
      /from ['"].*recovery\/executor/,
      /from ['"]razorpay['"]/,
      /from ['"]stripe['"]/,
      /require\(['"]razorpay['"]\)/,
    ];

    for (const file of agentFiles) {
      const source = readFileSync(file, 'utf8');
      for (const pattern of forbiddenImports) {
        assert.ok(
          !pattern.test(source),
          `${relative(SRC, file)} imports a forbidden execution dependency (${pattern})`,
        );
      }
    }
  });

  test('no AI module imports the database layer', () => {
    // A provider that could query the database could read ground truth.
    for (const file of agentFiles) {
      const source = readFileSync(file, 'utf8');
      assert.ok(
        !/from ['"].*db\/pool/.test(source) && !/from ['"]pg['"]/.test(source),
        `${relative(SRC, file)} imports the database layer`,
      );
    }
  });

  test('no AI module references the ground-truth table', () => {
    for (const file of agentFiles) {
      const source = readFileSync(file, 'utf8');
      assert.ok(
        !source.includes('payment_ground_truth'),
        `${relative(SRC, file)} references payment_ground_truth`,
      );
    }
  });

  test('no AI module performs network calls of its own', () => {
    for (const file of agentFiles) {
      const source = readFileSync(file, 'utf8');
      // MockAI must make no outbound call at all; a future LLM provider will
      // call its own model endpoint and this test will need scoping to it.
      assert.ok(!/\bfetch\(/.test(source), `${relative(SRC, file)} calls fetch()`);
      assert.ok(!/node:http/.test(source), `${relative(SRC, file)} imports node:http`);
    }
  });

  test('the risk detector does not depend on any AI module', () => {
    // Deterministic detection must stand alone when the AI is unavailable.
    for (const file of walk(join(SRC, 'risk'))) {
      const source = readFileSync(file, 'utf8');
      assert.ok(
        !/from ['"].*agents\//.test(source),
        `${relative(SRC, file)} depends on an AI module`,
      );
    }
  });

  test('no module anywhere QUERIES ground truth outside datasets and evaluation', () => {
    // Only the dataset generator/persistence layer may touch the labels table.
    // Matches actual SQL usage rather than any textual mention, so a comment
    // documenting the boundary is fine while a real query is not.
    const allowed = ['datasets', 'db'];
    const sqlUsage = /\b(from|join|into|update|delete\s+from)\s+payment_ground_truth\b/i;

    for (const file of walk(SRC)) {
      const rel = relative(SRC, file).replace(/\\/g, '/');
      if (allowed.some((dir) => rel.startsWith(`${dir}/`))) continue;
      const source = readFileSync(file, 'utf8');
      assert.ok(!sqlUsage.test(source), `${rel} queries payment_ground_truth`);
    }
  });

  test('no AI module even mentions the ground-truth table', () => {
    // Stricter rule for the AI layer specifically: not even in a comment, so
    // there is no template for someone to uncomment later.
    for (const file of agentFiles) {
      const source = readFileSync(file, 'utf8');
      assert.ok(
        !source.includes('payment_ground_truth'),
        `${relative(SRC, file)} mentions payment_ground_truth`,
      );
    }
  });
});
