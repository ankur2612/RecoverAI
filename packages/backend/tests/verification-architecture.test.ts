import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

/**
 * ARCHITECTURAL TESTS FOR THE VERIFICATION BOUNDARY
 *
 * Verification's value is that it answers "what happened?" from evidence, with
 * no ability to influence what happens next.
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

  test('the verifier uses no randomness and performs no async work', () => {
    assert.ok(!/Math\.random/.test(verifierSource));
    assert.ok(!/randomUUID/.test(verifierSource));
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

  test('verification imports no AI provider', () => {
    // An outcome must never be inferred from a model's confidence.
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      const rel = relative(SRC, file);
      assert.ok(!/from ['"].*agents\//.test(source), `${rel} imports the AI layer`);
      assert.ok(!/gemini/i.test(source), `${rel} mentions Gemini`);
    }
  });

  test('verification imports no policy evaluator', () => {
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      const rel = relative(SRC, file);
      assert.ok(!/from ['"].*policies\/engine/.test(source), `${rel} imports the policy engine`);
      assert.ok(!/evaluatePolicy/.test(source), `${rel} calls evaluatePolicy`);
    }
  });

  test('verification imports no executor', () => {
    // The one dependency that would let verification "resolve" an ambiguous
    // outcome by retrying it — exactly what the design forbids.
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
      for (const label of ['groundTruth', 'idealAction', 'evaluationLabel']) {
        assert.ok(!source.includes(label), `${rel} references "${label}"`);
      }
    }
  });
});

describe('verification architecture — the service cannot act', () => {
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
    const callIndex = serviceSource.lastIndexOf('await refreshPaymentStatusFromEvidence');
    assert.ok(callIndex > 0, 'service never refreshes the payment record');
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
    assert.equal(
      [...serviceSource.matchAll(/return 'RECOVERED'/g)].length,
      1,
      'RECOVERED is returned from more than one branch',
    );
  });
});

describe('verification architecture — no other layer claims recovery', () => {
  test('the executor never marks anything recovered or verified', () => {
    const executor = readFileSync(join(SRC, 'recovery', 'executor.ts'), 'utf8');
    assert.ok(!/'RECOVERED'/.test(executor), 'the executor references the RECOVERED status');
    assert.ok(
      !/verificationStatus|recordVerification/.test(executor),
      'the executor writes a verification verdict',
    );
    assert.ok(/verified: false/.test(executor), 'the executor no longer pins verified to false');
    assert.ok(!/verified: true/.test(executor), 'the executor can claim verification');
  });

  test('only the verification service refreshes payment state from a recovery', () => {
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

  test('the AI and policy layers cannot reach verification', () => {
    for (const dir of ['agents', 'policies']) {
      for (const file of walk(join(SRC, dir))) {
        const source = readFileSync(file, 'utf8');
        assert.ok(
          !/from ['"].*verif/.test(source),
          `${relative(SRC, file)} imports the verification layer`,
        );
      }
    }
  });
});
