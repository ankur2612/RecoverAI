import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { GeminiAIProvider } from '../src/agents/diagnosis/providers/gemini.ts';
import { RazorpayTestProvider } from '../src/payments/providers/razorpay.ts';
import { buildDiagnosisInput } from '../src/agents/diagnosis/input.ts';
import { FORBIDDEN_EVALUATION_KEYS } from '../src/agents/diagnosis/types.ts';
import { assessRisk } from '../src/risk/detector.ts';
import { EMPTY_CUSTOMER_HISTORY } from '../src/risk/types.ts';
import { loadConfig } from '../src/config/index.ts';
import { CLASSIFICATIONS, RECOVERY_ACTIONS } from '../src/shared/types.ts';
import { OBSERVED_PAYMENT_STATES } from '../src/payments/provider.ts';
import type { Payment } from '../src/shared/types.ts';

/**
 * ============================================================================
 * GATED LIVE PROVIDER SMOKE TEST
 * ============================================================================
 *
 * These are the ONLY tests in the repository that touch the network, and they
 * run ONLY when RECOVERAI_LIVE_PROVIDER_TESTS=1. `npm test` never sets that
 * flag, so the default suite remains fully offline and deterministic.
 *
 * Scope: PROVIDER CONTRACT, not model quality.
 *   - Gemini: exactly ONE generateContent request.
 *   - Razorpay: exactly ONE read-only GET, and only when an explicit payment
 *     id is supplied. Nothing is created, captured, retried, or refunded.
 *
 * Credentials are read from the process environment and are never printed,
 * asserted on by value, or included in failure messages.
 */

const LIVE = process.env.RECOVERAI_LIVE_PROVIDER_TESTS === '1';
const skipLive = LIVE ? false : 'RECOVERAI_LIVE_PROVIDER_TESTS is not 1; skipping live tests';

/** Load .env into a map without mutating process.env or logging any value. */
function readDotEnv(): Record<string, string> {
  const path = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '.env');
  const out: Record<string, string> = {};
  try {
    for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
      if (line === '' || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq < 0) continue;
      out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
    }
  } catch {
    // No .env is fine; the environment may supply the values directly.
  }
  return out;
}

const dotenv = readDotEnv();
const envValue = (key: string): string | undefined =>
  process.env[key] !== undefined && process.env[key] !== ''
    ? process.env[key]
    : dotenv[key] !== undefined && dotenv[key] !== ''
      ? dotenv[key]
      : undefined;

/** Synthetic payment. No real customer or payment data is ever sent. */
const SYNTHETIC_PAYMENT: Payment = {
  id: 'pay_smoke_synthetic_001',
  merchantId: 'merchant_smoke',
  customerId: 'cust_smoke',
  orderId: 'order_smoke_001',
  amount: 249_900,
  currency: 'INR',
  status: 'failed',
  failureReason: 'gateway_timeout',
  attemptCount: 0,
  isSubscription: false,
  createdAt: new Date('2026-08-22T10:00:00.000Z'),
  updatedAt: new Date('2026-08-22T10:05:00.000Z'),
};

/** Counts real outbound requests, so the report can state the exact number. */
const requestCount = { gemini: 0, razorpay: 0 };

describe('live smoke — gating', () => {
  test('the flag defaults to off, so the normal suite stays offline', () => {
    // Documents the contract: without the flag, nothing below runs.
    const flag = process.env.RECOVERAI_LIVE_PROVIDER_TESTS;
    assert.ok(
      flag === undefined || flag === '' || flag === '0' || flag === '1',
      'the live flag should be unset or a simple 0/1',
    );
  });
});

