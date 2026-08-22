import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { verifyOutcome, canTransition } from '../src/recovery/verifier.ts';
import type { VerificationInput } from '../src/recovery/verification-types.ts';
import { VERIFICATION_STATUSES } from '../src/shared/types.ts';
import { MockRecoveryProvider } from '../src/payments/providers/mock.ts';
import { OBSERVED_PAYMENT_STATES } from '../src/payments/provider.ts';

const NOW = new Date('2026-08-22T12:00:00.000Z');

function input(overrides: Partial<VerificationInput> = {}): VerificationInput {
  return {
    paymentId: 'pay_v',
    executionStatus: 'SUCCESS',
    observedState: 'SUCCEEDED',
    observedRawStatus: 'captured',
    observedReference: 'ref_1',
    observationError: null,
    // Default to a stored record that does NOT contradict the observation.
    // The contradiction case is exercised explicitly below.
    storedPaymentStatus: 'captured',
    now: NOW,
    ...overrides,
  };
}

const verify = (o: Partial<VerificationInput> = {}) => verifyOutcome(input(o));

describe('verifier — the core rule: execution is not outcome', () => {
  test('execution SUCCESS alone does not produce VERIFIED', () => {
    // The whole point of this layer: a provider acknowledgement proves nothing
    // about the money. Without a payment observation, we stay unconfirmed.
    const result = verify({ executionStatus: 'SUCCESS', observedState: null });
    assert.equal(result.status, 'UNCONFIRMED');
    assert.equal(result.recovered, false);
  });

  test('SUCCESS + observed SUCCEEDED yields VERIFIED', () => {
    const result = verify({ executionStatus: 'SUCCESS', observedState: 'SUCCEEDED' });
    assert.equal(result.status, 'VERIFIED');
    assert.equal(result.recovered, true);
  });

  test('SUCCESS + observed PENDING yields UNCONFIRMED', () => {
    const result = verify({ executionStatus: 'SUCCESS', observedState: 'PENDING' });
    assert.equal(result.status, 'UNCONFIRMED');
    assert.equal(result.recovered, false);
  });

  test('SUCCESS + observed FAILED yields NOT_RECOVERED', () => {
    const result = verify({ executionStatus: 'SUCCESS', observedState: 'FAILED' });
    assert.equal(result.status, 'NOT_RECOVERED');
    assert.equal(result.recovered, false);
  });

  test('SUCCESS + observed UNKNOWN yields UNCONFIRMED', () => {
    const result = verify({ executionStatus: 'SUCCESS', observedState: 'UNKNOWN' });
    assert.equal(result.status, 'UNCONFIRMED');
  });

  test('recovered is true for VERIFIED and false for everything else', () => {
    assert.equal(verify({ observedState: 'SUCCEEDED' }).recovered, true);
    assert.equal(verify({ observedState: 'PENDING' }).recovered, false);
    assert.equal(verify({ observedState: 'FAILED' }).recovered, false);
    assert.equal(verify({ observedState: 'UNKNOWN' }).recovered, false);
    assert.equal(verify({ executionStatus: 'FAILED' }).recovered, false);
  });
});

describe('verifier — RULE 2: failed execution', () => {
  test('execution FAILED yields NOT_RECOVERED', () => {
    const result = verify({ executionStatus: 'FAILED' });
    assert.equal(result.status, 'NOT_RECOVERED');
    assert.equal(result.recovered, false);
  });

  test('a failed execution is never reported as recovered, whatever is observed', () => {
    // Even a SUCCEEDED payment observation cannot make a rejected request into
    // a recovery by this action — that payment succeeded some other way.
    for (const observed of OBSERVED_PAYMENT_STATES) {
      const result = verify({ executionStatus: 'FAILED', observedState: observed });
      assert.notEqual(result.status, 'VERIFIED', `observed ${observed}`);
      assert.equal(result.recovered, false, `observed ${observed}`);
    }
  });
});

describe('verifier — RULE 1: UNKNOWN resolution', () => {
  test('UNCONFIRMED execution + observed SUCCEEDED resolves to VERIFIED', () => {
    // This is the resolution path: an ambiguous execution whose payment is
    // observably complete WAS a recovery, established without any retry.
    const result = verify({ executionStatus: 'UNCONFIRMED', observedState: 'SUCCEEDED' });
    assert.equal(result.status, 'VERIFIED');
    assert.equal(result.recovered, true);
    assert.ok(result.reason.includes('unconfirmed'), result.reason);
  });

  test('UNCONFIRMED execution + observed PENDING stays UNCONFIRMED', () => {
    const result = verify({ executionStatus: 'UNCONFIRMED', observedState: 'PENDING' });
    assert.equal(result.status, 'UNCONFIRMED');
  });

  test('UNCONFIRMED execution + observed FAILED resolves to NOT_RECOVERED', () => {
    const result = verify({ executionStatus: 'UNCONFIRMED', observedState: 'FAILED' });
    assert.equal(result.status, 'NOT_RECOVERED');
  });

  test('UNCONFIRMED execution + unobservable payment stays UNCONFIRMED', () => {
    const result = verify({
      executionStatus: 'UNCONFIRMED', observedState: 'UNKNOWN',
    });
    assert.equal(result.status, 'UNCONFIRMED');
  });

  test('UNCONFIRMED execution with no observation stays UNCONFIRMED', () => {
    const result = verify({
      executionStatus: 'UNCONFIRMED', observedState: null,
      observationError: 'lookup failed',
    });
    assert.equal(result.status, 'UNCONFIRMED');
  });
});

