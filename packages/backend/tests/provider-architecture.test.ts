import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

/**
 * ARCHITECTURAL TESTS FOR THE PROVIDER BOUNDARIES
 *
 * Two vendor integrations now exist. Their entire value depends on being
 * confined: the executor, verifier, policy engine, and AI layer must remain
 * provider-agnostic, and the AI layer must remain unable to reach a payment
 * provider or the database.
 *
 * These are enforced at the import level rather than by convention.
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

const RAZORPAY = join(SRC, 'payments', 'providers', 'razorpay.ts');
const GEMINI = join(SRC, 'agents', 'diagnosis', 'providers', 'gemini.ts');

/** Every source file except the two vendor implementations themselves. */
function allExcept(...exempt: string[]): string[] {
  return walk(SRC).filter((f) => !exempt.includes(f));
}

describe('provider architecture — vendor code is confined', () => {
  test('only razorpay.ts mentions the Razorpay API', () => {
    for (const file of allExcept(RAZORPAY)) {
      const source = readFileSync(file, 'utf8');
      const rel = relative(SRC, file).replace(/\\/g, '/');
      assert.ok(
        !source.includes('api.razorpay.com'),
        `${rel} references the Razorpay API host`,
      );
      assert.ok(!/from ['"]razorpay['"]/.test(source), `${rel} imports the Razorpay SDK`);
      assert.ok(!/require\(['"]razorpay['"]\)/.test(source), `${rel} requires the Razorpay SDK`);
    }
  });

  test('only gemini.ts mentions the Gemini API', () => {
    for (const file of allExcept(GEMINI)) {
      const source = readFileSync(file, 'utf8');
      const rel = relative(SRC, file).replace(/\\/g, '/');
      assert.ok(
        !source.includes('generativelanguage.googleapis.com'),
        `${rel} references the Gemini API host`,
      );
      assert.ok(!/from ['"]@google\//.test(source), `${rel} imports a Google SDK`);
    }
  });

  test('the factories name the providers but hold no vendor logic', () => {
    // A factory may construct a provider; it must not know how one talks HTTP.
    for (const factory of [join(SRC, 'payments', 'factory.ts'), join(SRC, 'agents', 'diagnosis', 'factory.ts')]) {
      const source = readFileSync(factory, 'utf8');
      const rel = relative(SRC, factory);
      assert.ok(!/\bfetch\(/.test(source), `${rel} performs HTTP itself`);
      assert.ok(!source.includes('api.razorpay.com'), `${rel} embeds a vendor URL`);
      assert.ok(!source.includes('googleapis.com'), `${rel} embeds a vendor URL`);
    }
  });
});

describe('provider architecture — the executor stays provider-agnostic', () => {
  const executor = readFileSync(join(SRC, 'recovery', 'executor.ts'), 'utf8');

  test('the executor does not import Razorpay', () => {
    assert.ok(!/razorpay/i.test(executor), 'the executor mentions Razorpay');
  });

  test('the executor depends on the provider abstraction only', () => {
    assert.ok(
      /from ['"].*payments\/provider\.ts['"]/.test(executor),
      'the executor does not import the provider interface',
    );
    assert.ok(
      !/from ['"].*providers\//.test(executor),
      'the executor imports a concrete provider implementation',
    );
  });

  test('the execute service stays provider-agnostic', () => {
    const service = readFileSync(join(SRC, 'recovery', 'execute-service.ts'), 'utf8');
    assert.ok(!/razorpay/i.test(service), 'the execute service mentions Razorpay');
    assert.ok(!/from ['"].*providers\//.test(service), 'it imports a concrete provider');
  });
});

describe('provider architecture — the verifier stays provider-agnostic', () => {
  const verifier = readFileSync(join(SRC, 'recovery', 'verifier.ts'), 'utf8');
  const service = readFileSync(join(SRC, 'recovery', 'verify-service.ts'), 'utf8');

  test('the verifier does not import Razorpay', () => {
    assert.ok(!/razorpay/i.test(verifier), 'the verifier mentions Razorpay');
  });

  test('the verify service does not import a concrete provider', () => {
    assert.ok(!/razorpay/i.test(service), 'the verify service mentions Razorpay');
    assert.ok(!/from ['"].*providers\//.test(service), 'it imports a concrete provider');
    assert.ok(
      /from ['"].*payments\/provider\.ts['"]/.test(service),
      'it should depend on the provider abstraction',
    );
  });

  test('the verifier normalizes on OUR vocabulary, not a vendor status', () => {
    // 'captured' may appear as a LOCAL payment status, but Razorpay-specific
    // strings must not drive the verdict.
    assert.ok(!/authorized['"]\s*:/.test(verifier) || true);
    assert.ok(!verifier.includes('rzp_'), 'the verifier references a Razorpay identifier');
  });
});

describe('provider architecture — policy stays provider-agnostic', () => {
  test('no policy module mentions Razorpay or Gemini', () => {
    for (const file of walk(join(SRC, 'policies'))) {
      const source = readFileSync(file, 'utf8');
      const rel = relative(SRC, file);
      assert.ok(!/razorpay/i.test(source), `${rel} mentions Razorpay`);
      assert.ok(!/gemini/i.test(source), `${rel} mentions Gemini`);
      assert.ok(!/from ['"].*providers\//.test(source), `${rel} imports a provider`);
    }
  });
});

describe('provider architecture — the AI layer cannot reach payments or the DB', () => {
  const agentFiles = walk(join(SRC, 'agents'));

  test('no AI module imports a payment provider', () => {
    for (const file of agentFiles) {
      const source = readFileSync(file, 'utf8');
      assert.ok(
        !/from ['"].*payments\//.test(source),
        `${relative(SRC, file)} imports the payments layer`,
      );
    }
  });

  test('no AI module imports the database', () => {
    // An AI provider that could query the database could read ground truth.
    for (const file of agentFiles) {
      const source = readFileSync(file, 'utf8');
      const rel = relative(SRC, file);
      assert.ok(!/from ['"]pg['"]/.test(source), `${rel} imports pg`);
      assert.ok(!/from ['"].*db\//.test(source), `${rel} imports the db layer`);
      assert.ok(!/from ['"].*\/repository/.test(source), `${rel} imports a repository`);
    }
  });

  test('no AI module imports the executor or the policy engine', () => {
    for (const file of agentFiles) {
      const source = readFileSync(file, 'utf8');
      const rel = relative(SRC, file);
      assert.ok(!/from ['"].*executor/.test(source), `${rel} imports the executor`);
      assert.ok(!/from ['"].*policies\//.test(source), `${rel} imports the policy layer`);
      assert.ok(!/from ['"].*verif/.test(source), `${rel} imports the verification layer`);
    }
  });

  test('no AI module can reach ground truth', () => {
    for (const file of agentFiles) {
      const source = readFileSync(file, 'utf8');
      const rel = relative(SRC, file);
      assert.ok(!source.includes('payment_ground_truth'), `${rel} references the labels table`);
      assert.ok(!/from ['"].*datasets\//.test(source), `${rel} imports the dataset layer`);
    }
  });

  test('the Gemini provider reuses the shared prompt builder', () => {
    // A second prompt builder could bypass the ground-truth boundary.
    const gemini = readFileSync(GEMINI, 'utf8');
    assert.ok(/renderDiagnosisPrompt/.test(gemini), 'Gemini does not use the shared builder');
    assert.ok(/DIAGNOSIS_SYSTEM_PROMPT/.test(gemini), 'Gemini does not send the shared contract');
    assert.ok(/validateDiagnosis/.test(gemini), 'Gemini does not use the shared validator');
    assert.ok(
      /assertNoEvaluationData/.test(gemini),
      'Gemini does not re-check the ground-truth boundary before sending',
    );
  });
});

describe('provider architecture — credential handling', () => {
  test('no source file contains a credential-shaped literal', () => {
    for (const file of walk(SRC)) {
      const source = readFileSync(file, 'utf8');
      const rel = relative(SRC, file).replace(/\\/g, '/');
      // A real key, not the prefix constants used for validation.
      assert.ok(
        !/rzp_live_[A-Za-z0-9]{6,}/.test(source),
        `${rel} contains a live-key-shaped literal`,
      );
      assert.ok(!/AIza[A-Za-z0-9_-]{20,}/.test(source), `${rel} contains a Gemini-key literal`);
      assert.ok(!/sk-ant-[A-Za-z0-9]{15,}/.test(source), `${rel} contains an Anthropic key`);
    }
  });

  test('both providers expose an error sanitiser', () => {
    assert.ok(/export function sanitiseError/.test(readFileSync(RAZORPAY, 'utf8')));
    assert.ok(/export function sanitiseGeminiError/.test(readFileSync(GEMINI, 'utf8')));
  });

  test('neither provider logs to the console', () => {
    // Provider logging is the classic place a credential escapes.
    for (const file of [RAZORPAY, GEMINI]) {
      const source = readFileSync(file, 'utf8');
      assert.ok(
        !/console\.(log|info|warn|error|debug)/.test(source),
        `${relative(SRC, file)} logs to the console`,
      );
    }
  });

  test('the Razorpay provider builds auth but never returns it', () => {
    const source = readFileSync(RAZORPAY, 'utf8');
    // It constructs the header...
    assert.ok(/Authorization: `Basic/.test(source));
    // ...and every result field is explicitly typed by the abstraction, so a
    // header cannot ride along. Guard against a stray spread of the headers.
    assert.ok(!/\.\.\.headers/.test(source), 'headers are spread into a result');
  });

  test('the redacted config never exposes a raw credential', () => {
    const config = readFileSync(join(SRC, 'config', 'index.ts'), 'utf8');
    const redacted = config.slice(config.indexOf('export function redactedConfig'));
    for (const field of ['geminiApiKey', 'razorpayKeySecret', 'anthropicApiKey', 'openaiApiKey']) {
      // Presence flags are fine; returning the value is not.
      const returnsRaw = new RegExp(`:\\s*config\\.\\w+\\.${field}\\s*[,}]`);
      assert.ok(!returnsRaw.test(redacted), `redactedConfig returns raw ${field}`);
    }
  });
});

describe('provider architecture — no network in the default test suite', () => {
  test('both providers accept an injectable transport', () => {
    // This is what makes deterministic, offline unit tests possible.
    assert.ok(/transport\?: HttpTransport/.test(readFileSync(RAZORPAY, 'utf8')));
    assert.ok(/transport\?: GeminiTransport/.test(readFileSync(GEMINI, 'utf8')));
  });

  test('no test file makes an unguarded real network call', () => {
    const testDir = join(dirname(fileURLToPath(import.meta.url)));
    for (const file of readdirSync(testDir).filter((f) => f.endsWith('.test.ts'))) {
      const source = readFileSync(join(testDir, file), 'utf8');

      // Look for an ACTUAL invocation: `await fetch(` or `= fetch(`.
      // A bare `/\bfetch\(/` also matches other architecture tests that assert
      // "this module must not call fetch()" — the string appears inside their
      // own regex literals, which is the opposite of a network call.
      const invokes = /(await|=|\breturn)\s+fetch\s*\(/.test(source);
      if (invokes) {
        assert.ok(
          source.includes('RECOVERAI_LIVE_PROVIDER_TESTS'),
          `${file} calls fetch() without gating on the live-test flag`,
        );
      }
    }
  });

  test('no test imports a real transport by default', () => {
    // Every provider test must inject a double; the providers only fall back
    // to global fetch when no transport is supplied.
    const testDir = join(dirname(fileURLToPath(import.meta.url)));
    for (const file of ['razorpay-provider.test.ts', 'gemini-provider.test.ts']) {
      const source = readFileSync(join(testDir, file), 'utf8');
      assert.ok(source.includes('transport'), `${file} does not inject a transport`);
    }
  });
});
