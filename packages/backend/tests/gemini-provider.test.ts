import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  GeminiAIProvider,
  GeminiConfigurationError,
  GeminiRequestError,
  sanitiseGeminiError,
  type GeminiTransport,
} from '../src/agents/diagnosis/providers/gemini.ts';
import { DEFAULT_GEMINI_MODEL } from '../src/agents/diagnosis/providers/gemini.ts';
import { createAIProvider } from '../src/agents/diagnosis/factory.ts';
import { loadConfig, ConfigError } from '../src/config/index.ts';
import { buildDiagnosisInput } from '../src/agents/diagnosis/input.ts';
import {
  DiagnosisValidationError,
  FORBIDDEN_EVALUATION_KEYS,
} from '../src/agents/diagnosis/types.ts';
import { DIAGNOSIS_SYSTEM_PROMPT } from '../src/agents/diagnosis/provider.ts';
import { assessRisk } from '../src/risk/detector.ts';
import { EMPTY_CUSTOMER_HISTORY } from '../src/risk/types.ts';
import { generateDataset } from '../src/datasets/generator.ts';
import type { Payment } from '../src/shared/types.ts';

/**
 * Gemini provider tests.
 *
 * NO REAL NETWORK CALLS. Every test injects a transport double.
 */

const API_KEY = 'AIzaTestKeyValue1234567890';
const POLICY = loadConfig({}).policy;
const NOW = new Date('2026-08-22T12:00:00.000Z');

function payment(overrides: Partial<Payment> = {}): Payment {
  return {
    id: 'pay_gem', merchantId: 'm1', customerId: 'c1', orderId: 'o1',
    amount: 249_900, currency: 'INR', status: 'failed', failureReason: 'gateway_timeout',
    attemptCount: 0, isSubscription: false,
    createdAt: new Date('2026-08-22T10:00:00.000Z'),
    updatedAt: new Date('2026-08-22T10:05:00.000Z'),
    ...overrides,
  };
}

function inputFor(p: Payment = payment()) {
  const assessment = assessRisk({ payment: p, customerHistory: EMPTY_CUSTOMER_HISTORY, now: NOW }, POLICY);
  return buildDiagnosisInput({
    payment: p, customerHistory: EMPTY_CUSTOMER_HISTORY, assessment, policy: POLICY,
  });
}

const VALID_DIAGNOSIS = {
  classification: 'TEMPORARY_FAILURE',
  confidence: 0.91,
  reason: 'Gateway timeout is transient and commonly succeeds on retry.',
  recommended_action: 'RETRY',
  expected_recovery_probability: 0.78,
};

/** A transport that records requests and replays a scripted model reply. */
function transportFor(options: {
  status?: number;
  ok?: boolean;
  raw?: string;
  modelText?: string;
  throws?: Error;
}): { transport: GeminiTransport; calls: { url: string; init: Parameters<GeminiTransport>[1] }[] } {
  const calls: { url: string; init: Parameters<GeminiTransport>[1] }[] = [];
  const transport: GeminiTransport = async (url, init) => {
    calls.push({ url, init });
    if (options.throws !== undefined) throw options.throws;
    const status = options.status ?? 200;
    const body =
      options.raw ??
      JSON.stringify({
        candidates: [{ content: { parts: [{ text: options.modelText ?? '' }] } }],
      });
    return {
      status,
      ok: options.ok ?? (status >= 200 && status < 300),
      text: async () => body,
    };
  };
  return { transport, calls };
}

function provider(transport: GeminiTransport) {
  return new GeminiAIProvider({ apiKey: API_KEY, transport });
}

