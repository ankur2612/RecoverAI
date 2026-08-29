import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, redactedConfig, ConfigError, MIN_AUTH_TOKEN_LENGTH } from '../src/config/index.ts';
import {
  authenticateRequest,
  extractCredential,
  isPublicPath,
  timingSafeCompare,
} from '../src/api/auth.ts';

/**
 * AUTHENTICATION TESTS
 *
 * Every credential in this file is FAKE and hardcoded. Nothing here reads
 * .env, and no real token appears in the repository.
 *
 * The distinction under test throughout: authentication decides WHO may call
 * the API. It never decides whether a recovery action is permitted — that
 * stays with the policy engine, which these tests never reach.
 */

/** A fake token, long enough to satisfy the minimum-length rule. */
const TOKEN = 'test-token-0123456789abcdef';
const WRONG = 'wrong-token-0123456789abcde';

// ---------------------------------------------------------------------------
// CONFIGURATION
// ---------------------------------------------------------------------------

describe('auth config — defaults', () => {
  test('authentication is disabled by default', () => {
    // The existing offline and DB-backed suites call the API with no
    // credentials. The default must preserve that.
    const config = loadConfig({});
    assert.equal(config.auth.enabled, false);
    assert.equal(config.auth.token, undefined);
  });

  test('auth disabled works with no token', () => {
    const config = loadConfig({ AUTH_ENABLED: 'false' });
    assert.equal(config.auth.enabled, false);
    assert.equal(config.auth.token, undefined);
  });

  test('a token in the environment is ignored while auth is disabled', () => {
    // Not carried in memory, so an open deployment holds no secret it cannot use.
    const config = loadConfig({ AUTH_ENABLED: 'false', API_AUTH_TOKEN: TOKEN });
    assert.equal(config.auth.token, undefined);
  });
});

describe('auth config — enabling requires a token', () => {
  test('auth enabled requires API_AUTH_TOKEN', () => {
    assert.throws(() => loadConfig({ AUTH_ENABLED: 'true' }), ConfigError);
  });

  test('an empty token is rejected', () => {
    assert.throws(
      () => loadConfig({ AUTH_ENABLED: 'true', API_AUTH_TOKEN: '' }),
      ConfigError,
    );
  });

  test('a whitespace-only token is rejected', () => {
    assert.throws(
      () => loadConfig({ AUTH_ENABLED: 'true', API_AUTH_TOKEN: '   ' }),
      ConfigError,
    );
  });

  test('a trivially short token is rejected', () => {
    assert.throws(
      () => loadConfig({ AUTH_ENABLED: 'true', API_AUTH_TOKEN: 'short' }),
      ConfigError,
    );
  });

  test('the too-short error never echoes the supplied token', () => {
    try {
      loadConfig({ AUTH_ENABLED: 'true', API_AUTH_TOKEN: 'secretish' });
      assert.fail('should have thrown');
    } catch (error) {
      assert.ok(!(error as Error).message.includes('secretish'));
    }
  });

  test('a token of exactly the minimum length is accepted', () => {
    const exact = 'a'.repeat(MIN_AUTH_TOKEN_LENGTH);
    const config = loadConfig({ AUTH_ENABLED: 'true', API_AUTH_TOKEN: exact });
    assert.equal(config.auth.enabled, true);
    assert.equal(config.auth.token, exact);
  });

  test('AUTH_ENABLED accepts 1 and 0 as well as true and false', () => {
    assert.equal(loadConfig({ AUTH_ENABLED: '1', API_AUTH_TOKEN: TOKEN }).auth.enabled, true);
    assert.equal(loadConfig({ AUTH_ENABLED: '0' }).auth.enabled, false);
  });

  test('an ambiguous AUTH_ENABLED value is rejected, not read as false', () => {
    // "yes" silently meaning false would disable authentication on a typo.
    for (const bad of ['yes', 'no', 'on', 'off', 'TRUE-ish', '2']) {
      assert.throws(
        () => loadConfig({ AUTH_ENABLED: bad, API_AUTH_TOKEN: TOKEN }),
        ConfigError,
        `"${bad}" should be rejected`,
      );
    }
  });
});