describe('verifier — RULE 4: fail closed', () => {
  test('an incomplete-evidence case never yields VERIFIED', () => {
    const result = verify({ observedState: null, observationError: 'no response' });
    assert.equal(result.status, 'UNCONFIRMED');
    assert.ok(result.evidence.some((e) => e.type === 'MISSING_EVIDENCE'));
  });

  test('PENDING, EXECUTING and SKIPPED_DUPLICATE executions are unconfirmed', () => {
    // None of these carry a provider verdict, so none can support an outcome.
    for (const status of ['PENDING', 'EXECUTING', 'SKIPPED_DUPLICATE'] as const) {
      const result = verify({ executionStatus: status });
      assert.equal(result.status, 'UNCONFIRMED', status);
      assert.ok(result.evidence.some((e) => e.type === 'MISSING_EVIDENCE'), status);
    }
  });

  test('a stale local record does not block verification', () => {
    // Execution never mutates payment state, so a genuinely recovered payment
    // still reads "failed" locally until verification refreshes it. Treating
    // that lag as a contradiction would block every legitimate recovery.
    const result = verify({
      executionStatus: 'SUCCESS',
      observedState: 'SUCCEEDED',
      storedPaymentStatus: 'failed',
    });
    assert.equal(result.status, 'VERIFIED');
    assert.ok(result.reason.includes('refreshed'), result.reason);
    // The stale value is still recorded as evidence, so the lag is auditable.
    const stored = result.evidence.find((e) => e.type === 'STORED_PAYMENT_STATE');
    assert.equal(stored?.value, 'failed');
  });

  test('a corroborating stored record permits VERIFIED', () => {
    const result = verify({
      executionStatus: 'SUCCESS',
      observedState: 'SUCCEEDED',
      storedPaymentStatus: 'captured',
    });
    assert.equal(result.status, 'VERIFIED');
  });

  test('no input combination ever yields a status outside the enum', () => {
    for (const execStatus of ['PENDING', 'EXECUTING', 'SUCCESS', 'FAILED', 'UNCONFIRMED', 'SKIPPED_DUPLICATE'] as const) {
      for (const observed of [...OBSERVED_PAYMENT_STATES, null]) {
        for (const stored of ['captured', 'failed', 'authorized', null]) {
          const result = verify({
            executionStatus: execStatus, observedState: observed, storedPaymentStatus: stored,
          });
          assert.ok(
            (VERIFICATION_STATUSES as readonly string[]).includes(result.status),
            `${execStatus}/${observed}/${stored} -> ${result.status}`,
          );
        }
      }
    }
  });

  test('there is no "probably recovered" outcome', () => {
    assert.deepEqual([...VERIFICATION_STATUSES], ['VERIFIED', 'NOT_RECOVERED', 'UNCONFIRMED']);
  });
});

describe('verifier — evidence model', () => {
  test('every verdict records the execution result as evidence', () => {
    const result = verify();
    const exec = result.evidence.find((e) => e.type === 'EXECUTION_RESULT');
    assert.ok(exec, 'no execution evidence');
    assert.equal(exec.source, 'PROVIDER_EXECUTION');
    assert.equal(exec.value, 'SUCCESS');
  });

  test('a VERIFIED verdict records both execution and observation', () => {
    const result = verify({ observedState: 'SUCCEEDED', storedPaymentStatus: 'captured' });
    const types = result.evidence.map((e) => e.type);
    assert.ok(types.includes('EXECUTION_RESULT'));
    assert.ok(types.includes('OBSERVED_PAYMENT_STATE'));
    assert.ok(types.includes('STORED_PAYMENT_STATE'));
  });

  test('evidence carries a timestamp and a readable detail', () => {
    for (const item of verify().evidence) {
      assert.equal(item.observedAt, NOW.toISOString());
      assert.ok(item.detail.length > 0, `${item.type} has no detail`);
    }
  });

  test('the reason names the facts, not a guess', () => {
    const verified = verify({ observedState: 'SUCCEEDED', storedPaymentStatus: 'captured' });
    assert.ok(verified.reason.includes('observably completed'), verified.reason);
    const pending = verify({ observedState: 'PENDING' });
    assert.ok(pending.reason.includes('pending'), pending.reason);
  });

  test('evidence contains no secrets', () => {
    const serialised = JSON.stringify(verify().evidence);
    for (const secret of ['rzp_live', 'rzp_test', 'sk-ant-', 'password', 'authorization', 'Bearer']) {
      assert.ok(!serialised.toLowerCase().includes(secret.toLowerCase()), `leaked "${secret}"`);
    }
  });

  test('evidence is a structured array, not a free-text blob', () => {
    const result = verify();
    assert.ok(Array.isArray(result.evidence));
    for (const item of result.evidence) {
      assert.equal(typeof item.type, 'string');
      assert.equal(typeof item.source, 'string');
      assert.equal(typeof item.value, 'string');
    }
  });
});

