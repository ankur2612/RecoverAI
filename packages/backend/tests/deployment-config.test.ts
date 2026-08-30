import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
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
      const line = envExample.split('\n').find((l) => l.startsWith(`${key}=`));
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
