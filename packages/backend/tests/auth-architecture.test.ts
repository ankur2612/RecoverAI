import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

/**
 * ARCHITECTURAL TESTS FOR THE AUTHENTICATION BOUNDARY
 *
 * Authentication answers "who may call the API". Authorization — "is this
 * recovery action permitted" — belongs to the deterministic policy engine.
 * Collapsing the two would let a caller with a valid token move money the
 * policy engine had refused.
 *
 * The separation is enforced here at the import level: the domain must not be
 * able to see the auth module at all, so it cannot consult it even by mistake.
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

/**
 * Source with comments removed.
 *
 * These tests assert what the CODE does. Prose discussing a concept — the word
 * "authorization" in an explanatory comment, or a doc comment promising that a
 * module does NOT read process.env — must not read as a violation.
 */
function code(file: string): string {
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const AUTH = join(SRC, 'api', 'auth.ts');
const APP = join(SRC, 'app.ts');
const authSource = readFileSync(AUTH, 'utf8');

/** Anything that imports the auth module by path. */
const IMPORTS_AUTH = /from ['"][^'"]*api\/auth\.ts['"]/;

/** Names only the auth module should own. */
const AUTH_SYMBOLS = [
  'authenticateRequest',
  'registerAuth',
  'timingSafeCompare',
  'extractCredential',
  'isPublicPath',
];

describe('auth architecture — the domain cannot see authentication', () => {
  const domainDirs = ['recovery', 'policies', 'payments', 'agents', 'audit', 'db', 'datasets'];

  test('no domain module imports the auth module', () => {
    for (const dir of domainDirs) {
      for (const file of walk(join(SRC, dir))) {
        const source = readFileSync(file, 'utf8');
        const rel = relative(SRC, file).replace(/\\/g, '/');
        assert.ok(!IMPORTS_AUTH.test(source), `${rel} imports the auth module`);
      }
    }
  });

  test('the executor does not import or reference authentication', () => {
    const executor = readFileSync(join(SRC, 'recovery', 'executor.ts'), 'utf8');
    assert.ok(!IMPORTS_AUTH.test(executor), 'the executor imports auth');
    for (const symbol of AUTH_SYMBOLS) {
      assert.ok(!executor.includes(symbol), `the executor references "${symbol}"`);
    }
    // Nor may it read a credential from the environment itself.
    assert.ok(!executor.includes('API_AUTH_TOKEN'));
    assert.ok(!executor.includes('AUTH_ENABLED'));
  });

  test('the policy engine does not import or reference authentication', () => {
    // The engine authorizes actions. If it could see a caller's identity, an
    // authenticated caller could become a more privileged one.
    for (const file of walk(join(SRC, 'policies'))) {
      const source = code(file);
      const rel = relative(SRC, file).replace(/\\/g, '/');
      assert.ok(!IMPORTS_AUTH.test(source), `${rel} imports auth`);
      for (const symbol of AUTH_SYMBOLS) {
        assert.ok(!source.includes(symbol), `${rel} references "${symbol}"`);
      }
      // The real property: the engine must not read a caller's credentials.
      assert.ok(
        !/headers|x-api-key|authorization\s*[:.[]/i.test(source),
        `${rel} reads an HTTP credential`,
      );
      assert.ok(!source.includes('API_AUTH_TOKEN'), `${rel} reads the auth token`);
    }
  });

  test('payment providers do not import or reference authentication', () => {
    // A provider authenticates to a VENDOR. It must never see RecoverAI's own
    // inbound API credential.
    for (const file of walk(join(SRC, 'payments'))) {
      const source = readFileSync(file, 'utf8');
      const rel = relative(SRC, file).replace(/\\/g, '/');
      assert.ok(!IMPORTS_AUTH.test(source), `${rel} imports auth`);
      assert.ok(!source.includes('API_AUTH_TOKEN'), `${rel} references the API auth token`);
      for (const symbol of AUTH_SYMBOLS) {
        assert.ok(!source.includes(symbol), `${rel} references "${symbol}"`);
      }
    }
  });

  test('AI providers do not import or reference authentication', () => {
    for (const file of walk(join(SRC, 'agents'))) {
      const source = readFileSync(file, 'utf8');
      const rel = relative(SRC, file).replace(/\\/g, '/');
      assert.ok(!IMPORTS_AUTH.test(source), `${rel} imports auth`);
      assert.ok(!source.includes('API_AUTH_TOKEN'), `${rel} references the API auth token`);
    }
  });

  test('repositories do not import or reference authentication', () => {
    // Access control must not be re-implemented at the data layer, where it
    // would be invisible to the policy engine.
    const repositories = walk(SRC).filter((f) => /repository\.ts$/.test(f));
    assert.ok(repositories.length >= 3, 'expected to find several repositories');
    for (const file of repositories) {
      const source = readFileSync(file, 'utf8');
      const rel = relative(SRC, file).replace(/\\/g, '/');
      assert.ok(!IMPORTS_AUTH.test(source), `${rel} imports auth`);
      for (const symbol of AUTH_SYMBOLS) {
        assert.ok(!source.includes(symbol), `${rel} references "${symbol}"`);
      }
    }
  });

  test('the verifier does not import or reference authentication', () => {
    const verifier = readFileSync(join(SRC, 'recovery', 'verifier.ts'), 'utf8');
    assert.ok(!IMPORTS_AUTH.test(verifier));
    for (const symbol of AUTH_SYMBOLS) {
      assert.ok(!verifier.includes(symbol), `the verifier references "${symbol}"`);
    }
  });
});

describe('auth architecture — authentication lives only at the HTTP boundary', () => {
  test('only app.ts registers the auth hook', () => {
    // Comments stripped: a doc comment in another module explaining WHERE the
    // hook is installed is documentation, not a second registration.
    const registrants = walk(SRC).filter(
      (file) => file !== AUTH && /registerAuth/.test(code(file)),
    );
    assert.deepEqual(
      registrants.map((f) => relative(SRC, f).replace(/\\/g, '/')),
      ['app.ts'],
      'registerAuth is called outside app.ts',
    );
  });

  test('no route handler performs its own authentication', () => {
    // Authentication happens once, in a hook. A route re-checking it would be
    // a second, divergent implementation.
    for (const file of walk(join(SRC, 'api')).filter((f) => f !== AUTH)) {
      const source = readFileSync(file, 'utf8');
      const rel = relative(SRC, file).replace(/\\/g, '/');
      assert.ok(!IMPORTS_AUTH.test(source), `${rel} imports auth`);
      assert.ok(!source.includes('API_AUTH_TOKEN'), `${rel} reads the auth token`);
      assert.ok(
        !/headers\.authorization|headers\[['"]x-api-key/.test(source),
        `${rel} reads a credential header directly`,
      );
    }
  });

  test('only auth.ts and config read the auth environment variables', () => {
    for (const file of walk(SRC)) {
      // Comments stripped: a comment explaining that a route is protected
      // when AUTH_ENABLED=true is documentation, not an environment read.
      const source = code(file);
      const rel = relative(SRC, file).replace(/\\/g, '/');
      if (rel === 'config/index.ts') continue;
      assert.ok(
        !source.includes('API_AUTH_TOKEN'),
        `${rel} reads API_AUTH_TOKEN directly instead of via config`,
      );
      assert.ok(!source.includes('AUTH_ENABLED'), `${rel} reads AUTH_ENABLED directly`);
    }
  });

  test('the auth module reads no environment variable itself', () => {
    // Everything arrives through the config object, so there is one place a
    // credential can enter the process.
    assert.ok(!/process\.env/.test(code(AUTH)), 'auth reads process.env directly');
  });

  test('the auth module reaches no database, provider, or domain logic', () => {
    assert.ok(!/from ['"]pg['"]/.test(authSource), 'auth imports pg');
    assert.ok(!/from ['"].*db\//.test(authSource), 'auth imports the database layer');
    assert.ok(!/from ['"].*repository/.test(authSource), 'auth imports a repository');
    assert.ok(!/from ['"].*policies\//.test(authSource), 'auth imports the policy engine');
    assert.ok(!/from ['"].*recovery\//.test(authSource), 'auth imports the recovery layer');
    assert.ok(!/from ['"].*agents\//.test(authSource), 'auth imports the AI layer');
    assert.ok(!/\bfetch\(/.test(authSource), 'auth calls fetch()');
  });

  test('the auth module cannot authorize or execute anything', () => {
    // The names that would indicate authentication had grown into
    // authorization.
    for (const forbidden of [
      'evaluatePolicy',
      'executeRecoveryAction',
      'executeRecoveryCase',
      'verifyOutcome',
      'requiresHumanApproval',
      'maxRetryAttempts',
    ]) {
      assert.ok(!authSource.includes(forbidden), `auth references "${forbidden}"`);
    }
  });

  test('the auth module never logs a credential', () => {
    // The log call must not interpolate the token or the supplied header.
    const logCalls = authSource.match(/log\.(warn|info|error|debug)\([\s\S]{0,400}?\);/g) ?? [];
    assert.ok(logCalls.length > 0, 'expected the auth module to log something');
    for (const call of logCalls) {
      assert.ok(!/expectedToken/.test(call), 'a log call references the expected token');
      assert.ok(!/credential[^s]/.test(call), 'a log call references a supplied credential');
      assert.ok(!/headers\.authorization/.test(call), 'a log call references the auth header');
    }
  });
});

describe('auth architecture — the public surface is explicit', () => {
  test('exactly one path is public', () => {
    const match = authSource.match(/PUBLIC_PATHS[^=]*=\s*\[([^\]]*)\]/);
    assert.ok(match, 'PUBLIC_PATHS was not found');
    const paths = match[1]!.match(/'[^']+'/g) ?? [];
    assert.deepEqual(paths, ["'/api/health'"], 'the public path list changed');
  });

  test('no money-moving route is on the public list', () => {
    for (const dangerous of ['execute', 'analyze', 'payments', 'recovery']) {
      assert.ok(
        !new RegExp(`PUBLIC_PATHS[^=]*=\\s*\\[[^\\]]*${dangerous}`).test(authSource),
        `"${dangerous}" appears in the public path list`,
      );
    }
  });
});

describe('auth architecture — app wiring', () => {
  const appSource = readFileSync(APP, 'utf8');

  test('auth is registered before any route', () => {
    const authIndex = appSource.indexOf('registerAuth(');
    const firstRoute = Math.min(
      ...['registerHealthRoutes(', 'registerPaymentRoutes(', 'registerRecoveryRoutes(']
        .map((name) => appSource.indexOf(name))
        .filter((i) => i > 0),
    );
    assert.ok(authIndex > 0, 'app.ts never registers auth');
    assert.ok(authIndex < firstRoute, 'auth is registered after a route');
  });

  test('the app still redacts credential headers from its logs', () => {
    // Pre-existing behaviour that authentication must not have regressed:
    // now that clients actually send these headers, redaction matters more.
    assert.ok(appSource.includes('req.headers.authorization'));
    assert.ok(appSource.includes('req.headers["x-api-key"]'));
  });
});