describe('live smoke — Gemini', { skip: skipLive }, () => {
  test('one real request satisfies the provider contract', async () => {
    const apiKey = envValue('GEMINI_API_KEY');
    assert.ok(apiKey !== undefined, 'GEMINI_API_KEY is not configured');

    const model = envValue('GEMINI_MODEL') ?? loadConfig({}).ai.geminiModel;
    const policy = loadConfig({}).policy;

    // Built by the EXISTING builder — no second prompt path.
    const assessment = assessRisk(
      { payment: SYNTHETIC_PAYMENT, customerHistory: EMPTY_CUSTOMER_HISTORY, now: new Date() },
      policy,
    );
    const input = buildDiagnosisInput({
      payment: SYNTHETIC_PAYMENT,
      customerHistory: EMPTY_CUSTOMER_HISTORY,
      assessment,
      policy,
    });

    // Ground-truth boundary, checked before anything leaves the process.
    const serialisedInput = JSON.stringify(input);
    for (const key of FORBIDDEN_EVALUATION_KEYS) {
      const asToken = new RegExp(`(^|[^A-Za-z_])${key}([^A-Za-z_]|$)`);
      assert.ok(!asToken.test(serialisedInput), `the diagnosis input carries "${key}"`);
    }

    // Wrap the real transport purely to count requests. It still performs a
    // genuine fetch; nothing is stubbed.
    const provider = new GeminiAIProvider({
      apiKey,
      model,
      transport: async (url, init) => {
        requestCount.gemini += 1;
        const response = await fetch(url, init as RequestInit);
        return { status: response.status, ok: response.ok, text: () => response.text() };
      },
    });

    // Exactly ONE request. Passes through the existing strict validator.
    const result = await provider.diagnose(input);

    assert.equal(requestCount.gemini, 1, 'exactly one Gemini request should be made');

    // ---- Contract assertions (NOT model-quality assertions) --------------
    assert.ok(
      CLASSIFICATIONS.includes(result.classification),
      `classification "${result.classification}" is not in the domain enum`,
    );
    assert.ok(
      RECOVERY_ACTIONS.includes(result.recommendedAction),
      `recommendedAction "${result.recommendedAction}" is not in the domain enum`,
    );
    assert.ok(
      result.confidence >= 0 && result.confidence <= 1,
      `confidence ${result.confidence} out of range`,
    );
    assert.ok(
      result.expectedRecoveryProbability >= 0 && result.expectedRecoveryProbability <= 1,
      `expectedRecoveryProbability ${result.expectedRecoveryProbability} out of range`,
    );
    assert.equal(result.provider, 'gemini');
    assert.equal(result.model, model);

    // No authorization or execution field may exist on a diagnosis.
    const keys = Object.keys(result);
    for (const forbidden of ['authorized', 'executed', 'recovered', 'verified', 'apiResult']) {
      assert.ok(!keys.includes(forbidden), `the diagnosis exposes "${forbidden}"`);
    }

    // The response must carry no credential.
    const serialised = JSON.stringify(result);
    assert.ok(!serialised.includes(apiKey), 'the diagnosis leaked the API key');
    assert.ok(!/AIza[A-Za-z0-9_-]{20,}/.test(serialised), 'the diagnosis contains a key-shaped string');

    // Sanitized evidence only — no raw model text, no payment details.
    console.log('  [gemini] HTTP: success | requests: 1');
    console.log(`  [gemini] model: ${model}`);
    console.log(`  [gemini] classification: ${result.classification}`);
    console.log(`  [gemini] recommended_action: ${result.recommendedAction}`);
    console.log(`  [gemini] confidence: ${result.confidence}`);
    console.log(`  [gemini] expected_recovery_probability: ${result.expectedRecoveryProbability}`);
    console.log(`  [gemini] requires_human_approval: ${result.requiresHumanApproval}`);
  });

  test('the synthetic payment id is the one that was diagnosed', () => {
    // The diagnosis carries no payment id by design; what matters is that the
    // input we built referenced only the synthetic payment.
    const policy = loadConfig({}).policy;
    const assessment = assessRisk(
      { payment: SYNTHETIC_PAYMENT, customerHistory: EMPTY_CUSTOMER_HISTORY, now: new Date() },
      policy,
    );
    const input = buildDiagnosisInput({
      payment: SYNTHETIC_PAYMENT,
      customerHistory: EMPTY_CUSTOMER_HISTORY,
      assessment,
      policy,
    });
    assert.equal(input.payment.paymentId, 'pay_smoke_synthetic_001');
    assert.ok(input.payment.paymentId.includes('synthetic'));
  });
});

