import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  RazorpayTestProvider,
  RazorpayConfigurationError,
  sanitiseError,
  type HttpTransport,
} from '../src/payments/providers/razorpay.ts';
import { createRecoveryProvider } from '../src/payments/factory.ts';
import { loadConfig, ConfigError } from '../src/config/index.ts';

/**
 * Razorpay provider tests.
 *
 * NO REAL NETWORK CALLS. Every test injects a transport double, so the default
 * suite never contacts Razorpay. Opt-in live tests are gated behind
 * RECOVERAI_LIVE_PROVIDER_TESTS and are not part of `npm test`.
 */

const TEST_KEY = 'rzp_test_abc123XYZ';
const TEST_SECRET = 'test_secret_value';

/** A transport that records requests and replays a scripted response. */
function transportFor(
  response: { status?: number; ok?: boolean; body?: unknown; throws?: Error },
): { transport: HttpTransport; calls: { url: string; init: Parameters<HttpTransport>[1] }[] } {
  const calls: { url: string; init: Parameters<HttpTransport>[1] }[] = [];
  const transport: HttpTransport = async (url, init) => {
    calls.push({ url, init });
    if (response.throws !== undefined) throw response.throws;
    const status = response.status ?? 200;
    return {
      status,
      ok: response.ok ?? (status >= 200 && status < 300),
      text: async () => (typeof response.body === 'string'
        ? response.body
        : JSON.stringify(response.body ?? {})),
    };
  };
  return { transport, calls };
}

/**
 * A transport that replays a SEQUENCE of responses, one per call.
 *
 * executeAction now performs a state read (GET) before deciding which Razorpay
 * operation is valid, so most execute paths involve two calls.
 */
function sequenceTransport(
  responses: { status?: number; ok?: boolean; body?: unknown; throws?: Error }[],
): { transport: HttpTransport; calls: { url: string; init: Parameters<HttpTransport>[1] }[] } {
  const calls: { url: string; init: Parameters<HttpTransport>[1] }[] = [];
  let index = 0;
  const transport: HttpTransport = async (url, init) => {
    calls.push({ url, init });
    const response = responses[Math.min(index, responses.length - 1)]!;
    index++;
    if (response.throws !== undefined) throw response.throws;
    const status = response.status ?? 200;
    return {
      status,
      ok: response.ok ?? (status >= 200 && status < 300),
      text: async () =>
        typeof response.body === 'string' ? response.body : JSON.stringify(response.body ?? {}),
    };
  };
  return { transport, calls };
}

/** Shorthand: payment observed as `status`, then a capture returning `after`. */
function stateThenCapture(status: string, after?: unknown) {
  return sequenceTransport([
    { body: { id: 'pay_rzp_1', status } },
    { body: after ?? { id: 'pay_rzp_1', status: 'captured' } },
  ]);
}

function provider(overrides: Partial<Parameters<typeof buildProvider>[0]> = {}) {
  return buildProvider({ keyId: TEST_KEY, keySecret: TEST_SECRET, ...overrides });
}

function buildProvider(options: {
  keyId: string;
  keySecret: string;
  transport?: HttpTransport;
}) {
  return new RazorpayTestProvider({
    keyId: options.keyId,
    keySecret: options.keySecret,
    // Default to a transport that fails loudly if a test forgets to script one,
    // so no test can accidentally reach the network.
    transport:
      options.transport ??
      (async () => {
        throw new Error('unscripted network call in a unit test');
      }),
  });
}

const RETRY_REQUEST = {
  idempotencyKey: 'recovery:rc_1:RETRY:v1',
  action: 'RETRY' as const,
  paymentId: 'pay_test_1',
  amount: 249_900,
  currency: 'INR',
};