describe('verifier — determinism and purity', () => {
  test('identical input produces identical output', () => {
    assert.deepEqual(verify(), verify());
  });

  test('repeated evaluation is stable', () => {
    const first = JSON.stringify(verify({ observedState: 'PENDING' }));
    for (let i = 0; i < 25; i++) {
      assert.equal(JSON.stringify(verify({ observedState: 'PENDING' })), first);
    }
  });

  test('the verifier does not mutate its input', () => {
    const original = input();
    const snapshot = JSON.stringify(original);
    verifyOutcome(original);
    assert.equal(JSON.stringify(original), snapshot);
  });

  test('AI confidence is not an input to verification', () => {
    // Structural guarantee: there is nowhere to put it.
    const keys = Object.keys(input());
    for (const forbidden of ['confidence', 'aiConfidence', 'recommendation', 'expectedRecoveryProbability']) {
      assert.ok(!keys.includes(forbidden), `VerificationInput exposes "${forbidden}"`);
    }
  });

  test('verifiedAt comes from the injected clock, not the wall clock', () => {
    const other = new Date('2027-01-01T00:00:00.000Z');
    assert.equal(verify({ now: other }).verifiedAt, other.toISOString());
  });
});

describe('verifier — state machine transitions', () => {
  test('a fresh action accepts any verdict', () => {
    for (const next of VERIFICATION_STATUSES) {
      assert.equal(canTransition(null, next), true, next);
    }
  });

  test('UNCONFIRMED may be revised to anything', () => {
    // This is the resolution path; it must stay open.
    for (const next of VERIFICATION_STATUSES) {
      assert.equal(canTransition('UNCONFIRMED', next), true, next);
    }
  });

  test('VERIFIED never regresses', () => {
    assert.equal(canTransition('VERIFIED', 'UNCONFIRMED'), false);
    assert.equal(canTransition('VERIFIED', 'NOT_RECOVERED'), false);
    // Re-affirming the same verdict is harmless.
    assert.equal(canTransition('VERIFIED', 'VERIFIED'), true);
  });

  test('NOT_RECOVERED never becomes VERIFIED without a new execution', () => {
    assert.equal(canTransition('NOT_RECOVERED', 'VERIFIED'), false);
    assert.equal(canTransition('NOT_RECOVERED', 'UNCONFIRMED'), false);
    assert.equal(canTransition('NOT_RECOVERED', 'NOT_RECOVERED'), true);
  });
});

describe('mock provider — verification support', () => {
  test('getPaymentStatus is deterministic', async () => {
    const provider = new MockRecoveryProvider({ observedState: 'PENDING' });
    const a = await provider.getPaymentStatus('pay_1');
    const b = await provider.getPaymentStatus('pay_1');
    assert.deepEqual(a, b);
    assert.equal(a.state, 'PENDING');
  });

  test('supports every observable state', async () => {
    for (const state of OBSERVED_PAYMENT_STATES) {
      const provider = new MockRecoveryProvider({ observedState: state });
      assert.equal((await provider.getPaymentStatus('p')).state, state);
    }
  });

  test('per-payment overrides let one test hold several payments', async () => {
    const provider = new MockRecoveryProvider({
      observedState: 'PENDING',
      observedStateByPayment: { pay_done: 'SUCCEEDED' },
    });
    assert.equal((await provider.getPaymentStatus('pay_done')).state, 'SUCCEEDED');
    assert.equal((await provider.getPaymentStatus('pay_other')).state, 'PENDING');
  });

  test('the state can change between lookups, simulating settlement', async () => {
    const provider = new MockRecoveryProvider({ observedState: 'PENDING' });
    assert.equal((await provider.getPaymentStatus('p')).state, 'PENDING');
    provider.setObservedState('SUCCEEDED');
    assert.equal((await provider.getPaymentStatus('p')).state, 'SUCCEEDED');
  });

  test('a failed lookup reports UNKNOWN rather than throwing', async () => {
    const provider = new MockRecoveryProvider({ throwOnStatusLookup: true });
    const result = await provider.getPaymentStatus('p');
    assert.equal(result.state, 'UNKNOWN');
    assert.ok(result.errorMessage);
  });

  test('status lookups are counted and never execute an action', async () => {
    const provider = new MockRecoveryProvider();
    await provider.getPaymentStatus('p');
    await provider.getPaymentStatus('p');
    assert.equal(provider.statusLookupCount, 2);
    // The critical assertion: observing never acts.
    assert.equal(provider.callCount, 0, 'a status lookup executed an action');
  });
});
