import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.ts';
import { loadConfig } from '../src/config/index.ts';
import { MockAIProvider } from '../src/agents/diagnosis/providers/mock.ts';
import { MockRecoveryProvider } from '../src/payments/providers/mock.ts';

/**
 * AUTHENTICATION AT THE HTTP BOUNDARY
 *
 * Exercises the real Fastify app through app.inject(), so the onRequest hook,
 * the route table, and the reply shape are all genuinely under test.
 *
 * No database is required: every assertion here is about whether a request is
 * ADMITTED, which is decided before any handler — and therefore before any
 * repository call — runs. Routes that would need a database are asserted only
 * on their 401, never on their success body.
 *
 * All credentials are fake and hardcoded. Nothing reads .env.
 */

const TOKEN = 'integration-token-0123456789abcdef';
const WRONG = 'integration-token-0123456789ABCDEF';

/** Config is injected rather than set via process.env, which would leak. */
function authConfig(enabled: boolean) {
  return loadConfig(
    enabled ? { AUTH_ENABLED: 'true', API_AUTH_TOKEN: TOKEN } : { AUTH_ENABLED: 'false' },
  );
}

/** Every route the API exposes, except the deliberately public health check. */
const PROTECTED_ROUTES: { method: 'GET' | 'POST'; url: string }[] = [
  { method: 'POST', url: '/api/payments' },
  { method: 'GET', url: '/api/payments' },
  { method: 'GET', url: '/api/payments/pay_auth_1' },
  { method: 'POST', url: '/api/recovery/analyze' },
  { method: 'GET', url: '/api/recovery/cases' },
  { method: 'POST', url: '/api/recovery/rc_auth_1/execute' },
  { method: 'POST', url: '/api/recovery/rc_auth_1/verify' },
  { method: 'GET', url: '/api/recovery/rc_auth_1/actions' },
];

describe('auth HTTP — enabled', () => {
  let app: FastifyInstance;

  before(async () => {
    app = await buildApp({
      config: authConfig(true),
      provider: new MockAIProvider(),
      recoveryProvider: new MockRecoveryProvider(),
    });
    await app.ready();
  });

  after(async () => {
    await app?.close();
  });

  test('every protected route returns 401 without credentials', async () => {
    for (const route of PROTECTED_ROUTES) {
      const response = await app.inject({ method: route.method, url: route.url });
      assert.equal(
        response.statusCode,
        401,
        `${route.method} ${route.url} was reachable without credentials`,
      );
    }
  });

  test('the money-moving execute route is protected', async () => {
    // Called out separately because it is the one endpoint that can cause an
    // external financial effect.
    const response = await app.inject({
      method: 'POST',
      url: '/api/recovery/rc_auth_1/execute',
    });
    assert.equal(response.statusCode, 401);
  });

  test('a wrong bearer token returns 401', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/payments',
      headers: { authorization: `Bearer ${WRONG}` },
    });
    assert.equal(response.statusCode, 401);
  });

  test('a wrong x-api-key returns 401', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/payments',
      headers: { 'x-api-key': WRONG },
    });
    assert.equal(response.statusCode, 401);
  });

  test('a malformed Authorization header returns 401', async () => {
    for (const bad of [TOKEN, `Basic ${TOKEN}`, 'Bearer', `Token ${TOKEN}`]) {
      const response = await app.inject({
        method: 'GET',
        url: '/api/payments',
        headers: { authorization: bad },
      });
      assert.equal(response.statusCode, 401, `"${bad}" was accepted`);
    }
  });

  test('an empty Bearer token returns 401', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/payments',
      headers: { authorization: 'Bearer ' },
    });
    assert.equal(response.statusCode, 401);
  });

  test('conflicting Authorization and x-api-key credentials are rejected', async () => {
    // Even though the bearer token is CORRECT: the request is ambiguous.
    const response = await app.inject({
      method: 'GET',
      url: '/api/payments',
      headers: { authorization: `Bearer ${TOKEN}`, 'x-api-key': WRONG },
    });
    assert.equal(response.statusCode, 401);
  });

  test('a correct bearer token is admitted past authentication', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/payments?merchant_id=m_auth',
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    // Admitted: the handler ran. It may still fail for want of a database,
    // but it must not be a 401.
    assert.notEqual(response.statusCode, 401);
  });

  test('a correct x-api-key is admitted past authentication', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/payments?merchant_id=m_auth',
      headers: { 'x-api-key': TOKEN },
    });
    assert.notEqual(response.statusCode, 401);
  });

  test('a 401 carries a WWW-Authenticate challenge', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/payments' });
    assert.match(response.headers['www-authenticate'] as string, /^Bearer /);
  });

  test('every failure mode returns an identical body', async () => {
    // Distinguishing "malformed" from "invalid" in the response would tell a
    // prober whether they had the right shape — a search-narrowing signal.
    const bodies = new Set<string>();
    for (const headers of [
      {},
      { authorization: `Bearer ${WRONG}` },
      { authorization: 'Bearer ' },
      { authorization: `Basic ${TOKEN}` },
      { 'x-api-key': WRONG },
      { authorization: `Bearer ${TOKEN}`, 'x-api-key': WRONG },
    ]) {
      const response = await app.inject({ method: 'GET', url: '/api/payments', headers });
      assert.equal(response.statusCode, 401);
      bodies.add(response.body);
    }
    assert.equal(bodies.size, 1, 'failure responses are distinguishable from one another');
  });
});