describe('auth config — redaction', () => {
  const config = loadConfig({ AUTH_ENABLED: 'true', API_AUTH_TOKEN: TOKEN });

  test('redactedConfig reports only credential presence', () => {
    const redacted = redactedConfig(config);
    assert.equal(redacted.auth.enabled, true);
    assert.equal(redacted.auth.credentialPresent, true);
  });

  test('redactedConfig never exposes the token', () => {
    const serialised = JSON.stringify(redactedConfig(config));
    assert.ok(!serialised.includes(TOKEN), 'the token appears in redacted config');
    assert.ok(!serialised.includes('API_AUTH_TOKEN'));
    // And no key named like a secret carries a value.
    assert.ok(!/"token"\s*:/.test(serialised), 'a "token" field is serialised');
  });

  test('credentialPresent is false when auth is disabled', () => {
    const open = redactedConfig(loadConfig({ AUTH_ENABLED: 'false', API_AUTH_TOKEN: TOKEN }));
    assert.equal(open.auth.enabled, false);
    assert.equal(open.auth.credentialPresent, false);
  });
});

// ---------------------------------------------------------------------------
// TIMING-SAFE COMPARISON
// ---------------------------------------------------------------------------

describe('auth — timing-safe comparison', () => {
  test('identical values match', () => {
    assert.equal(timingSafeCompare(TOKEN, TOKEN), true);
  });

  test('different values of equal length do not match', () => {
    const a = 'a'.repeat(32);
    const b = 'a'.repeat(31) + 'b';
    assert.equal(timingSafeCompare(a, b), false);
  });

  test('a length mismatch does not match and does not throw', () => {
    // crypto.timingSafeEqual throws on unequal lengths; the wrapper must not.
    assert.doesNotThrow(() => timingSafeCompare('short', 'much-longer-value'));
    assert.equal(timingSafeCompare('short', 'much-longer-value'), false);
  });

  test('an empty supplied value never matches a real token', () => {
    assert.equal(timingSafeCompare('', TOKEN), false);
  });

  test('a prefix of the token does not match', () => {
    // The property a naive === leaks: a correct prefix must not be special.
    assert.equal(timingSafeCompare(TOKEN.slice(0, -1), TOKEN), false);
  });

  test('the implementation uses node:crypto timingSafeEqual', async () => {
    // Asserted structurally: a naive === would satisfy every behavioural test
    // above while remaining vulnerable, so the mechanism itself is checked.
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join } = await import('node:path');
    const source = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'api', 'auth.ts'),
      'utf8',
    );
    assert.ok(/from ['"]node:crypto['"]/.test(source), 'auth does not import node:crypto');
    assert.ok(/timingSafeEqual\(/.test(source), 'auth does not call timingSafeEqual');
    // And the comparison function must not fall back to ===.
    const fn = source.slice(
      source.indexOf('export function timingSafeCompare'),
      source.indexOf('export function extractCredential'),
    );
    assert.ok(!/supplied === expected|expected === supplied/.test(fn));
  });
});

// ---------------------------------------------------------------------------
// CREDENTIAL EXTRACTION
// ---------------------------------------------------------------------------