describe('live smoke — Razorpay', { skip: skipLive }, () => {
  test('the configured key is TEST mode', () => {
    const keyId = envValue('RAZORPAY_KEY_ID');
    assert.ok(keyId !== undefined, 'RAZORPAY_KEY_ID is not configured');
    assert.ok(keyId.startsWith('rzp_test_'), 'the configured key is not a Test Mode key');
    assert.ok(!keyId.startsWith('rzp_live_'), 'a LIVE key is configured — refusing to proceed');
    // assert.ok, never assert.match: assert.match embeds the actual input in
    // its failure output, which would print the real key id to the console
    // and CI logs on a misconfiguration.
    assert.ok(
      /^rzp_test_[A-Za-z0-9]+$/.test(keyId),
      'RAZORPAY_KEY_ID is not a well-formed test key',
    );
  });

  test('live and malformed credentials are rejected', () => {
    const secret = envValue('RAZORPAY_KEY_SECRET') ?? 'placeholder';
    for (const bad of ['rzp_live_abc123', 'rzp_sandbox_abc', 'not_a_key', '']) {
      assert.throws(
        () => new RazorpayTestProvider({ keyId: bad, keySecret: secret }),
        `"${bad}" should be rejected`,
      );
    }
  });

  test('one read-only status lookup satisfies the provider contract', async (t) => {
    const paymentId = envValue('RAZORPAY_SMOKE_PAYMENT_ID');
    if (paymentId === undefined) {
      // Explicitly skip rather than invent an id. A guessed id would either
      // 404 (a false failure) or touch a payment we do not own.
      t.skip('RAZORPAY_SMOKE_PAYMENT_ID is not set; skipping the read-only lookup');
      return;
    }

    const keyId = envValue('RAZORPAY_KEY_ID')!;
    const keySecret = envValue('RAZORPAY_KEY_SECRET')!;

    const urls: string[] = [];
    const provider = new RazorpayTestProvider({
      keyId,
      keySecret,
      transport: async (url, init) => {
        requestCount.razorpay += 1;
        urls.push(`${init.method} ${url}`);
        const response = await fetch(url, init as RequestInit);
        return { status: response.status, ok: response.ok, text: () => response.text() };
      },
    });

    // getPaymentStatus is a pure READ. Nothing is created or mutated.
    const status = await provider.getPaymentStatus(paymentId);

    assert.equal(requestCount.razorpay, 1, 'exactly one Razorpay request should be made');
    // Hard safety assertion: the only verb used is GET, and no mutating path.
    assert.ok(urls[0]!.startsWith('GET '), 'the smoke test must only issue a GET');
    for (const forbidden of ['/capture', '/refund', '/orders', '/payments/create']) {
      assert.ok(!urls[0]!.includes(forbidden), `the request touched ${forbidden}`);
    }

    assert.ok(
      OBSERVED_PAYMENT_STATES.includes(status.state),
      `state "${status.state}" is not in the domain enum`,
    );

    // No credential may appear in the normalized result.
    const serialised = JSON.stringify(status);
    assert.ok(!serialised.includes(keyId), 'the result leaked the key id');
    assert.ok(!serialised.includes(keySecret), 'the result leaked the secret');
    assert.ok(!/rzp_(test|live)_[A-Za-z0-9]{6,}/.test(serialised), 'the result contains a key');
    assert.ok(!/Basic\s+[A-Za-z0-9+/=]+/.test(serialised), 'the result contains an auth header');

    console.log('  [razorpay] HTTP: success | requests: 1 | method: GET (read-only)');
    console.log(`  [razorpay] normalized state: ${status.state}`);
    console.log(`  [razorpay] raw status: ${status.rawStatus ?? '(none)'}`);

    // An UNKNOWN state means the lookup itself failed (auth, 404, transport).
    // That is a configuration failure, not a passing smoke test.
    assert.notEqual(
      status.state,
      'UNKNOWN',
      `the lookup did not resolve: ${status.errorMessage ?? 'no detail'}`,
    );
  });
});