describe('gemini — provider creation', () => {
  test('a valid configuration constructs', () => {
    const p = new GeminiAIProvider({ apiKey: API_KEY });
    assert.equal(p.name, 'gemini');
    assert.ok(p.model.startsWith('gemini-'));
  });

  test('a missing API key is rejected', () => {
    assert.throws(() => new GeminiAIProvider({ apiKey: '' }), GeminiConfigurationError);
    assert.throws(() => new GeminiAIProvider({ apiKey: '   ' }), GeminiConfigurationError);
  });

  test('the default model is a currently supported Gemini Flash model', () => {
    // gemini-1.5-flash and gemini-2.0-flash have been retired by Google.
    // Defaulting to a shut-down model would turn every diagnosis into a
    // provider error at runtime.
    assert.equal(DEFAULT_GEMINI_MODEL, 'gemini-3.7-flash');
    assert.equal(new GeminiAIProvider({ apiKey: API_KEY }).model, DEFAULT_GEMINI_MODEL);
  });

  test('the default is never a retired model', () => {
    for (const retired of ['gemini-1.5-flash', 'gemini-2.0-flash', 'gemini-pro']) {
      assert.notEqual(DEFAULT_GEMINI_MODEL, retired, `${retired} is retired`);
    }
  });

  test('loadConfig defaults to the same model — one source of truth', () => {
    // The constant is declared once in the provider and imported by config, so
    // the two cannot drift apart.
    assert.equal(loadConfig({}).ai.geminiModel, DEFAULT_GEMINI_MODEL);
  });

  test('the model is configurable through the environment', () => {
    assert.equal(
      loadConfig({ GEMINI_MODEL: 'gemini-3.7-pro' }).ai.geminiModel,
      'gemini-3.7-pro',
    );
    assert.equal(
      new GeminiAIProvider({ apiKey: API_KEY, model: 'gemini-3.7-flash-lite' }).model,
      'gemini-3.7-flash-lite',
    );
  });

  test('a configured model reaches the provider through the factory', () => {
    const built = createAIProvider(
      loadConfig({ AI_PROVIDER: 'gemini', GEMINI_API_KEY: API_KEY, GEMINI_MODEL: 'gemini-3.7-pro' }),
    );
    assert.equal((built as GeminiAIProvider).model, 'gemini-3.7-pro');
  });

  test('loadConfig rejects AI_PROVIDER=gemini without a key', () => {
    assert.throws(() => loadConfig({ AI_PROVIDER: 'gemini' }), ConfigError);
  });

  test('the missing-key error explains why there is no fallback', () => {
    try {
      loadConfig({ AI_PROVIDER: 'gemini' });
      assert.fail('should have thrown');
    } catch (error) {
      const message = (error as Error).message;
      assert.ok(message.includes('GEMINI_API_KEY'));
      assert.ok(message.toLowerCase().includes('mock'), 'should explain the no-fallback rule');
    }
  });

  test('the factory builds Gemini from valid config', () => {
    const built = createAIProvider(loadConfig({ AI_PROVIDER: 'gemini', GEMINI_API_KEY: API_KEY }));
    assert.equal(built.name, 'gemini');
  });

  test('the factory NEVER silently falls back to MockAI', () => {
    // The failure mode this guards: a deployment believing it uses a real model
    // while quietly serving deterministic stubs.
    assert.throws(() => loadConfig({ AI_PROVIDER: 'gemini' }), ConfigError);
    const mock = createAIProvider(loadConfig({ AI_PROVIDER: 'mock' }));
    assert.equal(mock.name, 'mock', 'MockAI must remain available when explicitly selected');
  });
});

