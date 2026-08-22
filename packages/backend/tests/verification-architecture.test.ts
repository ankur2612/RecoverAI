import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

/**
 * ARCHITECTURAL TESTS FOR THE VERIFICATION BOUNDARY
 *
 * Verification's value is that it answers "what happened?" from evidence, with
 * no ability to influence what happens next. The constraints below enforce that
 * at the import level rather than by convention.
 */

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');

function walk(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, acc);
    else if (entry.endsWith('.ts')) acc.push(full);
  }
  return acc;
}

const VERIFIER = join(SRC, 'recovery', 'verifier.ts');
const verifierSource = readFileSync(VERIFIER, 'utf8');
const serviceSource = readFileSync(join(SRC, 'recovery', 'verify-service.ts'), 'utf8');

describe('verification architecture — the verifier is pure', () => {
  test('the verifier imports no database or repository', () => {
    assert.ok(!/from ['"]pg['"]/.test(verifierSource), 'verifier imports pg');
    assert.ok(!/from ['"].*db\/pool/.test(verifierSource), 'verifier imports the pool');
    assert.ok(!/from ['"].*repository/.test(verifierSource), 'verifier imports a repository');
  });

  test('the verifier reads no clock', () => {
    // The evaluation instant is injected, so a verdict is reproducible from
    // its recorded inputs alone.
    assert.ok(!/Date\.now\(/.test(verifierSource), 'verifier calls Date.now()');
    assert.ok(!/new Date\(/.test(verifierSource), 'verifier constructs a Date');
  });

  test('the verifier uses no randomness', () => {
    assert.ok(!/Math\.random/.test(verifierSource));
    assert.ok(!/randomUUID/.test(verifierSource));
  });

  test('the verifier performs no async work', () => {
    // A synchronous signature means no I/O can hide inside it.
    assert.ok(!/\bawait\b/.test(verifierSource), 'verifier awaits something');
    assert.ok(!/async /.test(verifierSource), 'verifier declares an async function');
  });

  test('the verifier reads no environment variables', () => {
    assert.ok(!/process\.env/.test(verifierSource));
  });
});

describe('verification architecture — forbidden dependencies', () => {
  const files = [VERIFIER, join(SRC, 'recovery', 'verify-service.ts')];

  test('verification imports no AI provider implementation', () => {
    // An outcome must never be inferred from a model's confidence.
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      const rel = relative(SRC, file);
      assert.ok(!/from ['"].*agents\//.test(source), `${rel} imports the AI layer`);
      assert.ok(!/from ['"]@anthropic-ai/.test(source), `${rel} imports an LLM SDK`);
      assert.ok(!/from ['"]openai['"]/.test(source), `${rel} imports an LLM SDK`);
    }
  });

  test('verification imports no policy evaluator', () => {
    // Verification reports facts; it does not authorize anything.
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      const rel = relative(SRC, file);
      assert.ok(!/from ['"].*policies\/engine/.test(source), `${rel} imports the policy engine`);
      assert.ok(!/evaluatePolicy/.test(source), `${rel} calls evaluatePolicy`);
    }
  });

  test('verification imports no executor', () => {
    // The one dependency that would let verification "resolve" an ambiguous
    // outcome by retrying it — exactly the behaviour the design forbids.
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      const rel = relative(SRC, file);
      assert.ok(!/from ['"]\.\/executor/.test(source), `${rel} imports the executor`);
      assert.ok(!/from ['"]\.\/execute-service/.test(source), `${rel} imports the execute service`);
      assert.ok(!/executeRecoveryAction/.test(source), `${rel} can execute an action`);
      assert.ok(!/executeRecoveryCase/.test(source), `${rel} can execute a case`);
    }
  });

  test('verification imports no ground truth or evaluation data', () => {
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      const rel = relative(SRC, file);
      assert.ok(!/from ['"].*datasets\//.test(source), `${rel} imports datasets`);
      assert.ok(!source.includes('payment_ground_truth'), `${rel} references the labels table`);
      for (const label of ['groundTruth', 'idealAction', 'evaluationLabel', 'recoveryProbability']) {
        assert.ok(!source.includes(label), `${rel} references "${label}"`);
      }
    }
  });

  test('verification imports no HTTP layer or vendor SDK', () => {
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      const rel = relative(SRC, file);
      assert.ok(!/from ['"]fastify['"]/.test(source), `${rel} imports Fastify`);
      assert.ok(!/from ['"].*\/api\//.test(source), `${rel} imports a route`);
      assert.ok(!/from ['"]razorpay['"]/.test(source), `${rel} imports Razorpay`);
      assert.ok(!/\bfetch\(/.test(source), `${rel} calls fetch()`);
    }
  });
});

describe('verification architecture — the service cannot act', () => {
  test('the service depends on the provider abstraction, not an implementation', () => {
    assert.ok(
      /from ['"].*payments\/provider\.ts['"]/.test(serviceSource),
      'service does not import the provider interface',
    );
    assert.ok(
      !/from ['"].*providers\/mock/.test(serviceSource),
      'service imports a concrete provider',
    );
  });

  test('the service only ever READS provider state', () => {
    // getPaymentStatus is a read; executeAction is not. The absence of the
    // latter is what guarantees verification never causes an effect.
    assert.ok(/getPaymentStatus/.test(serviceSource), 'service never observes payment state');
    assert.ok(
      !/executeAction/.test(serviceSource),
      'service calls executeAction and could cause an effect',
    );
  });

  test('the service never marks a payment recovered without a VERIFIED verdict', () => {
    // The payment refresh must be gated on the verdict, not on execution.
    // The CALL site (not the import) must sit inside a VERIFIED guard.
    const callIndex = serviceSource.lastIndexOf('await refreshPaymentStatusFromEvidence');
    assert.ok(callIndex > 0, 'service never refreshes the payment record');
    // Look back far enough to clear the explanatory comment above the guard.
    const guard = serviceSource.slice(Math.max(0, callIndex - 500), callIndex);
    assert.ok(
      guard.includes("verification.status === 'VERIFIED'"),
      'the payment refresh is not gated on a VERIFIED verdict',
    );
  });

  test('RECOVERED is reachable only from VERIFIED', () => {
    const match = serviceSource.match(/case 'VERIFIED':[\s\S]{0,200}?return '([A-Z_]+)'/);
    assert.ok(match, 'the VERIFIED case status mapping was not found');
    assert.equal(match[1], 'RECOVERED');
    // And no other branch may return it.
    const recoveredReturns = [...serviceSource.matchAll(/return 'RECOVERED'/g)];
    assert.equal(recoveredReturns.length, 1, 'RECOVERED is returned from more than one branch');
  });
});

describe('verification architecture — the API delegates', () => {
  test('the verify route calls the service, not the verifier directly', () => {
    // Calling the pure verifier from a route would skip persistence and audit.
    const route = readFileSync(join(SRC, 'api', 'recovery.ts'), 'utf8');
    assert.ok(/verifyRecoveryCase/.test(route), 'route does not use the verification service');
    assert.ok(!/verifyOutcome\(/.test(route), 'route calls the pure verifier directly');
  });

  test('no route imports a provider implementation', () => {
    for (const file of walk(join(SRC, 'api'))) {
      const source = readFileSync(file, 'utf8');
      assert.ok(
        !/from ['"].*payments\/providers\//.test(source),
        `${relative(SRC, file)} imports a concrete provider`,
      );
    }
  });
});

describe('verification architecture — no other layer claims recovery', () => {
  test('the executor never marks anything recovered or verified', () => {
    const executor = readFileSync(join(SRC, 'recovery', 'executor.ts'), 'utf8');
    assert.ok(
      !/'RECOVERED'/.test(executor),
      'the executor references the RECOVERED status',
    );
    assert.ok(
      !/verificationStatus|recordVerification/.test(executor),
      'the executor writes a verification verdict',
    );
    // It may only ever report verified: false.
    assert.ok(/verified: false/.test(executor), 'the executor no longer pins verified to false');
    assert.ok(!/verified: true/.test(executor), 'the executor can claim verification');
  });

  test('the AI layer cannot reach verification', () => {
    for (const file of walk(join(SRC, 'agents'))) {
      const source = readFileSync(file, 'utf8');
      const rel = relative(SRC, file);
      assert.ok(!/from ['"].*verif/.test(source), `${rel} imports the verification layer`);
    }
  });

  test('the policy layer cannot reach verification', () => {
    for (const file of walk(join(SRC, 'policies'))) {
      const source = readFileSync(file, 'utf8');
      assert.ok(
        !/from ['"].*verif/.test(source),
        `${relative(SRC, file)} imports the verification layer`,
      );
    }
  });

  test('only the verification service refreshes payment state from a recovery', () => {
    // Exactly one caller of the guarded refresh, so there is one path from an
    // action to a mutated payment row.
    const callers = walk(SRC).filter((file) => {
      const rel = relative(SRC, file).replace(/\\/g, '/');
      if (rel === 'payments/repository.ts') return false;
      return /refreshPaymentStatusFromEvidence/.test(readFileSync(file, 'utf8'));
    });
    assert.equal(
      callers.length,
      1,
      `expected exactly one caller, found: ${callers.map((f) => relative(SRC, f)).join(', ')}`,
    );
    assert.ok(callers[0]!.endsWith('verify-service.ts'));
  });
});

describe('verification architecture — Razorpay remains unbuilt', () => {
  test('no module imports the Razorpay SDK', () => {
    for (const file of walk(SRC)) {
      const source = readFileSync(file, 'utf8');
      assert.ok(
        !/from ['"]razorpay['"]/.test(source) && !/require\(['"]razorpay['"]\)/.test(source),
        `${relative(SRC, file)} imports the Razorpay SDK`,
      );
    }
  });

  test('the mock provider remains deterministic', () => {
    const mock = readFileSync(join(SRC, 'payments', 'providers', 'mock.ts'), 'utf8');
    assert.ok(!/Math\.random/.test(mock), 'mock provider uses randomness');
    assert.ok(!/randomUUID/.test(mock));
  });
});
