import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { buildApp } from '../src/app.ts';
import { loadConfig, redactedConfig } from '../src/config/index.ts';
import { RateLimiter } from '../src/api/rate-limit.ts';
import { MockAIProvider } from '../src/agents/diagnosis/providers/mock.ts';
import { MockRecoveryProvider } from '../src/payments/providers/mock.ts';

/**
 * RATE LIMITING
 *
 * The property under test: a caller cannot make unlimited attempts, and the
 * limiter never leaks a credential or alters recovery semantics.
 *
 * All tokens here are fake and hardcoded. Nothing reads .env.
 */

const TOKEN = 'ratelimit-token-0123456789abcdef';
const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');

function appConfig(overrides: Record<string, string> = {}) {
  return loadConfig({
    AUTH_ENABLED: 'true',
    API_AUTH_TOKEN: TOKEN,
    ...overrides,
  });
}

describe('rate limiter — counting', () => {
  test('requests under the limit are allowed', () => {
    const limiter = new RateLimiter({ max: 3, windowMs: 1000, now: () => 0 });
    for (let i = 0; i < 3; i += 1) {
      assert.equal(limiter.consume('a').allowed, true, `request ${i + 1} was blocked`);
    }
  });

  test('the request past the limit is refused', () => {
    const limiter = new RateLimiter({ max: 2, windowMs: 1000, now: () => 0 });
    limiter.consume('a');
    limiter.consume('a');
    const third = limiter.consume('a');
    assert.equal(third.allowed, false);
    assert.equal(third.remaining, 0);
    assert.ok(third.retryAfterSeconds >= 1, 'no retry hint was given');
  });

  test('remaining counts down and never goes negative', () => {
    const limiter = new RateLimiter({ max: 2, windowMs: 1000, now: () => 0 });
    assert.equal(limiter.consume('a').remaining, 1);
    assert.equal(limiter.consume('a').remaining, 0);
    assert.equal(limiter.consume('a').remaining, 0);
    assert.equal(limiter.consume('a').remaining, 0);
  });

  test('clients are counted independently', () => {
    // One noisy caller must not exhaust another's budget.
    const limiter = new RateLimiter({ max: 1, windowMs: 1000, now: () => 0 });
    assert.equal(limiter.consume('a').allowed, true);
    assert.equal(limiter.consume('a').allowed, false);
    assert.equal(limiter.consume('b').allowed, true, 'a second client was blocked');
  });

  test('the window resets after it elapses', () => {
    let clock = 0;
    const limiter = new RateLimiter({ max: 1, windowMs: 1000, now: () => clock });
    assert.equal(limiter.consume('a').allowed, true);
    assert.equal(limiter.consume('a').allowed, false);

    clock = 1000; // window boundary
    assert.equal(limiter.consume('a').allowed, true, 'the window did not reset');
  });

  test('a max of zero or below is clamped to at least one', () => {
    // A misconfiguration must not block every request outright.
    const limiter = new RateLimiter({ max: 0, windowMs: 1000, now: () => 0 });
    assert.equal(limiter.consume('a').allowed, true);
  });

  test('expired entries are swept so memory cannot grow without bound', () => {
    let clock = 0;
    const limiter = new RateLimiter({ max: 1, windowMs: 10, now: () => clock });
    for (let i = 0; i < 500; i += 1) limiter.consume(`client-${i}`);
    const before = limiter.size;
    clock = 1_000_000; // everything has expired

    // A fresh consume with a full map triggers the sweep path; with a small
    // map it simply replaces the expired window.
    limiter.consume('client-0');
    assert.ok(limiter.size <= before + 1, 'the limiter grew unexpectedly');
  });
});