describe('gemini — request construction', () => {
  test('sends the system prompt and the rendered diagnosis prompt', async () => {
    const { transport, calls } = transportFor({ modelText: JSON.stringify(VALID_DIAGNOSIS) });
    await provider(transport).diagnose(inputFor());

    const body = JSON.parse(calls[0]!.init.body) as {
      systemInstruction: { parts: { text: string }[] };
      contents: { parts: { text: string }[] }[];
      generationConfig: Record<string, unknown>;
    };
    assert.ok(body.systemInstruction.parts[0]!.text.includes('ADVISORY ONLY'));
    assert.ok(body.contents[0]!.parts[0]!.text.includes('Diagnose this at-risk payment'));
    // A response-format control, not a sampling parameter — this one stays.
    assert.equal(body.generationConfig['responseMimeType'], 'application/json');
  });

  test('sends NO deprecated Gemini 3.x sampling parameter', async () => {
    // Gemini 3.x deprecates the classic sampling controls. Sending one is at
    // best ignored and at worst rejected, so none may appear anywhere in the
    // request — including under generationConfig.
    const { transport, calls } = transportFor({ modelText: JSON.stringify(VALID_DIAGNOSIS) });
    await provider(transport).diagnose(inputFor());

    const raw = calls[0]!.init.body;
    const body = JSON.parse(raw) as { generationConfig: Record<string, unknown> };

    const DEPRECATED = [
      'temperature',
      'topP', 'top_p',
      'topK', 'top_k',
      'candidateCount', 'candidate_count',
      'thinkingBudget', 'thinking_budget',
    ];

    for (const param of DEPRECATED) {
      assert.ok(
        !(param in body.generationConfig),
        `generationConfig sends the deprecated parameter "${param}"`,
      );
      // Belt and braces: it must not appear anywhere else in the payload either.
      assert.ok(!raw.includes(`"${param}"`), `the request body contains "${param}"`);
    }
  });

  test('generationConfig carries only response-format controls', () => {
    // A whitelist rather than a blacklist: a newly-added sampling parameter
    // fails this test even if it is not on the deprecated list above.
    const source = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'agents', 'diagnosis',
        'providers', 'gemini.ts'),
      'utf8',
    );
    const configBlock = source.slice(
      source.indexOf('generationConfig: {'),
      source.indexOf('});', source.indexOf('generationConfig: {')),
    );
    const keys = [...configBlock.matchAll(/^\s*([A-Za-z_][A-Za-z0-9_]*):/gm)]
      .map((m) => m[1]!)
      // Drop the opening `generationConfig:` line itself; we want its members.
      .filter((key) => key !== 'generationConfig');

    assert.deepEqual(
      keys.sort(),
      ['maxOutputTokens', 'responseMimeType'],
      `unexpected generationConfig keys: ${keys.join(', ')}`,
    );
  });

  test('the request shape matches the documented generateContent contract', async () => {
    // v1beta + models/{model}:generateContent with systemInstruction/contents
    // is the standard REST shape and is not model-specific.
    const { transport, calls } = transportFor({ modelText: JSON.stringify(VALID_DIAGNOSIS) });
    await provider(transport).diagnose(inputFor());

    assert.ok(calls[0]!.url.startsWith('https://generativelanguage.googleapis.com/v1beta/models/'));
    assert.ok(calls[0]!.url.endsWith(':generateContent'));
    assert.equal(calls[0]!.init.method, 'POST');
    assert.equal(calls[0]!.init.headers['Content-Type'], 'application/json');

    const body = JSON.parse(calls[0]!.init.body) as Record<string, unknown>;
    // Exactly the documented top-level fields; nothing invented.
    assert.deepEqual(
      Object.keys(body).sort(),
      ['contents', 'generationConfig', 'systemInstruction'],
    );
  });

  test('sends the key in a header, never in the URL', async () => {
    const { transport, calls } = transportFor({ modelText: JSON.stringify(VALID_DIAGNOSIS) });
    await provider(transport).diagnose(inputFor());

    assert.equal(calls[0]!.init.headers['x-goog-api-key'], API_KEY);
    // A key in a URL would be captured by proxy and access logs.
    assert.ok(!calls[0]!.url.includes(API_KEY), 'the API key appeared in the URL');
    assert.ok(!calls[0]!.url.includes('key='), 'the API key was passed as a query parameter');
  });

  test('targets the configured model', async () => {
    const { transport, calls } = transportFor({ modelText: JSON.stringify(VALID_DIAGNOSIS) });
    await new GeminiAIProvider({
      apiKey: API_KEY, model: 'gemini-3.7-flash-lite', transport,
    }).diagnose(inputFor());
    assert.ok(calls[0]!.url.includes('gemini-3.7-flash-lite:generateContent'));
  });

  test('reuses the existing prompt builder — no second builder exists', async () => {
    const { transport, calls } = transportFor({ modelText: JSON.stringify(VALID_DIAGNOSIS) });
    const input = inputFor();
    await provider(transport).diagnose(input);

    // The prompt must contain the same sanitized context MockAI receives.
    const prompt = JSON.parse(calls[0]!.init.body).contents[0].parts[0].text as string;
    assert.ok(prompt.includes(String(input.payment.amount)));
    assert.ok(prompt.includes('SUPPORTED ACTIONS'));
  });
});

