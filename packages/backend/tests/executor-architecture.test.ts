import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

/**
 * ARCHITECTURAL TESTS FOR THE EXECUTOR BOUNDARY
 *
 * The executor is the only component that can cause an external effect, so the
 * constraints on what it may reach — and on who may reach it — are enforced at
 * the import level rather than by convention.
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

const EXECUTOR = join(SRC, 'recovery', 'executor.ts');
const executorSource = readFileSync(EXECUTOR, 'utf8');
const paymentFiles = walk(join(SRC, 'payments'));

describe('executor architecture — forbidden dependencies', () => {
  test('the executor does not import an AI provider implementation', () => {
    // The executor must not be able to consult the model whose recommendation
    // it is acting on; it acts on the POLICY verdict alone.
    assert.ok(!/from ['"].*agents\//.test(executorSource), 'executor imports the AI layer');
    assert.ok(!/from ['"]@anthropic-ai/.test(executorSource));
    assert.ok(!/from ['"]openai['"]/.test(executorSource));
  });

  test('the executor does not import ground truth or evaluation data', () => {
    assert.ok(!/from ['"].*datasets\//.test(executorSource), 'executor imports datasets');
    assert.ok(!executorSource.includes('payment_ground_truth'));
    for (const label of ['groundTruth', 'idealAction', 'evaluationLabel']) {
      assert.ok(!executorSource.includes(label), `executor references "${label}"`);
    }
  });

  test('the executor does not import a vendor SDK', () => {
    assert.ok(!/from ['"]razorpay['"]/.test(executorSource), 'executor imports Razorpay');
    assert.ok(!/from ['"]stripe['"]/.test(executorSource));
  });

  test('the executor does not use an arbitrary HTTP client', () => {
    // All outbound effects go through the provider abstraction.
    assert.ok(!/\bfetch\(/.test(executorSource), 'executor calls fetch()');
    assert.ok(!/from ['"]node:http/.test(executorSource));
    assert.ok(!/from ['"]axios['"]/.test(executorSource));
  });

  test('the executor does not read environment variables directly', () => {
    // Configuration is centralised; a second reader would let the executor
    // observe a different policy ceiling than the engine did.
    assert.ok(!/process\.env/.test(executorSource), 'executor reads process.env');
  });

  test('the executor does not import Fastify or the HTTP layer', () => {
    assert.ok(!/from ['"]fastify['"]/.test(executorSource));
    assert.ok(!/from ['"].*\/api\//.test(executorSource));
  });

  test('the executor does not re-run the policy engine', () => {
    // Re-deciding authorization inside the executor would mean two components
    // could disagree about what is permitted. It consumes a verdict only.
    assert.ok(
      !/from ['"].*policies\/engine/.test(executorSource),
      'executor imports the policy engine and could re-authorize',
    );
    assert.ok(!/evaluatePolicy/.test(executorSource), 'executor calls evaluatePolicy');
  });
});

describe('executor architecture — permitted dependencies', () => {
  test('the executor depends on the provider abstraction, not an implementation', () => {
    assert.ok(
      /from ['"].*payments\/provider\.ts['"]/.test(executorSource),
      'executor does not import the provider interface',
    );
    assert.ok(
      !/from ['"].*providers\/mock/.test(executorSource),
      'executor imports a concrete provider implementation',
    );
  });

  test('the executor depends on the action and audit repositories', () => {
    assert.ok(/from ['"]\.\/action-repository\.ts['"]/.test(executorSource));
    assert.ok(/from ['"].*audit\/repository\.ts['"]/.test(executorSource));
  });

  test('the executor consumes policy TYPES only', () => {
    // Importing the result type is fine; importing the engine is not.
    assert.ok(/from ['"].*policies\/types\.ts['"]/.test(executorSource));
  });
});

describe('executor architecture — the AI layer cannot execute', () => {
  test('no AI module imports the executor', () => {
    for (const file of walk(join(SRC, 'agents'))) {
      const source = readFileSync(file, 'utf8');
      const rel = relative(SRC, file);
      assert.ok(!/from ['"].*executor/.test(source), `${rel} imports the executor`);
      assert.ok(!/from ['"].*execute-service/.test(source), `${rel} imports the execute service`);
    }
  });

  test('no AI module imports a payment provider', () => {
    for (const file of walk(join(SRC, 'agents'))) {
      const source = readFileSync(file, 'utf8');
      assert.ok(
        !/from ['"].*payments\//.test(source),
        `${relative(SRC, file)} imports the payments layer`,
      );
    }
  });
});

describe('executor architecture — the policy engine stays independent', () => {
  test('no policy module imports the executor or a provider', () => {
    // Policy must remain a pure function; reaching execution would end that.
    for (const file of walk(join(SRC, 'policies'))) {
      const source = readFileSync(file, 'utf8');
      const rel = relative(SRC, file);
      assert.ok(!/from ['"].*executor/.test(source), `${rel} imports the executor`);
      assert.ok(!/from ['"].*payments\/provider/.test(source), `${rel} imports a provider`);
      assert.ok(!/from ['"].*action-repository/.test(source), `${rel} imports the action store`);
    }
  });
});

describe('executor architecture — the API layer', () => {
  test('no API route imports a provider implementation directly', () => {
    // Routes ask the factory; they never construct a vendor client.
    for (const file of walk(join(SRC, 'api'))) {
      const source = readFileSync(file, 'utf8');
      const rel = relative(SRC, file);
      assert.ok(
        !/from ['"].*payments\/providers\//.test(source),
        `${rel} imports a concrete provider implementation`,
      );
      assert.ok(!/from ['"]razorpay['"]/.test(source), `${rel} imports the Razorpay SDK`);
    }
  });

  test('the execute route delegates to the service rather than the executor', () => {
    // Calling the executor straight from a route would bypass policy
    // re-validation, which lives in the service.
    const route = readFileSync(join(SRC, 'api', 'recovery.ts'), 'utf8');
    assert.ok(/executeRecoveryCase/.test(route), 'route does not use the execute service');
    assert.ok(
      !/executeRecoveryAction/.test(route),
      'route calls the executor directly, bypassing policy re-validation',
    );
  });
});

describe('executor architecture — provider isolation', () => {
  test('the provider abstraction imports no vendor SDK', () => {
    for (const file of paymentFiles) {
      const source = readFileSync(file, 'utf8');
      const rel = relative(SRC, file);
      assert.ok(!/from ['"]razorpay['"]/.test(source), `${rel} imports Razorpay`);
      assert.ok(!/require\(['"]razorpay['"]\)/.test(source), `${rel} requires Razorpay`);
    }
  });

  test('no provider queries ground truth', () => {
    // Matches actual SQL usage rather than any textual mention, so a comment
    // documenting the boundary is fine while a real query is not.
    const sqlUsage = /\b(from|join|into|update|delete\s+from)\s+payment_ground_truth\b/i;
    for (const file of paymentFiles) {
      const source = readFileSync(file, 'utf8');
      const rel = relative(SRC, file);
      assert.ok(!sqlUsage.test(source), `${rel} queries the labels table`);
      assert.ok(!source.includes('groundTruth'), `${rel} references a ground-truth object`);
    }
  });

  test('the mock provider uses no randomness', () => {
    // Determinism is what makes the UNKNOWN and concurrency tests meaningful.
    const mock = readFileSync(join(SRC, 'payments', 'providers', 'mock.ts'), 'utf8');
    assert.ok(!/Math\.random/.test(mock), 'mock provider uses Math.random');
    assert.ok(!/randomUUID/.test(mock), 'mock provider generates a UUID');
  });

  test('Razorpay remains unimplemented in this phase', () => {
    for (const file of walk(SRC)) {
      const source = readFileSync(file, 'utf8');
      assert.ok(
        !/from ['"]razorpay['"]/.test(source),
        `${relative(SRC, file)} imports the Razorpay SDK`,
      );
    }
  });
});

describe('executor architecture — idempotency is enforced by the database', () => {
  test('the executor claims the key before calling the provider', () => {
    // Ordering is the whole guarantee: the claim must precede the call.
    const claimIndex = executorSource.indexOf('claimAction(');
    const callIndex = executorSource.indexOf('provider.executeAction(');
    assert.ok(claimIndex > 0, 'executor never claims an idempotency key');
    assert.ok(callIndex > 0, 'executor never calls the provider');
    assert.ok(
      claimIndex < callIndex,
      'the provider is called before the idempotency key is claimed',
    );
  });

  test('the claim relies on the database constraint, not a read-then-write check', () => {
    const repo = readFileSync(join(SRC, 'recovery', 'action-repository.ts'), 'utf8');
    assert.ok(
      /ON CONFLICT \(idempotency_key\) DO NOTHING/.test(repo),
      'claimAction does not rely on the UNIQUE constraint',
    );
  });

  test('the executor never generates its own idempotency key for a caller', () => {
    // A missing key must be a refusal; inventing one would silently permit
    // duplicate execution.
    assert.ok(
      /MISSING_IDEMPOTENCY_KEY/.test(executorSource),
      'executor does not refuse a missing idempotency key',
    );
  });

  test('the schema still enforces UNIQUE on idempotency_key', () => {
    const schema = readFileSync(
      join(SRC, 'db', 'migrations', '001_initial_schema.sql'),
      'utf8',
    );
    assert.match(schema, /idempotency_key\s+TEXT\s+NOT NULL UNIQUE/);
  });
});