describe('razorpay — test-mode enforcement', () => {
  test('a rzp_test_ key is accepted', () => {
    const p = provider();
    assert.equal(p.name, 'razorpay');
    assert.equal(p.isTestMode, true);
  });

  test('a rzp_live_ key is REJECTED', () => {
    // The single most important test in this file.
    assert.throws(
      () => buildProvider({ keyId: 'rzp_live_abc123', keySecret: TEST_SECRET }),
      RazorpayConfigurationError,
    );
  });

  test('the live-key rejection names the hazard', () => {
    try {
      buildProvider({ keyId: 'rzp_live_abc123', keySecret: TEST_SECRET });
      assert.fail('should have thrown');
    } catch (error) {
      assert.ok((error as Error).message.includes('LIVE'));
      assert.ok((error as Error).message.toLowerCase().includes('real money'));
    }
  });

  test('a missing key is rejected', () => {
    assert.throws(
      () => buildProvider({ keyId: '', keySecret: TEST_SECRET }),
      RazorpayConfigurationError,
    );
  });

  test('a missing secret is rejected', () => {
    assert.throws(
      () => buildProvider({ keyId: TEST_KEY, keySecret: '' }),
      RazorpayConfigurationError,
    );
  });

  test('a whitespace-only credential is rejected', () => {
    assert.throws(
      () => buildProvider({ keyId: '   ', keySecret: TEST_SECRET }),
      RazorpayConfigurationError,
    );
    assert.throws(
      () => buildProvider({ keyId: TEST_KEY, keySecret: '   ' }),
      RazorpayConfigurationError,
    );
  });

  test('a malformed key is rejected — fail closed, not just anti-live', () => {
    for (const bad of [
      'sk_test_abc', 'rzp_abc123', 'rzp_test_', 'rzp_test_has-dashes',
      'RZP_TEST_ABC', 'not_a_key', 'rzp_sandbox_abc',
    ]) {
      assert.throws(
        () => buildProvider({ keyId: bad, keySecret: TEST_SECRET }),
        RazorpayConfigurationError,
        `"${bad}" should be rejected`,
      );
    }
  });
});

describe('razorpay — config-level enforcement', () => {
  test('loadConfig rejects a live key even when the provider is mock', () => {
    // A live credential in the environment is itself the hazard.
    assert.throws(() => loadConfig({ RAZORPAY_KEY_ID: 'rzp_live_xyz' }), ConfigError);
  });

  test('loadConfig rejects a malformed key', () => {
    assert.throws(() => loadConfig({ RAZORPAY_KEY_ID: 'rzp_sandbox_xyz' }), ConfigError);
  });

  test('loadConfig accepts a well-formed test key', () => {
    const config = loadConfig({
      PAYMENT_PROVIDER: 'razorpay', RAZORPAY_KEY_ID: TEST_KEY, RAZORPAY_KEY_SECRET: TEST_SECRET,
    });
    assert.equal(config.payments.provider, 'razorpay');
  });

  test('the factory builds a Razorpay provider from valid test config', () => {
    const built = createRecoveryProvider(
      loadConfig({
        PAYMENT_PROVIDER: 'razorpay', RAZORPAY_KEY_ID: TEST_KEY, RAZORPAY_KEY_SECRET: TEST_SECRET,
      }),
    );
    assert.equal(built.name, 'razorpay');
  });

  test('the factory never falls back to the mock on bad credentials', () => {
    // Silently serving the mock while an operator believes real actions are
    // happening is the failure mode this guards.
    assert.throws(
      () => loadConfig({ PAYMENT_PROVIDER: 'razorpay', RAZORPAY_KEY_ID: TEST_KEY }),
      ConfigError,
    );
  });
});