describe('gemini — response parsing and strict validation', () => {
  test('a valid response yields a domain diagnosis', async () => {
    const { transport } = transportFor({ modelText: JSON.stringify(VALID_DIAGNOSIS) });
    const result = await provider(transport).diagnose(inputFor());

    assert.equal(result.classification, 'TEMPORARY_FAILURE');
    assert.equal(result.recommendedAction, 'RETRY');
    assert.equal(result.confidence, 0.91);
    assert.equal(result.provider, 'gemini');
    assert.ok(result.model.startsWith('gemini-'));
  });

  test('malformed JSON is rejected', async () => {
    const { transport } = transportFor({ modelText: '{not valid json' });
    await assert.rejects(() => provider(transport).diagnose(inputFor()), DiagnosisValidationError);
  });

  test('a missing field is rejected', async () => {
    const { classification, ...rest } = VALID_DIAGNOSIS;
    void classification;
    const { transport } = transportFor({ modelText: JSON.stringify(rest) });
    await assert.rejects(() => provider(transport).diagnose(inputFor()), DiagnosisValidationError);
  });

  test('an invalid enum value is rejected', async () => {
    const { transport } = transportFor({
      modelText: JSON.stringify({ ...VALID_DIAGNOSIS, classification: 'MADE_UP' }),
    });
    await assert.rejects(() => provider(transport).diagnose(inputFor()), DiagnosisValidationError);
  });

  test('an unsupported action is rejected', async () => {
    const { transport } = transportFor({
      modelText: JSON.stringify({ ...VALID_DIAGNOSIS, recommended_action: 'REFUND_EVERYTHING' }),
    });
    await assert.rejects(() => provider(transport).diagnose(inputFor()), DiagnosisValidationError);
  });

  test('malformed confidence is rejected', async () => {
    for (const bad of [1.5, -0.2, 'high', null]) {
      const { transport } = transportFor({
        modelText: JSON.stringify({ ...VALID_DIAGNOSIS, confidence: bad }),
      });
      await assert.rejects(
        () => provider(transport).diagnose(inputFor()),
        DiagnosisValidationError,
        `confidence ${String(bad)} should be rejected`,
      );
    }
  });

  test('invented execution instructions are rejected', async () => {
    // The model must never be able to smuggle an action past the validator.
    for (const injected of [
      { payment_id: 'pay_invented' },
      { api_endpoint: 'https://api.razorpay.com/v1/payments' },
      { execute: true },
      { authorized: true },
    ]) {
      const { transport } = transportFor({
        modelText: JSON.stringify({ ...VALID_DIAGNOSIS, ...injected }),
      });
      await assert.rejects(
        () => provider(transport).diagnose(inputFor()),
        DiagnosisValidationError,
        `should reject ${JSON.stringify(injected)}`,
      );
    }
  });

  test('free-form prose is never turned into an authorization', async () => {
    const { transport } = transportFor({
      modelText: 'Sure! I have retried the payment and recovered the money.',
    });
    await assert.rejects(() => provider(transport).diagnose(inputFor()), DiagnosisValidationError);
  });

  test('the returned type carries no authorization or outcome field', async () => {
    const { transport } = transportFor({ modelText: JSON.stringify(VALID_DIAGNOSIS) });
    const keys = Object.keys(await provider(transport).diagnose(inputFor()));
    for (const forbidden of ['authorized', 'executed', 'recovered', 'verified']) {
      assert.ok(!keys.includes(forbidden), `diagnosis exposes "${forbidden}"`);
    }
  });
});

describe('gemini — failure handling', () => {
  test('an HTTP error throws rather than inventing a recommendation', async () => {
    const { transport } = transportFor({ status: 500, ok: false, raw: '{"error":"server"}' });
    await assert.rejects(() => provider(transport).diagnose(inputFor()), GeminiRequestError);
  });

  test('a rate-limit response throws', async () => {
    const { transport } = transportFor({ status: 429, ok: false, raw: '{"error":"quota"}' });
    await assert.rejects(() => provider(transport).diagnose(inputFor()), GeminiRequestError);
  });

  test('a transport failure throws', async () => {
    const { transport } = transportFor({ throws: new Error('ECONNRESET') });
    await assert.rejects(() => provider(transport).diagnose(inputFor()), GeminiRequestError);
  });

  test('a timeout throws a clear error', async () => {
    const slow: GeminiTransport = async (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        });
      });
    const p = new GeminiAIProvider({ apiKey: API_KEY, transport: slow, timeoutMs: 30 });
    await assert.rejects(() => p.diagnose(inputFor()), /timed out/);
  });

  test('a blocked prompt throws rather than returning a diagnosis', async () => {
    const { transport } = transportFor({ raw: JSON.stringify({ promptFeedback: { blockReason: 'SAFETY' } }) });
    await assert.rejects(() => provider(transport).diagnose(inputFor()), GeminiRequestError);
  });

  test('an empty completion throws rather than defaulting optimistically', async () => {
    const { transport } = transportFor({ modelText: '   ' });
    await assert.rejects(() => provider(transport).diagnose(inputFor()), GeminiRequestError);
  });

  test('no failure path ever returns a recommendation', async () => {
    // Every failure must throw so analyze falls back to the deterministic
    // baseline, never to an optimistic guess.
    const failures = [
      transportFor({ status: 500, ok: false, raw: '{}' }),
      transportFor({ throws: new Error('boom') }),
      transportFor({ modelText: '' }),
      transportFor({ raw: 'not json' }),
    ];
    for (const { transport } of failures) {
      await assert.rejects(() => provider(transport).diagnose(inputFor()));
    }
  });
});

