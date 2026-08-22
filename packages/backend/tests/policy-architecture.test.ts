import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

/**
 * ARCHITECTURAL TESTS FOR THE POLICY LAYER
 *
 * The policy engine's value comes from being deterministic and independently
 * verifiable. That property is destroyed the moment it can reach a database, a
 * payment provider, an LLM, or the clock — so those dependencies are forbidden
 * at the import level rather than by convention.
 *
 * The executor now exists; Razorpay still does not. These tests fail the moment
 * either is wired into the policy layer, which is precisely when the boundary
 * matters.
 */

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const POLICIES = join(SRC, 'policies');

function walk(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, acc);
    else if (entry.endsWith('.ts')) acc.push(full);
  }
  return acc;
}

const policyFiles = walk(POLICIES);

describe('policy architecture — module presence', () => {
  test('the policy layer exists and is covered by these tests', () => {
    assert.ok(policyFiles.length >= 3, `expected policy modules, found ${policyFiles.length}`);
  });

  test('an engine, types, and input adapter are all present', () => {
    const names = policyFiles.map((f) => relative(POLICIES, f).replace(/\\/g, '/'));
    for (const expected of ['engine.ts', 'types.ts', 'input.ts']) {
      assert.ok(names.includes(expected), `missing policies/${expected}`);
    }
  });
});