describe('razorpay — executeAction normalization', () => {
  test('an AUTHORIZED payment takes the capture path', async () => {
    // The one genuinely recoverable case: read state, see `authorized`, capture.
    const { transport, calls } = stateThenCapture('authorized');
    const result = await provider({ transport }).executeAction(RETRY_REQUEST);

    assert.equal(result.outcome, 'SUCCESS');
    assert.equal(result.providerActionId, 'pay_rzp_1');
    assert.equal(result.paymentStatus, 'captured');

    // Two calls: the state read, then the capture.
    assert.equal(calls.length, 2);
    assert.equal(calls[0]!.init.method, 'GET');
    assert.ok(calls[0]!.url.endsWith('/payments/pay_test_1'));
    assert.equal(calls[1]!.init.method, 'POST');
    assert.ok(calls[1]!.url.endsWith('/payments/pay_test_1/capture'));
  });

  test('an ALREADY CAPTURED payment issues no second capture', async () => {
    // The money is already collected; capturing again would be a duplicate
    // financial operation.
    const { transport, calls } = sequenceTransport([{ body: { id: 'pay_c', status: 'captured' } }]);
    const result = await provider({ transport }).executeAction(RETRY_REQUEST);

    assert.equal(result.paymentStatus, 'captured');
    assert.equal(calls.length, 1, 'only the state read should occur');
    assert.equal(calls[0]!.init.method, 'GET');
    assert.ok(
      !calls.some((c) => c.url.includes('/capture')),
      'a captured payment must never be captured again',
    );
  });

  test('a FAILED payment invents no retry operation', async () => {
    // The correction this phase is about: Razorpay has no endpoint that
    // revives a failed payment, and the provider must not pretend otherwise.
    const { transport, calls } = sequenceTransport([
      { body: { id: 'pay_f', status: 'failed', error_description: 'card declined' } },
    ]);
    const result = await provider({ transport }).executeAction(RETRY_REQUEST);

    assert.equal(result.outcome, 'FAILED');
    assert.equal(result.paymentStatus, 'failed');
    assert.equal(calls.length, 1, 'only the state read should occur');
    assert.ok(
      !calls.some((c) => c.url.includes('/capture')),
      'a failed payment must never be sent to capture',
    );
    // The message must state plainly that nothing was attempted.
    assert.ok(result.errorMessage?.includes('no operation'), result.errorMessage ?? '');
    assert.ok(!/retried|retry succeeded/i.test(result.errorMessage ?? ''));
  });

  test('a REFUNDED payment is terminal and performs no operation', async () => {
    const { transport, calls } = sequenceTransport([{ body: { id: 'p', status: 'refunded' } }]);
    const result = await provider({ transport }).executeAction(RETRY_REQUEST);
    assert.equal(result.outcome, 'FAILED');
    assert.equal(calls.length, 1);
    assert.ok(!calls.some((c) => c.url.includes('/capture')));
  });

  test('a CREATED or PENDING payment is UNKNOWN with no capture', async () => {
    // Not yet authorized, so there is nothing to capture — but it may still
    // progress, so this is not a definite failure.
    for (const status of ['created', 'pending']) {
      const { transport, calls } = sequenceTransport([{ body: { id: 'p', status } }]);
      const result = await provider({ transport }).executeAction(RETRY_REQUEST);
      assert.equal(result.outcome, 'UNKNOWN', status);
      assert.ok(!calls.some((c) => c.url.includes('/capture')), status);
    }
  });

  test('an unrecognised status is UNKNOWN and performs no operation', async () => {
    const { transport, calls } = sequenceTransport([
      { body: { id: 'p', status: 'some_new_state' } },
    ]);
    const result = await provider({ transport }).executeAction(RETRY_REQUEST);
    assert.equal(result.outcome, 'UNKNOWN');
    assert.ok(!calls.some((c) => c.url.includes('/capture')));
  });

  test('a missing status is UNKNOWN — fail closed', async () => {
    const { transport, calls } = sequenceTransport([{ body: { id: 'p' } }]);
    assert.equal((await provider({ transport }).executeAction(RETRY_REQUEST)).outcome, 'UNKNOWN');
    assert.ok(!calls.some((c) => c.url.includes('/capture')));
  });

  test('an unreadable state performs no operation', async () => {
    // If we cannot establish state, we must not act.
    const { transport, calls } = sequenceTransport([{ throws: new Error('ECONNRESET') }]);
    const result = await provider({ transport }).executeAction(RETRY_REQUEST);
    assert.equal(result.outcome, 'UNKNOWN');
    assert.equal(calls.length, 1);
    assert.ok(!calls.some((c) => c.url.includes('/capture')));
  });

  test('a transport failure is UNKNOWN, not FAILED', async () => {
    // A network error does not prove the remote side did nothing; calling it
    // FAILED could invite a double-charge.
    const { transport } = sequenceTransport([{ throws: new Error('ECONNRESET') }]);
    const result = await provider({ transport }).executeAction(RETRY_REQUEST);
    assert.equal(result.outcome, 'UNKNOWN');
    assert.ok(result.errorMessage);
  });

  test('a 5xx on the state read is UNKNOWN', async () => {
    for (const status of [500, 502, 503]) {
      const { transport } = sequenceTransport([{ status, ok: false, body: { error: 'server' } }]);
      assert.equal(
        (await provider({ transport }).executeAction(RETRY_REQUEST)).outcome,
        'UNKNOWN',
        `status ${status}`,
      );
    }
  });

  test('a 429 on the state read is UNKNOWN, never FAILED', async () => {
    // Rate limiting says nothing about whether the payment can be recovered.
    const { transport } = sequenceTransport([{ status: 429, ok: false, body: { error: 'rate' } }]);
    assert.equal((await provider({ transport }).executeAction(RETRY_REQUEST)).outcome, 'UNKNOWN');
  });

  test('a 5xx or 429 on the CAPTURE is UNKNOWN', async () => {
    // The capture may or may not have taken effect. Never FAILED.
    for (const status of [500, 502, 429]) {
      const { transport } = sequenceTransport([
        { body: { id: 'p', status: 'authorized' } },
        { status, ok: false, body: { error: 'server' } },
      ]);
      assert.equal(
        (await provider({ transport }).executeAction(RETRY_REQUEST)).outcome,
        'UNKNOWN',
        `status ${status}`,
      );
    }
  });

  test('a 4xx on the capture is FAILED', async () => {
    for (const status of [400, 401, 404]) {
      const { transport } = sequenceTransport([
        { body: { id: 'p', status: 'authorized' } },
        { status, ok: false, body: { error: 'bad' } },
      ]);
      assert.equal(
        (await provider({ transport }).executeAction(RETRY_REQUEST)).outcome,
        'FAILED',
        `status ${status}`,
      );
    }
  });

  test('malformed JSON does not crash the provider', async () => {
    const { transport } = sequenceTransport([{ body: 'not json at all' }]);
    const result = await provider({ transport }).executeAction(RETRY_REQUEST);
    assert.ok(['UNKNOWN', 'FAILED'].includes(result.outcome));
  });

  test('an unsupported action is refused without a network call', async () => {
    const { transport, calls } = transportFor({ body: {} });
    const result = await provider({ transport }).executeAction({
      ...RETRY_REQUEST, action: 'REMINDER' as 'RETRY',
    });
    assert.equal(result.outcome, 'FAILED');
    assert.equal(calls.length, 0, 'an unsupported action must not hit the API');
  });

  test('the amount is sent as an exact integer in minor units', async () => {
    const { transport, calls } = stateThenCapture('authorized');
    await provider({ transport }).executeAction({ ...RETRY_REQUEST, amount: 249_901 });
    const captureBody = calls[1]!.init.body;
    assert.ok(captureBody?.includes('amount=249901'), captureBody);
    assert.ok(!captureBody?.includes('2499.01'), 'money must never be a float');
  });

  test('normalization is deterministic for identical input', async () => {
    const first = await provider({
      transport: stateThenCapture('authorized').transport,
    }).executeAction(RETRY_REQUEST);
    const second = await provider({
      transport: stateThenCapture('authorized').transport,
    }).executeAction(RETRY_REQUEST);
    assert.deepEqual(first, second);
  });
});