describe('auth HTTP — the health endpoint stays public', () => {
  let app: FastifyInstance;

  before(async () => {
    app = await buildApp({ config: authConfig(true), provider: new MockAIProvider() });
    await app.ready();
  });

  after(async () => {
    await app?.close();
  });

  test('health is reachable with no credentials while auth is enabled', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/health' });
    // 200 with a database, 503 without one. Never 401.
    assert.notEqual(response.statusCode, 401);
    assert.ok([200, 503].includes(response.statusCode));
  });

  test('the health response reports auth as enabled without the token', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/health' });
    const body = JSON.parse(response.body) as {
      config: { auth: { enabled: boolean; credentialPresent: boolean } };
    };
    assert.equal(body.config.auth.enabled, true);
    assert.equal(body.config.auth.credentialPresent, true);
    assert.ok(!response.body.includes(TOKEN), 'health leaked the token');
  });
});

describe('auth HTTP — no credential ever reaches a response', () => {
  let app: FastifyInstance;

  before(async () => {
    app = await buildApp({ config: authConfig(true), provider: new MockAIProvider() });
    await app.ready();
  });

  after(async () => {
    await app?.close();
  });

  test('a 401 body never contains the expected token', async () => {
    for (const headers of [{}, { authorization: `Bearer ${WRONG}` }, { 'x-api-key': WRONG }]) {
      const response = await app.inject({ method: 'GET', url: '/api/payments', headers });
      assert.ok(!response.body.includes(TOKEN), 'the configured token leaked into a 401');
    }
  });

  test('a 401 body never echoes the SUPPLIED credential', async () => {
    // Reflecting attacker-controlled input is both an XSS vector and a way to
    // confirm which of several tried values was sent.
    const supplied = 'supplied-credential-marker-9999';
    for (const headers of [
      { authorization: `Bearer ${supplied}` },
      { 'x-api-key': supplied },
      { authorization: supplied },
    ]) {
      const response = await app.inject({ method: 'GET', url: '/api/payments', headers });
      assert.ok(!response.body.includes(supplied), 'the supplied credential was echoed');
    }
  });

  test('no serialized response mentions the token env var name or value', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/health' });
    assert.ok(!response.body.includes('API_AUTH_TOKEN'));
    assert.ok(!response.body.includes(TOKEN));
  });
});

describe('auth HTTP — disabled preserves existing behaviour', () => {
  let app: FastifyInstance;

  before(async () => {
    app = await buildApp({
      config: authConfig(false),
      provider: new MockAIProvider(),
      recoveryProvider: new MockRecoveryProvider(),
    });
    await app.ready();
  });

  after(async () => {
    await app?.close();
  });

  test('protected routes are reachable with no credentials', async () => {
    for (const route of PROTECTED_ROUTES) {
      const response = await app.inject({ method: route.method, url: route.url });
      assert.notEqual(
        response.statusCode,
        401,
        `${route.method} ${route.url} returned 401 while auth is disabled`,
      );
    }
  });

  test('health remains reachable', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/health' });
    assert.notEqual(response.statusCode, 401);
  });

  test('health reports auth as disabled', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/health' });
    const body = JSON.parse(response.body) as { config: { auth: { enabled: boolean } } };
    assert.equal(body.config.auth.enabled, false);
  });
});

describe('auth HTTP — authentication runs BEFORE the handler', () => {
  test('an unauthenticated request never reaches the route handler', async () => {
    // The load-bearing property: if the handler ran, a repository call or a
    // provider call could already have happened before the 401 was written.
    let executeCalled = false;
    const provider = new MockRecoveryProvider();
    const originalExecute = provider.executeAction.bind(provider);
    provider.executeAction = async (request) => {
      executeCalled = true;
      return originalExecute(request);
    };

    const app = await buildApp({
      config: authConfig(true),
      provider: new MockAIProvider(),
      recoveryProvider: provider,
    });
    await app.ready();

    const response = await app.inject({
      method: 'POST',
      url: '/api/recovery/rc_auth_before/execute',
    });

    assert.equal(response.statusCode, 401);
    assert.equal(executeCalled, false, 'the executor was reached by an unauthenticated request');
    await app.close();
  });

  test('an unauthenticated request is rejected before body validation', async () => {
    // A body that would fail schema validation must still produce 401, not
    // 400: reaching validation means the request got past authentication.
    const app = await buildApp({ config: authConfig(true), provider: new MockAIProvider() });
    await app.ready();

    const response = await app.inject({
      method: 'POST',
      url: '/api/payments',
      payload: { nonsense: true },
    });

    assert.equal(response.statusCode, 401, 'validation ran before authentication');
    await app.close();
  });

  test('an unauthenticated request to an unknown path is rejected, not 404', async () => {
    // A 404 would confirm which paths exist to an unauthenticated caller.
    const app = await buildApp({ config: authConfig(true), provider: new MockAIProvider() });
    await app.ready();

    const response = await app.inject({ method: 'GET', url: '/api/does-not-exist' });
    assert.equal(response.statusCode, 401);
    await app.close();
  });
});

describe('auth HTTP — authentication is not authorization', () => {
  test('a valid token does not make the app skip policy authorization', async () => {
    // Asserted structurally at the route layer: the execute route must still
    // go through the execute service, which consults the policy engine. A
    // token cannot short-circuit that path.
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join } = await import('node:path');
    const src = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');

    const recoveryRoutes = readFileSync(join(src, 'api', 'recovery.ts'), 'utf8');
    assert.ok(
      /executeRecoveryCase/.test(recoveryRoutes),
      'the execute route no longer delegates to the execute service',
    );
    // The route must not consult authentication when deciding what to execute.
    assert.ok(
      !/authenticateRequest|isPublicPath|API_AUTH_TOKEN/.test(recoveryRoutes),
      'a route makes an execution decision based on authentication',
    );
  });
});