describe('gemini — transient failure classification (live-test regression)', () => {
  // Live smoke testing found gemini-3.7-flash returning 503 "high demand" and
  // taking 25-60s under load. Two provider-local fixes came out of it: a
  // longer default timeout, and marking capacity/rate errors as transient so
  // an operator can tell "overloaded" apart from "malformed request".

  test('the default timeout accommodates a loaded model', () => {
    // A 20s ceiling turned slow-but-successful responses into provider errors.
    const source = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'agents', 'diagnosis',
        'providers', 'gemini.ts'),
      'utf8',
    );
    const match = source.match(/const DEFAULT_TIMEOUT_MS = ([0-9_]+);/);
    assert.ok(match, 'DEFAULT_TIMEOUT_MS not found');
    const ms = Number(match[1]!.replace(/_/g, ''));
    assert.ok(ms >= 60_000, `default timeout ${ms}ms is too tight for a loaded model`);
  });

  test('a 503 is classified transient', async () => {
    const { transport } = transportFor({
      status: 503, ok: false,
      raw: '{"error":{"code":503,"message":"This model is currently experiencing high demand."}}',
    });
    try {
      await provider(transport).diagnose(inputFor());
      assert.fail('should have thrown');
    } catch (error) {
      assert.ok(error instanceof GeminiRequestError);
      assert.equal(error.transient, true, '503 should be transient');
      assert.ok(error.message.includes('(transient)'));
    }
  });

  test('a 429 is classified transient', async () => {
    const { transport } = transportFor({ status: 429, ok: false, raw: '{"error":"quota"}' });
    try {
      await provider(transport).diagnose(inputFor());
      assert.fail('should have thrown');
    } catch (error) {
      assert.equal((error as GeminiRequestError).transient, true);
    }
  });

  test('a 400 is NOT transient — retrying would not help', async () => {
    const { transport } = transportFor({ status: 400, ok: false, raw: '{"error":"bad request"}' });
    try {
      await provider(transport).diagnose(inputFor());
      assert.fail('should have thrown');
    } catch (error) {
      assert.equal((error as GeminiRequestError).transient, false);
      assert.ok(!(error as Error).message.includes('(transient)'));
    }
  });

  test('a timeout is classified transient', async () => {
    const slow: GeminiTransport = async (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        });
      });
    const p = new GeminiAIProvider({ apiKey: API_KEY, transport: slow, timeoutMs: 30 });
    try {
      await p.diagnose(inputFor());
      assert.fail('should have thrown');
    } catch (error) {
      assert.equal((error as GeminiRequestError).transient, true);
    }
  });

  test('a transient failure still throws — never an optimistic diagnosis', async () => {
    // The classification is informational only. A capacity error must not
    // become a recommendation; analyze falls back to the deterministic baseline.
    const { transport } = transportFor({ status: 503, ok: false, raw: '{"error":"busy"}' });
    await assert.rejects(() => provider(transport).diagnose(inputFor()), GeminiRequestError);
  });
});

