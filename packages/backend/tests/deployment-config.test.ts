import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadConfig, redactedConfig, ConfigError } from '../src/config/index.ts';

/**
 * DEPLOYMENT CONFIGURATION
 *
 * Static checks over the files that decide how a production container starts.
 * These are cheap and catch the failure that is hardest to notice: a service
 * that comes up looking healthy while being unprotected.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const compose = readFileSync(join(ROOT, 'docker-compose.yml'), 'utf8');
const dockerfile = readFileSync(join(ROOT, 'packages', 'backend', 'Dockerfile'), 'utf8');
const envExample = readFileSync(join(ROOT, '.env.example'), 'utf8');

describe('deployment — production authentication is fail-closed', () => {
  test('compose defaults AUTH_ENABLED to true', () => {
    // The specific defect this guards: NODE_ENV=production with no
    // AUTH_ENABLED, which silently starts an unprotected API.
    assert.match(
      compose,
      /AUTH_ENABLED:\s*\$\{AUTH_ENABLED:-true\}/,
      'compose does not default AUTH_ENABLED to true',
    );
  });

  test('compose refuses to start without API_AUTH_TOKEN', () => {
    // `${VAR:?message}` makes compose itself abort when the variable is
    // unset or empty — before the container is even created.
    assert.match(
      compose,
      /API_AUTH_TOKEN:\s*\$\{API_AUTH_TOKEN:\?/,
      'compose does not require API_AUTH_TOKEN',
    );
  });

  test('compose contains NO real credential', () => {
    // A default token in a committed file is a published credential.
    assert.ok(
      !/API_AUTH_TOKEN:\s*\$\{API_AUTH_TOKEN:-/.test(compose),
      'compose supplies a DEFAULT auth token',
    );
    for (const pattern of [/rzp_test_[A-Za-z0-9]{6,}/, /rzp_live_/, /AIza[A-Za-z0-9_-]{10,}/]) {
      assert.ok(!pattern.test(compose), 'compose contains a credential-shaped literal');
    }
  });

  test('.env.example ships no secret value', () => {
    // Placeholders only: every credential line must be empty.
    for (const key of ['API_AUTH_TOKEN', 'RAZORPAY_KEY_SECRET', 'GEMINI_API_KEY']) {
      // Trimmed: the file is checked out with CRLF endings on Windows, and a
      // trailing carriage return is not a secret.
      const line = envExample
        .split('\n')
        .map((l) => l.trimEnd())
        .find((l) => l.startsWith(`${key}=`));
      if (line === undefined) continue;
      assert.equal(line, `${key}=`, `${key} in .env.example is not an empty placeholder`);
    }
  });

  test('the production posture actually enables auth', () => {
    // The compose values, applied to the real loader.
    const config = loadConfig({
      NODE_ENV: 'production',
      PORT: '8080',
      DATABASE_URL: 'postgres://recoverai:recoverai@db:5432/recoverai',
      AUTH_ENABLED: 'true',
      API_AUTH_TOKEN: 'a'.repeat(32),
      // Production refuses the mock providers unless simulation is explicitly
      // acknowledged, so a deployable posture names real ones.
      PAYMENT_PROVIDER: 'razorpay',
      RAZORPAY_KEY_ID: 'rzp_test_abcdef123456',
      RAZORPAY_KEY_SECRET: 'r'.repeat(24),
      AI_PROVIDER: 'gemini',
      GEMINI_API_KEY: 'g'.repeat(24),
    });
    assert.equal(config.auth.enabled, true);
    assert.equal(config.nodeEnv, 'production');
  });

  test('an enabled-but-tokenless production config refuses to load', () => {
    for (const token of [undefined, '', '   ', 'short']) {
      assert.throws(
        () =>
          loadConfig({
            NODE_ENV: 'production',
            DATABASE_URL: 'postgres://x@db:5432/x',
            AUTH_ENABLED: 'true',
            ...(token === undefined ? {} : { API_AUTH_TOKEN: token }),
          }),
        ConfigError,
        `a token of ${JSON.stringify(token)} was accepted`,
      );
    }
  });
});

describe('deployment — production does not inherit development defaults', () => {
  test('production requires an explicit DATABASE_URL', () => {
    // A misspelled variable would otherwise start the container pointing at a
    // localhost database that does not exist inside it.
    assert.throws(
      () => loadConfig({ NODE_ENV: 'production', AUTH_ENABLED: 'false' }),
      ConfigError,
      'production fell back to the development database URL',
    );
  });

  test('development still needs no configuration at all', () => {
    // The zero-config local experience must be preserved.
    const config = loadConfig({});
    assert.equal(config.nodeEnv, 'development');
    assert.ok(config.databaseUrl.length > 0);
  });

  test('the development default is never used in production', () => {
    const dev = loadConfig({});
    assert.match(dev.databaseUrl, /localhost/);
    // And that same value must be rejected as an implicit production default.
    assert.throws(() => loadConfig({ NODE_ENV: 'production' }), ConfigError);
  });
});

describe('deployment — Dockerfile', () => {
  test('runs unprivileged', () => {
    assert.match(dockerfile, /USER node/, 'the container runs as root');
  });

  test('builds a production dependency tree', () => {
    assert.match(dockerfile, /NODE_ENV=production/);
    assert.match(dockerfile, /--omit=dev/, 'dev dependencies ship to production');
  });

  test('contains no credential', () => {
    for (const pattern of [
      /rzp_(test|live)_[A-Za-z0-9]{6,}/,
      /AIza[A-Za-z0-9_-]{10,}/,
      /API_AUTH_TOKEN=\S/,
      /PASSWORD=\S/,
    ]) {
      assert.ok(!pattern.test(dockerfile), 'the Dockerfile contains a credential');
    }
  });

  test('ships the migrations the runtime needs', () => {
    // They are .sql assets, not compiled output, so they must be copied.
    assert.match(dockerfile, /migrations/);
  });
});

describe('deployment — compose health and safety', () => {
  test('the database service has a health check', () => {
    assert.match(compose, /healthcheck:/);
    assert.match(compose, /pg_isready/);
  });

  test('the backend waits for a healthy database', () => {
    assert.match(compose, /condition:\s*service_healthy/);
  });

  test('secrets come from a gitignored env file, not the compose file', () => {
    assert.match(compose, /env_file:/);
    const gitignore = readFileSync(join(ROOT, '.gitignore'), 'utf8');
    assert.ok(
      gitignore.split('\n').some((l) => l.trim() === '.env'),
      '.env is not gitignored',
    );
  });
});

describe('deployment — CI workflow', () => {
  const workflowPath = join(ROOT, '.github', 'workflows', 'ci.yml');

  test('a CI workflow exists', () => {
    assert.ok(existsSync(workflowPath), 'no CI workflow is defined');
  });

  test('CI runs lint, typecheck, build and tests', () => {
    const workflow = readFileSync(workflowPath, 'utf8');
    for (const step of ['npm run lint', 'npm run typecheck', 'npm run build', 'npm test']) {
      assert.ok(workflow.includes(step), `CI does not run "${step}"`);
    }
  });

  test('CI never injects a live provider credential', () => {
    // The property that keeps ordinary CI free of cost and third-party calls.
    const workflow = readFileSync(workflowPath, 'utf8');
    assert.ok(
      !/^\s+(GEMINI_API_KEY|RAZORPAY_KEY_ID|RAZORPAY_KEY_SECRET):/m.test(workflow),
      'CI sets a live provider credential',
    );
    assert.ok(
      !/secrets\.(GEMINI|RAZORPAY|ANTHROPIC|OPENAI)/.test(workflow),
      'CI injects a live provider secret',
    );
  });

  test('CI does not enable live provider tests', () => {
    const workflow = readFileSync(workflowPath, 'utf8');
    assert.ok(
      !/RECOVERAI_LIVE_PROVIDER_TESTS:\s*['"]?1/.test(workflow),
      'CI enables the live provider smoke tests',
    );
  });
});

describe('deployment — redacted config stays safe', () => {
  test('operational limits are exposed, secrets are not', () => {
    const config = loadConfig({
      AUTH_ENABLED: 'true',
      API_AUTH_TOKEN: 'deployment-token-0123456789abcdef',
      RATE_LIMIT_MAX: '42',
    });
    const serialised = JSON.stringify(redactedConfig(config));

    assert.ok(serialised.includes('42'), 'rate limits are not reported');
    assert.ok(
      !serialised.includes('deployment-token-0123456789abcdef'),
      'the auth token leaked into redacted config',
    );
    assert.ok(!/"token"\s*:/.test(serialised), 'a raw token field is serialised');
  });
});

describe('deployment — production refuses to simulate recovery', () => {
  /*
   * The most dangerous misconfiguration this system has is a PRODUCTION
   * deployment running mock providers: every screen fills with recovery
   * cases, executions, and verified outcomes that describe nothing real, and
   * nothing in the product distinguishes them from genuine ones.
   */
  const PROD = {
    NODE_ENV: 'production',
    DATABASE_URL: 'postgres://user:pass@db:5432/recoverai',
    AUTH_ENABLED: 'true',
    API_AUTH_TOKEN: 'deployment-token-0123456789abcdef',
  };
  const REAL = {
    PAYMENT_PROVIDER: 'razorpay',
    RAZORPAY_KEY_ID: 'rzp_test_abcdef123456',
    RAZORPAY_KEY_SECRET: 'razorpay-secret-value-0123456789',
    AI_PROVIDER: 'gemini',
    GEMINI_API_KEY: 'gemini-api-key-0123456789abcdef',
  };

  test('production with the mock PAYMENT provider is refused', () => {
    assert.throws(() => loadConfig({ ...PROD, ...REAL, PAYMENT_PROVIDER: 'mock' }), ConfigError);
  });

  test('production with the mock AI provider is refused', () => {
    assert.throws(() => loadConfig({ ...PROD, ...REAL, AI_PROVIDER: 'mock' }), ConfigError);
  });

  test('production with real providers starts', () => {
    const config = loadConfig({ ...PROD, ...REAL });
    assert.equal(config.payments.provider, 'razorpay');
    assert.equal(config.ai.provider, 'gemini');
  });

  test('a hosted demo may acknowledge simulation explicitly', () => {
    // A Buildathon deployment with no Razorpay account is legitimate, but it
    // must be typed by a human rather than inherited from a default.
    const config = loadConfig({ ...PROD, ALLOW_MOCK_PROVIDERS_IN_PRODUCTION: 'true' });
    assert.equal(config.payments.provider, 'mock');
  });

  test('DEVELOPMENT still defaults to mock with zero configuration', () => {
    // The guard must not cost local development its zero-config behaviour.
    const config = loadConfig({});
    assert.equal(config.payments.provider, 'mock');
    assert.equal(config.ai.provider, 'mock');
  });

  test('production requires authentication to be enabled', () => {
    // Without this, a non-Compose deployment inherits AUTH_ENABLED=false and
    // publishes every route, including the batch execution endpoint.
    assert.throws(
      () => loadConfig({ ...PROD, ...REAL, AUTH_ENABLED: 'false' }),
      ConfigError,
    );
  });

  test('redactedConfig reports whether the deployment is simulated', () => {
    const simulated = loadConfig({ ...PROD, ALLOW_MOCK_PROVIDERS_IN_PRODUCTION: 'true' });
    const real = loadConfig({ ...PROD, ...REAL });

    assert.equal(redactedConfig(simulated).simulated, true);
    assert.equal(redactedConfig(real).simulated, false);
    // It is a derived boolean, never a credential.
    assert.ok(!JSON.stringify(redactedConfig(real)).includes('razorpay-secret'));
  });

  test('EITHER provider being mocked counts as simulated', () => {
    // A real payment provider with a mock AI still produces rule-based
    // diagnoses, not model output, so reporting it as unsimulated would
    // overstate what the deployment does.
    const mockAi = loadConfig({
      ...PROD,
      ...REAL,
      AI_PROVIDER: 'mock',
      ALLOW_MOCK_PROVIDERS_IN_PRODUCTION: 'true',
    });
    const mockPayments = loadConfig({
      ...PROD,
      ...REAL,
      PAYMENT_PROVIDER: 'mock',
      ALLOW_MOCK_PROVIDERS_IN_PRODUCTION: 'true',
    });

    assert.equal(redactedConfig(mockAi).simulated, true);
    assert.equal(redactedConfig(mockPayments).simulated, true);
  });
});

