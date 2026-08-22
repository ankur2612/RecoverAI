import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, redactedConfig, ConfigError } from '../src/config/index.ts';

/** Minimal env with nothing set, so defaults are exercised. */
const EMPTY: Record<string, string | undefined> = {};

describe('loadConfig — defaults', () => {
  test('defaults to the mock providers so no key is required', () => {
    const config = loadConfig(EMPTY);
    assert.equal(config.ai.provider, 'mock');
    assert.equal(config.payments.provider, 'mock');
  });

  test('applies the PRD default policy values', () => {
    const { policy } = loadConfig(EMPTY);
    // PRD section 10.
    assert.equal(policy.maxRetryAttempts, 3);
    assert.equal(policy.maxAutomatedAmount, 1_000_000); // INR 10,000 in paise
    assert.equal(policy.minRecoveryConfidence, 0.75);
  });

  test('applies the PRD default dataset values', () => {
    const { dataset } = loadConfig(EMPTY);
    // PRD section 27.
    assert.equal(dataset.seed, 42);
    assert.equal(dataset.recordCount, 1000);
  });
});

describe('loadConfig — policy is configurable, not hardcoded', () => {
  test('policy values are overridable from the environment', () => {
    const config = loadConfig({
      POLICY_MAX_RETRY_ATTEMPTS: '5',
      POLICY_MAX_AUTOMATED_AMOUNT: '2500000',
      POLICY_MIN_RECOVERY_CONFIDENCE: '0.9',
      POLICY_RETRY_COOLDOWN_SECONDS: '600',
    });
    assert.equal(config.policy.maxRetryAttempts, 5);
    assert.equal(config.policy.maxAutomatedAmount, 2_500_000);
    assert.equal(config.policy.minRecoveryConfidence, 0.9);
    assert.equal(config.policy.retryCooldownSeconds, 600);
  });
});

describe('loadConfig — validation', () => {
  test('rejects a non-integer where an integer is required', () => {
    assert.throws(() => loadConfig({ POLICY_MAX_RETRY_ATTEMPTS: '2.5' }), ConfigError);
  });

  test('rejects an out-of-range confidence threshold', () => {
    assert.throws(() => loadConfig({ POLICY_MIN_RECOVERY_CONFIDENCE: '1.5' }), ConfigError);
  });

  test('rejects an unknown provider name', () => {
    assert.throws(() => loadConfig({ AI_PROVIDER: 'gemini' }), ConfigError);
    assert.throws(() => loadConfig({ PAYMENT_PROVIDER: 'stripe' }), ConfigError);
  });

  test('rejects an invalid port', () => {
    assert.throws(() => loadConfig({ PORT: '70000' }), ConfigError);
  });
});

describe('loadConfig — credential requirements', () => {
  test('claude provider requires an API key', () => {
    assert.throws(() => loadConfig({ AI_PROVIDER: 'claude' }), ConfigError);
  });

  test('claude provider accepts a present key', () => {
    const config = loadConfig({ AI_PROVIDER: 'claude', ANTHROPIC_API_KEY: 'sk-ant-test' });
    assert.equal(config.ai.provider, 'claude');
  });

  test('openai provider requires an API key', () => {
    assert.throws(() => loadConfig({ AI_PROVIDER: 'openai' }), ConfigError);
  });

  test('razorpay provider requires both key id and secret', () => {
    assert.throws(
      () => loadConfig({ PAYMENT_PROVIDER: 'razorpay', RAZORPAY_KEY_ID: 'rzp_test_abc' }),
      ConfigError,
    );
  });

  test('an empty-string key counts as absent', () => {
    assert.throws(() => loadConfig({ AI_PROVIDER: 'claude', ANTHROPIC_API_KEY: '   ' }), ConfigError);
  });
});

describe('loadConfig — live-key guard', () => {
  test('refuses a live Razorpay key', () => {
    // The system must never be pointed at real money (PRD section 12).
    assert.throws(
      () =>
        loadConfig({
          PAYMENT_PROVIDER: 'razorpay',
          RAZORPAY_KEY_ID: 'rzp_live_abc123',
          RAZORPAY_KEY_SECRET: 'secret',
        }),
      ConfigError,
    );
  });

  test('accepts a test-mode key', () => {
    const config = loadConfig({
      PAYMENT_PROVIDER: 'razorpay',
      RAZORPAY_KEY_ID: 'rzp_test_abc123',
      RAZORPAY_KEY_SECRET: 'secret',
    });
    assert.equal(config.payments.provider, 'razorpay');
  });

  test('rejects a live key even when the provider is mock', () => {
    // Presence of a live credential anywhere in the env is itself the hazard.
    assert.throws(() => loadConfig({ RAZORPAY_KEY_ID: 'rzp_live_xyz' }), ConfigError);
  });
});

describe('redactedConfig — no secret leakage', () => {
  const config = loadConfig({
    AI_PROVIDER: 'claude',
    ANTHROPIC_API_KEY: 'sk-ant-super-secret-value',
    PAYMENT_PROVIDER: 'razorpay',
    RAZORPAY_KEY_ID: 'rzp_test_keyid',
    RAZORPAY_KEY_SECRET: 'razorpay-super-secret-value',
    DATABASE_URL: 'postgres://user:dbpassword@host:5432/db',
  });

  test('serialised output contains no secret material', () => {
    const serialised = JSON.stringify(redactedConfig(config));
    for (const secret of [
      'sk-ant-super-secret-value',
      'razorpay-super-secret-value',
      'rzp_test_keyid',
      'dbpassword',
    ]) {
      assert.ok(!serialised.includes(secret), `redacted config leaked "${secret}"`);
    }
  });

  test('still reports whether credentials are present', () => {
    const redacted = redactedConfig(config);
    assert.equal(redacted.ai.credentialPresent, true);
    assert.equal(redacted.payments.credentialPresent, true);
    assert.equal(redacted.databaseConfigured, true);
  });

  test('exposes policy values, which are not secret', () => {
    const redacted = redactedConfig(config);
    assert.equal(redacted.policy.maxRetryAttempts, 3);
  });
});