describe('policy architecture — forbidden dependencies', () => {
  test('no policy module imports a database repository or driver', () => {
    // A policy engine that could query the database would stop being a pure
    // function, and could reach ground truth.
    for (const file of policyFiles) {
      const source = readFileSync(file, 'utf8');
      const rel = relative(SRC, file);
      assert.ok(!/from ['"]pg['"]/.test(source), `${rel} imports pg`);
      assert.ok(!/from ['"].*db\/pool/.test(source), `${rel} imports the connection pool`);
      assert.ok(!/from ['"].*\/repository/.test(source), `${rel} imports a repository`);
    }
  });

  test('no policy module imports a payment provider or Razorpay SDK', () => {
    for (const file of policyFiles) {
      const source = readFileSync(file, 'utf8');
      const rel = relative(SRC, file);
      assert.ok(!/from ['"]razorpay['"]/.test(source), `${rel} imports the Razorpay SDK`);
      assert.ok(!/require\(['"]razorpay['"]\)/.test(source), `${rel} requires the Razorpay SDK`);
      assert.ok(
        !/from ['"].*payments\/(providers|razorpay|provider)/.test(source),
        `${rel} imports a payment provider`,
      );
    }
  });

  test('no policy module imports an executor', () => {
    for (const file of policyFiles) {
      const source = readFileSync(file, 'utf8');
      assert.ok(
        !/from ['"].*executor/.test(source),
        `${relative(SRC, file)} imports an executor`,
      );
    }
  });

  test('no policy module imports an AI provider implementation', () => {
    // The engine may not consult the model it is meant to constrain.
    for (const file of policyFiles) {
      const source = readFileSync(file, 'utf8');
      const rel = relative(SRC, file);
      assert.ok(!/from ['"].*agents\/.*providers\//.test(source), `${rel} imports an AI provider`);
      assert.ok(!/from ['"].*providers\/mock/.test(source), `${rel} imports MockAI`);
      assert.ok(!/from ['"]@anthropic-ai/.test(source), `${rel} imports an LLM SDK`);
      assert.ok(!/from ['"]openai['"]/.test(source), `${rel} imports an LLM SDK`);
    }
  });

  test('no policy module imports HTTP or Fastify', () => {
    for (const file of policyFiles) {
      const source = readFileSync(file, 'utf8');
      const rel = relative(SRC, file);
      assert.ok(!/from ['"]fastify['"]/.test(source), `${rel} imports Fastify`);
      assert.ok(!/from ['"]node:http/.test(source), `${rel} imports node:http`);
      assert.ok(!/\bfetch\(/.test(source), `${rel} calls fetch()`);
    }
  });

  test('no policy module reads dataset or evaluation ground truth', () => {
    for (const file of policyFiles) {
      const source = readFileSync(file, 'utf8');
      const rel = relative(SRC, file);
      assert.ok(!source.includes('payment_ground_truth'), `${rel} references the labels table`);
      assert.ok(!/from ['"].*datasets\//.test(source), `${rel} imports the dataset layer`);
      assert.ok(!/from ['"].*evaluation\//.test(source), `${rel} imports the evaluation layer`);
      for (const label of ['groundTruth', 'idealAction', 'evaluationLabel']) {
        assert.ok(!source.includes(label), `${rel} references the ground-truth field "${label}"`);
      }
    }
  });
});

describe('policy architecture — determinism at the source level', () => {
  test('the engine reads no clock', () => {
    // Elapsed time arrives as an explicit input, never sampled here, so a
    // decision is reproducible from its recorded inputs alone.
    const engine = readFileSync(join(POLICIES, 'engine.ts'), 'utf8');
    assert.ok(!/Date\.now\(/.test(engine), 'engine calls Date.now()');
    assert.ok(!/new Date\(/.test(engine), 'engine constructs a Date');
  });

  test('the engine uses no randomness', () => {
    const engine = readFileSync(join(POLICIES, 'engine.ts'), 'utf8');
    assert.ok(!/Math\.random/.test(engine), 'engine calls Math.random()');
    assert.ok(!/randomUUID/.test(engine), 'engine generates a UUID');
  });

  test('the engine performs no async work', () => {
    // A synchronous signature is itself a guarantee: nothing can be awaited,
    // so no I/O can hide inside the evaluator.
    const engine = readFileSync(join(POLICIES, 'engine.ts'), 'utf8');
    assert.ok(!/\bawait\b/.test(engine), 'engine awaits something');
    assert.ok(!/async /.test(engine), 'engine declares an async function');
  });

  test('the engine does not parse configuration itself', () => {
    // Policy values come from the shared loader; a second parser here would
    // let the two drift apart.
    const engine = readFileSync(join(POLICIES, 'engine.ts'), 'utf8');
    assert.ok(!/process\.env/.test(engine), 'engine reads process.env directly');
  });
});

describe('policy architecture — the AI layer cannot reach policy', () => {
  test('no AI module imports the policy engine', () => {
    // Direction matters: policy constrains the AI, never the reverse. An AI
    // module importing the engine could evaluate and then act on its own
    // verdict, collapsing the separation.
    for (const file of walk(join(SRC, 'agents'))) {
      const source = readFileSync(file, 'utf8');
      assert.ok(
        !/from ['"].*policies\//.test(source),
        `${relative(SRC, file)} imports the policy layer`,
      );
    }
  });

  test('the risk detector does not import the policy engine', () => {
    // The detector consumes PolicyConfig thresholds, which is fine, but must
    // not depend on the authorization decision.
    for (const file of walk(join(SRC, 'risk'))) {
      const source = readFileSync(file, 'utf8');
      assert.ok(
        !/from ['"].*policies\/engine/.test(source),
        `${relative(SRC, file)} imports the policy engine`,
      );
    }
  });
});

describe('policy architecture — execution stays outside policy', () => {
  test('the executor exists but is unreachable from the policy layer', () => {
    // The executor now exists (it is a later phase's deliverable). What must
    // remain true is that policy cannot reach it: authorization and execution
    // are separate concerns and must not become mutually dependent.
    const executorFiles = walk(SRC).filter((f) => /executor/i.test(relative(SRC, f)));
    assert.ok(executorFiles.length > 0, 'the executor module is missing');

    for (const file of walk(join(SRC, 'policies'))) {
      const source = readFileSync(file, 'utf8');
      assert.ok(
        !/from ['"].*executor/.test(source),
        `${relative(SRC, file)} imports the executor`,
      );
    }
  });

  test('no module imports the Razorpay SDK anywhere yet', () => {
    for (const file of walk(SRC)) {
      const source = readFileSync(file, 'utf8');
      assert.ok(
        !/from ['"]razorpay['"]/.test(source) && !/require\(['"]razorpay['"]\)/.test(source),
        `${relative(SRC, file)} imports the Razorpay SDK`,
      );
    }
  });
});