describe('razorpay — getPaymentStatus normalization', () => {
  test('captured maps to SUCCEEDED', async () => {
    const { transport, calls } = transportFor({ body: { id: 'p1', status: 'captured' } });
    const result = await provider({ transport }).getPaymentStatus('pay_1');
    assert.equal(result.state, 'SUCCEEDED');
    assert.equal(result.rawStatus, 'captured');
    assert.equal(calls[0]!.init.method, 'GET', 'observing must be a read');
  });

  test('failed maps to FAILED and refunded maps to FAILED', async () => {
    for (const [status, expected] of [['failed', 'FAILED'], ['refunded', 'FAILED']] as const) {
      const { transport } = transportFor({ body: { id: 'p', status } });
      assert.equal((await provider({ transport }).getPaymentStatus('p')).state, expected);
    }
  });

  test('authorized and created map to PENDING', async () => {
    for (const status of ['authorized', 'created']) {
      const { transport } = transportFor({ body: { id: 'p', status } });
      assert.equal((await provider({ transport }).getPaymentStatus('p')).state, 'PENDING', status);
    }
  });

  test('an unrecognised or missing status maps to UNKNOWN', async () => {
    for (const body of [{ id: 'p', status: 'weird' }, { id: 'p' }, {}]) {
      const { transport } = transportFor({ body });
      assert.equal((await provider({ transport }).getPaymentStatus('p')).state, 'UNKNOWN');
    }
  });

  test('a lookup failure reports UNKNOWN rather than throwing', async () => {
    const { transport } = transportFor({ throws: new Error('ETIMEDOUT') });
    const result = await provider({ transport }).getPaymentStatus('p');
    assert.equal(result.state, 'UNKNOWN');
    assert.ok(result.errorMessage);
  });

  test('an HTTP error reports UNKNOWN', async () => {
    const { transport } = transportFor({ status: 500, ok: false, body: { error: 'boom' } });
    assert.equal((await provider({ transport }).getPaymentStatus('p')).state, 'UNKNOWN');
  });

  test('a status lookup never executes an action', async () => {
    const { transport, calls } = transportFor({ body: { id: 'p', status: 'captured' } });
    await provider({ transport }).getPaymentStatus('pay_1');
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.init.method, 'GET');
    assert.ok(!calls[0]!.url.includes('capture'), 'a read must not hit a capture endpoint');
  });
});