describe('auth — credential extraction', () => {
  test('no credentials at all is "missing"', () => {
    assert.deepEqual(extractCredential({}), { failure: 'missing_credentials' });
  });

  test('a Bearer token is extracted', () => {
    assert.deepEqual(extractCredential({ authorization: `Bearer ${TOKEN}` }), {
      credential: TOKEN,
    });
  });

  test('the Bearer scheme is case-insensitive', () => {
    for (const scheme of ['Bearer', 'bearer', 'BEARER', 'BeArEr']) {
      assert.deepEqual(extractCredential({ authorization: `${scheme} ${TOKEN}` }), {
        credential: TOKEN,
      });
    }
  });

  test('an x-api-key is extracted', () => {
    assert.deepEqual(extractCredential({ apiKey: TOKEN }), { credential: TOKEN });
  });

  test('a malformed Authorization header is rejected', () => {
    for (const bad of [
      TOKEN, // no scheme
      `Basic ${TOKEN}`, // wrong scheme
      'Bearer', // scheme with no token
      'Bearer ', // scheme with empty token
      `Token ${TOKEN}`,
      `Bearer;${TOKEN}`,
    ]) {
      const result = extractCredential({ authorization: bad });
      assert.ok('failure' in result, `"${bad}" should not yield a credential`);
      assert.equal(result.failure, 'malformed_credentials');
    }
  });

  test('conflicting credentials in the two headers are REJECTED', () => {
    // Not resolved by precedence: two different identities in one request is
    // ambiguous, and silently choosing one hides the other from any log that
    // records only the chosen header.
    assert.deepEqual(
      extractCredential({ authorization: `Bearer ${TOKEN}`, apiKey: WRONG }),
      { failure: 'conflicting_credentials' },
    );
  });

  test('identical credentials in both headers are accepted', () => {
    // A proxy copying one header into the other is unambiguous.
    assert.deepEqual(
      extractCredential({ authorization: `Bearer ${TOKEN}`, apiKey: TOKEN }),
      { credential: TOKEN },
    );
  });

  test('a conflict is detected even when neither value is correct', () => {
    // Ambiguity is rejected before validity is considered.
    assert.deepEqual(
      extractCredential({ authorization: 'Bearer aaaa', apiKey: 'bbbb' }),
      { failure: 'conflicting_credentials' },
    );
  });
});

// ---------------------------------------------------------------------------
// THE DECISION FUNCTION
// ---------------------------------------------------------------------------

describe('auth — request decisions', () => {
  const decide = (extra: Record<string, string | undefined> = {}, path = '/api/payments') =>
    authenticateRequest({ path, expectedToken: TOKEN, ...extra });

  test('the correct bearer token succeeds', () => {
    assert.equal(decide({ authorization: `Bearer ${TOKEN}` }).ok, true);
  });

  test('the correct x-api-key succeeds', () => {
    assert.equal(decide({ apiKey: TOKEN }).ok, true);
  });

  test('a wrong bearer token fails', () => {
    const outcome = decide({ authorization: `Bearer ${WRONG}` });
    assert.equal(outcome.ok, false);
    assert.equal(outcome.failure, 'invalid_credentials');
  });

  test('a wrong x-api-key fails', () => {
    assert.equal(decide({ apiKey: WRONG }).ok, false);
  });

  test('no credentials fails', () => {
    assert.equal(decide().ok, false);
    assert.equal(decide().failure, 'missing_credentials');
  });

  test('an empty Bearer token fails', () => {
    assert.equal(decide({ authorization: 'Bearer ' }).ok, false);
  });

  test('FAIL CLOSED: an undefined expected token rejects everything', () => {
    // If a configuration path ever produced enabled-without-a-token, the hook
    // must deny rather than accept every caller.
    assert.equal(
      authenticateRequest({
        path: '/api/payments',
        expectedToken: undefined,
        authorization: `Bearer ${TOKEN}`,
      }).ok,
      false,
    );
    assert.equal(
      authenticateRequest({ path: '/api/payments', expectedToken: '', apiKey: TOKEN }).ok,
      false,
    );
  });
});

describe('auth — the public path', () => {
  test('/api/health is public', () => {
    assert.equal(isPublicPath('/api/health'), true);
  });

  test('health is reachable with no credentials even when auth is enabled', () => {
    assert.equal(
      authenticateRequest({ path: '/api/health', expectedToken: TOKEN }).ok,
      true,
    );
  });

  test('health remains public with a query string', () => {
    assert.equal(isPublicPath('/api/health?verbose=1'), true);
  });

  test('no other route is public', () => {
    for (const path of [
      '/api/payments',
      '/api/payments/pay_1',
      '/api/recovery/analyze',
      '/api/recovery/cases',
      '/api/recovery/rc_1/execute',
      '/api/recovery/rc_1/verify',
      '/api/recovery/rc_1/actions',
    ]) {
      assert.equal(isPublicPath(path), false, `${path} must not be public`);
    }
  });

  test('a path that merely contains the health prefix is NOT public', () => {
    // Guards against a substring match turning an unrelated route public.
    for (const path of [
      '/api/healthz',
      '/api/health/secret',
      '/api/healthcheck',
      '/api/payments?next=/api/health',
    ]) {
      assert.equal(isPublicPath(path), false, `${path} must not be public`);
    }
  });
});