describe('gemini — no secret leakage', () => {
  test('the API key never appears in an error message', async () => {
    const { transport } = transportFor({
      status: 400, ok: false, raw: `{"error":"bad key ${API_KEY}"}`,
    });
    try {
      await provider(transport).diagnose(inputFor());
      assert.fail('should have thrown');
    } catch (error) {
      assert.ok(!(error as Error).message.includes(API_KEY), 'the error leaked the API key');
      assert.ok((error as Error).message.includes('[redacted-key]'));
    }
  });

  test('a thrown transport error is scrubbed', async () => {
    const { transport } = transportFor({ throws: new Error(`failed with key ${API_KEY}`) });
    try {
      await provider(transport).diagnose(inputFor());
      assert.fail('should have thrown');
    } catch (error) {
      assert.ok(!(error as Error).message.includes(API_KEY));
    }
  });

  test('sanitiseGeminiError strips every credential shape', () => {
    const dirty =
      `key AIzaSyLEAKEDKEY1234567890 and ?key=another_secret_value, ` +
      `{"api_key":"hunter2"}, Bearer eyJhbGciOi.abc-def`;
    const clean = sanitiseGeminiError(dirty);
    for (const secret of [
      'AIzaSyLEAKEDKEY1234567890', 'another_secret_value', 'hunter2', 'eyJhbGciOi.abc-def',
    ]) {
      assert.ok(!clean.includes(secret), `leaked "${secret}"`);
    }
  });

  test('a successful diagnosis carries no credential', async () => {
    const { transport } = transportFor({ modelText: JSON.stringify(VALID_DIAGNOSIS) });
    const serialised = JSON.stringify(await provider(transport).diagnose(inputFor()));
    assert.ok(!serialised.includes(API_KEY));
    assert.ok(!serialised.includes('AIza'));
  });
});

describe('gemini — ground-truth boundary', () => {
  test('the request body carries no evaluation label', async () => {
    const { transport, calls } = transportFor({ modelText: JSON.stringify(VALID_DIAGNOSIS) });
    await provider(transport).diagnose(inputFor());

    const body = calls[0]!.init.body;

    // Match forbidden keys as whole tokens. A naive substring check would fire
    // on `expected_recovery_probability` — a required OUTPUT field named in the
    // response schema, which merely contains "recovery_probability".
    for (const key of FORBIDDEN_EVALUATION_KEYS) {
      const asToken = new RegExp(`(^|[^A-Za-z_])${key}([^A-Za-z_]|$)`);
      assert.ok(!asToken.test(body), `the Gemini request leaked "${key}"`);
    }
  });

  test('the prompt names expected_recovery_probability only as an OUTPUT field', () => {
    // Guards the distinction the test above depends on: the model is asked to
    // PRODUCE this number, never given a ground-truth one.
    const prompt = DIAGNOSIS_SYSTEM_PROMPT;
    assert.ok(prompt.includes('"expected_recovery_probability": <number 0..1>'));
    assert.ok(!/ground.?truth/i.test(prompt), 'the system prompt mentions ground truth');
  });

  test('a real dataset record reaches Gemini without its labels', async () => {
    // The realistic leak scenario: the dataset genuinely carries ground truth.
    const dataset = generateDataset({
      seed: 42, recordCount: 20, evalSplit: 0.3,
      avgTransactionValue: 250_000, customerRepeatRate: 0.45,
    });
    const record = dataset.records.find((r) => r.payment.status === 'failed')!;
    assert.ok(record.groundTruth.idealAction, 'the record should carry ground truth');

    const { transport, calls } = transportFor({ modelText: JSON.stringify(VALID_DIAGNOSIS) });
    await provider(transport).diagnose(inputFor(record.payment));

    const body = calls[0]!.init.body;
    for (const key of FORBIDDEN_EVALUATION_KEYS) {
      const asToken = new RegExp(`(^|[^A-Za-z_])${key}([^A-Za-z_]|$)`);
      assert.ok(!asToken.test(body), `leaked "${key}"`);
    }
    assert.ok(!body.includes('groundTruth'));
    // The VALUES matter most: no label may reach the model.
    assert.ok(!body.includes(String(record.groundTruth.recoveryProbability)));
    assert.ok(!body.includes(record.groundTruth.idealAction + '"'));
  });

  test('a polluted input is refused before it leaves the process', async () => {
    const { transport, calls } = transportFor({ modelText: JSON.stringify(VALID_DIAGNOSIS) });
    const polluted = { ...inputFor(), groundTruth: { recoverable: true } } as never;
    await assert.rejects(() => provider(transport).diagnose(polluted));
    assert.equal(calls.length, 0, 'a polluted input must never reach the network');
  });
});