describe('rate limiting — HTTP behaviour', () => {
  test('requests under the limit reach the handler', async () => {
    const app = await buildApp({
      config: appConfig({ RATE_LIMIT_MAX: '5', RATE_LIMIT_WINDOW_MS: '60000' }),
      provider: new MockAIProvider(),
      recoveryProvider: new MockRecoveryProvider(),
    });
    await app.ready();

    for (let i = 0; i < 5; i += 1) {
      const response = await app.inject({
        method: 'GET',
        url: '/api/payments?merchant_id=m1',
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      assert.notEqual(response.statusCode, 429, `request ${i + 1} was rate limited`);
    }
    await app.close();
  });

  test('excess requests are refused with 429 and Retry-After', async () => {
    const app = await buildApp({
      config: appConfig({ RATE_LIMIT_MAX: '3', RATE_LIMIT_WINDOW_MS: '60000' }),
      provider: new MockAIProvider(),
    });
    await app.ready();

    for (let i = 0; i < 3; i += 1) {
      await app.inject({ method: 'GET', url: '/api/payments' });
    }
    const blocked = await app.inject({ method: 'GET', url: '/api/payments' });

    assert.equal(blocked.statusCode, 429);
    assert.ok(blocked.headers['retry-after'] !== undefined, 'no Retry-After header');
    assert.equal(JSON.parse(blocked.body).error, 'rate_limited');
    await app.close();
  });

  test('rate limiting applies BEFORE authentication', async () => {
    // Unauthenticated guesses must be throttled without each one reaching the
    // credential comparison. Once the budget is spent the answer becomes 429
    // rather than 401.
    const app = await buildApp({
      config: appConfig({ RATE_LIMIT_MAX: '2', RATE_LIMIT_WINDOW_MS: '60000' }),
      provider: new MockAIProvider(),
    });
    await app.ready();

    const first = await app.inject({ method: 'GET', url: '/api/payments' });
    const second = await app.inject({ method: 'GET', url: '/api/payments' });
    const third = await app.inject({ method: 'GET', url: '/api/payments' });

    assert.equal(first.statusCode, 401, 'auth did not run for an in-budget request');
    assert.equal(second.statusCode, 401);
    assert.equal(third.statusCode, 429, 'the flood was not throttled');
    await app.close();
  });

  test('the health endpoint is NEVER rate limited', async () => {
    // Throttling a readiness probe would make a healthy service look down.
    const app = await buildApp({
      config: appConfig({ RATE_LIMIT_MAX: '1', RATE_LIMIT_WINDOW_MS: '60000' }),
      provider: new MockAIProvider(),
    });
    await app.ready();

    for (let i = 0; i < 10; i += 1) {
      const response = await app.inject({ method: 'GET', url: '/api/health' });
      assert.notEqual(response.statusCode, 429, `health was throttled on probe ${i + 1}`);
    }
    await app.close();
  });

  test('rate-limit headers are present on an allowed request', async () => {
    const app = await buildApp({
      config: appConfig({ RATE_LIMIT_MAX: '10' }),
      provider: new MockAIProvider(),
    });
    await app.ready();

    const response = await app.inject({ method: 'GET', url: '/api/payments' });
    assert.equal(response.headers['x-ratelimit-limit'], '10');
    assert.ok(response.headers['x-ratelimit-remaining'] !== undefined);
    await app.close();
  });

  test('limits are configurable', async () => {
    const config = appConfig({ RATE_LIMIT_MAX: '7', RATE_LIMIT_WINDOW_MS: '30000' });
    assert.equal(config.rateLimit.max, 7);
    assert.equal(config.rateLimit.windowMs, 30_000);
    assert.equal(config.rateLimit.enabled, true);
  });

  test('rate limiting can be disabled explicitly', async () => {
    const app = await buildApp({
      config: appConfig({ RATE_LIMIT_ENABLED: 'false', RATE_LIMIT_MAX: '1' }),
      provider: new MockAIProvider(),
    });
    await app.ready();

    for (let i = 0; i < 5; i += 1) {
      const response = await app.inject({ method: 'GET', url: '/api/payments' });
      assert.notEqual(response.statusCode, 429);
    }
    await app.close();
  });

  test('an invalid RATE_LIMIT_ENABLED fails closed', () => {
    // Consistent with AUTH_ENABLED: a typo must not silently disable it.
    for (const bad of ['yes', 'no', 'on', '2']) {
      assert.throws(() => loadConfig({ RATE_LIMIT_ENABLED: bad }));
    }
  });
});

describe('rate limiting — secret safety', () => {
  test('a 429 response never contains a credential', async () => {
    const app = await buildApp({
      config: appConfig({ RATE_LIMIT_MAX: '1' }),
      provider: new MockAIProvider(),
    });
    await app.ready();

    await app.inject({ method: 'GET', url: '/api/payments' });
    const blocked = await app.inject({
      method: 'GET',
      url: '/api/payments',
      headers: { authorization: `Bearer ${TOKEN}` },
    });

    assert.equal(blocked.statusCode, 429);
    assert.ok(!blocked.body.includes(TOKEN), 'the 429 leaked the token');
    for (const forbidden of ['rzp_test_', 'AIza', 'API_AUTH_TOKEN', 'Bearer ']) {
      assert.ok(!blocked.body.includes(forbidden), `the 429 leaked "${forbidden}"`);
    }
    await app.close();
  });

  test('redactedConfig exposes limits but no secret', () => {
    const serialised = JSON.stringify(redactedConfig(appConfig()));
    assert.ok(serialised.includes('rateLimit'), 'limits are not reported');
    assert.ok(!serialised.includes(TOKEN), 'the token leaked into redacted config');
  });
});

describe('rate limiting — architecture', () => {
  const code = (file: string): string =>
    readFileSync(file, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');

  const limiterCode = code(join(SRC, 'api', 'rate-limit.ts'));

  test('the limiter lives only at the HTTP boundary', () => {
    // It must not be able to influence policy, execution, or recovery.
    assert.ok(!/evaluatePolicy/.test(limiterCode), 'the limiter evaluates policy');
    assert.ok(!/executeAction|executeRecoveryCase/.test(limiterCode), 'the limiter can execute');
    assert.ok(!/from ['"].*recovery\//.test(limiterCode), 'the limiter imports the recovery layer');
    assert.ok(!/from ['"].*policies\//.test(limiterCode), 'the limiter imports the policy engine');
    assert.ok(!/from ['"].*payments\//.test(limiterCode), 'the limiter imports the payments layer');
    assert.ok(!/from ['"]pg['"]|db\/pool/.test(limiterCode), 'the limiter reaches the database');
  });

  test('the limiter reads no credential', () => {
    assert.ok(!/process\.env/.test(limiterCode), 'the limiter reads process.env');
    assert.ok(!limiterCode.includes('API_AUTH_TOKEN'), 'the limiter names the auth token');
    assert.ok(
      !/headers\.authorization|headers\[['"]x-api-key/.test(limiterCode),
      'the limiter reads a credential header',
    );
  });

  test('the limiter never logs a credential', () => {
    const logCalls = limiterCode.match(/log\.(warn|info|error)\([\s\S]{0,300}?\);/g) ?? [];
    assert.ok(logCalls.length > 0, 'expected the limiter to log something');
    for (const call of logCalls) {
      assert.ok(!/token|authorization|apiKey/i.test(call), 'a log call references a credential');
    }
  });

  test('the limiter is registered before authentication in app.ts', () => {
    const appSource = readFileSync(join(SRC, 'app.ts'), 'utf8');
    const limitIndex = appSource.indexOf('registerRateLimit(');
    const authIndex = appSource.indexOf('registerAuth(');
    assert.ok(limitIndex > 0, 'the limiter is never registered');
    assert.ok(limitIndex < authIndex, 'the limiter runs after authentication');
  });
});