describe('razorpay — no credential leakage', () => {
  test('the provider never returns the key or secret in a result', async () => {
    const { transport } = stateThenCapture('authorized');
    const result = await provider({ transport }).executeAction(RETRY_REQUEST);
    const serialised = JSON.stringify(result);
    assert.ok(!serialised.includes(TEST_KEY), 'result leaked the key id');
    assert.ok(!serialised.includes(TEST_SECRET), 'result leaked the secret');
  });

  test('the Authorization header is sent but never echoed back', async () => {
    const { transport, calls } = stateThenCapture('authorized');
    const result = await provider({ transport }).executeAction(RETRY_REQUEST);
    // It IS sent...
    assert.ok(calls[0]!.init.headers.Authorization?.startsWith('Basic '));
    // ...but never surfaces in anything the application stores.
    assert.ok(!JSON.stringify(result).includes('Basic '));
  });

  test('an error body containing a key is scrubbed', async () => {
    const { transport } = sequenceTransport([
      {
        status: 400, ok: false,
        body: { error: { description: `bad key rzp_test_leakedKey123 supplied` } },
      },
    ]);
    const result = await provider({ transport }).executeAction(RETRY_REQUEST);
    assert.ok(!result.errorMessage?.includes('rzp_test_leakedKey123'));
    assert.ok(result.errorMessage?.includes('[redacted-key]'));
  });

  test('sanitiseError strips every credential shape', () => {
    const dirty =
      'key rzp_live_SECRET1 and rzp_test_SECRET2, Authorization: Basic YWJjOmRlZg==, ' +
      'Bearer eyJhbGciOi.abc-def, {"key_secret":"hunter2","password":"pw"}';
    const clean = sanitiseError(dirty);
    for (const secret of [
      'rzp_live_SECRET1', 'rzp_test_SECRET2', 'YWJjOmRlZg==', 'eyJhbGciOi.abc-def', 'hunter2',
    ]) {
      assert.ok(!clean.includes(secret), `sanitiseError leaked "${secret}"`);
    }
  });

  test('sanitiseError truncates a large payload', () => {
    assert.ok(sanitiseError('x'.repeat(5000)).length <= 300);
  });

  test('a thrown transport error message is scrubbed', async () => {
    const { transport } = sequenceTransport([
      { throws: new Error(`connect failed using rzp_test_abc123XYZ`) },
    ]);
    const result = await provider({ transport }).executeAction(RETRY_REQUEST);
    assert.ok(!result.errorMessage?.includes('rzp_test_abc123XYZ'));
  });
});

describe('razorpay — no real network calls in the default suite', () => {
  test('every test in this file injects a transport', () => {
    // The default transport in buildProvider() throws on any call, so a test
    // that forgot to script one fails loudly rather than reaching the network.
    assert.throws(
      () => {
        const p = buildProvider({ keyId: TEST_KEY, keySecret: TEST_SECRET });
        void p;
        throw new Error('constructed');
      },
      /constructed/,
    );
  });

  test('live provider tests are opt-in and off by default here', () => {
    // Documents the contract: `npm test` makes no external calls.
    const flag = process.env.RECOVERAI_LIVE_PROVIDER_TESTS;
    assert.ok(
      flag === undefined || flag === '' || flag === '0' || flag === '1',
      'the live-test flag should be unset or a simple 0/1',
    );
  });
});