describe('deployment — production is never auto-seeded', () => {
  const cliSource = readFileSync(join(ROOT, 'packages/backend/src/datasets/cli.ts'), 'utf8');

  test('no migration inserts data', () => {
    // Migrations create SCHEMA. A migration that seeded rows would populate
    // every production deployment with synthetic payments on first deploy.
    const dir = join(ROOT, 'packages/backend/src/db/migrations');
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql'))) {
      const sql = readFileSync(join(dir, file), 'utf8');
      assert.ok(
        !/\bINSERT\s+INTO\b/i.test(sql),
        `migration ${file} inserts data; migrations must create schema only`,
      );
    }
  });

  test('application startup does not seed', () => {
    // index.ts builds the app and listens. It must not reach the generator.
    const entry = readFileSync(join(ROOT, 'packages/backend/src/index.ts'), 'utf8');
    for (const forbidden of ['generateDataset', 'persistDataset', 'datasets/']) {
      assert.ok(!entry.includes(forbidden), `startup references ${forbidden}`);
    }
  });

  test('the seed CLI refuses to write to a production database', () => {
    // The guard must be in the --db branch, before persistDataset is called.
    assert.ok(
      /nodeEnv === 'production'/.test(cliSource),
      'the seed CLI has no production guard',
    );
    const dbBranch = cliSource.slice(cliSource.indexOf('if (args.db)'));
    const guardAt = dbBranch.indexOf("nodeEnv === 'production'");
    // `await persistDataset(` is the call, not the import at the top of file.
    const persistAt = dbBranch.indexOf('await persistDataset(');
    assert.ok(guardAt >= 0, 'the --db branch has no production guard');
    assert.ok(persistAt >= 0, 'the --db branch does not call persistDataset');
    assert.ok(guardAt < persistAt, 'the guard does not precede the write');
  });

  test('writing to the database stays opt-in', () => {
    // Without --db the CLI prints a summary and writes nothing, so an
    // accidental run cannot touch any database.
    assert.ok(/args\.db = true/.test(cliSource), '--db is not an explicit flag');
  });
});
