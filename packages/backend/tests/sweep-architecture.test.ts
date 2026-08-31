import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * ARCHITECTURAL TESTS FOR THE CRASH-RECOVERY SWEEPER
 *
 * The sweeper touches actions whose outcome is UNKNOWN — the exact population
 * where a retry could double-charge a customer. Its safety rests on a single
 * structural property: it has no path to execution at all.
 *
 * That is enforced here at the import level, not by convention or by comment.
 */

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const SWEEP = join(SRC, 'recovery', 'sweep-service.ts');
const CLI = join(SRC, 'jobs', 'sweep-cli.ts');
const REPO = join(SRC, 'recovery', 'action-repository.ts');

/** Source with comments stripped, so prose about a rule is not a violation. */
function code(file: string): string {
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const sweepCode = code(SWEEP);
const cliCode = code(CLI);
const repoCode = code(REPO);

describe('sweep architecture — the sweeper cannot execute', () => {
  test('the sweeper NEVER calls provider.executeAction', () => {
    // THE most important assertion in this file. A stranded EXECUTING action
    // may already have moved money; calling executeAction on it is the
    // double-charge path.
    assert.ok(
      !/\.executeAction\(/.test(sweepCode),
      'the sweeper calls provider.executeAction — this is the double-charge path',
    );
    assert.ok(!/executeAction/.test(sweepCode), 'the sweeper references executeAction');
  });

  test('the sweeper does not import the executor or the execute service', () => {
    assert.ok(!/from ['"].*recovery\/executor/.test(sweepCode), 'sweeper imports the executor');
    assert.ok(
      !/from ['"].*execute-service/.test(sweepCode),
      'sweeper imports the execute service',
    );
    assert.ok(!/executeRecoveryAction/.test(sweepCode), 'sweeper can execute an action');
    assert.ok(!/executeRecoveryCase/.test(sweepCode), 'sweeper can execute a case');
  });

  test('the sweeper reaches the provider ONLY through getPaymentStatus', () => {
    // getPaymentStatus is contractually a read with no side effects.
    assert.ok(/getPaymentStatus/.test(sweepCode), 'sweeper never observes payment state');
    const providerCalls = sweepCode.match(/provider\.\w+\(/g) ?? [];
    for (const call of providerCalls) {
      assert.ok(
        call.includes('getPaymentStatus'),
        `sweeper calls ${call} on the provider; only getPaymentStatus is permitted`,
      );
    }
  });

  test('the sweeper imports no concrete provider implementation', () => {
    assert.ok(!/from ['"].*providers\/razorpay/.test(sweepCode), 'sweeper imports Razorpay');
    assert.ok(!/from ['"].*providers\/mock/.test(sweepCode), 'sweeper imports a mock');
    assert.ok(!/from ['"]razorpay['"]/.test(sweepCode), 'sweeper imports the Razorpay SDK');
    assert.ok(!/\bfetch\(/.test(sweepCode), 'sweeper calls fetch()');
  });

  test('the sweeper does not evaluate policy or re-authorize', () => {
    // Resolving a stranded action is a factual question, not an authorization
    // one. If the sweeper could authorize, it could manufacture permission.
    assert.ok(!/evaluatePolicy/.test(sweepCode), 'sweeper evaluates policy');
    assert.ok(!/buildPolicyInput/.test(sweepCode), 'sweeper builds a policy input');
    assert.ok(!/from ['"].*policies\//.test(sweepCode), 'sweeper imports the policy engine');
  });

  test('the sweeper claims no idempotency key and creates no action', () => {
    assert.ok(!/claimAction/.test(sweepCode), 'sweeper claims an action');
    assert.ok(!/buildIdempotencyKey/.test(sweepCode), 'sweeper derives an idempotency key');
    assert.ok(!/INSERT INTO/i.test(sweepCode), 'sweeper inserts rows directly');
    assert.ok(!/markExecuting/.test(sweepCode), 'sweeper moves an action back to EXECUTING');
  });

  test('the sweeper does not use the unguarded completeAction', () => {
    // completeAction has no state guard and would happily overwrite a terminal
    // verdict written by a recovering executor. The sweeper must use the
    // state-pinned resolver instead.
    assert.ok(
      !/completeAction/.test(sweepCode),
      'sweeper uses completeAction, which can overwrite a terminal verdict',
    );
    assert.ok(/resolveStrandedAction/.test(sweepCode), 'sweeper does not use the guarded resolver');
  });

  test('the sweeper delegates the business outcome to the existing verifier', () => {
    // It resolves what the PROVIDER did; whether revenue was recovered stays
    // with verifyRecoveryCase, exactly as after a normal execution.
    assert.ok(/verifyRecoveryCase/.test(sweepCode), 'sweeper never verifies the outcome');
    assert.ok(
      !/verifyOutcome\(/.test(sweepCode),
      'sweeper calls the pure verifier directly, skipping persistence and audit',
    );
  });

  test('the sweeper never touches ground truth or evaluation data', () => {
    assert.ok(!sweepCode.includes('payment_ground_truth'), 'sweeper reads the labels table');
    assert.ok(!/from ['"].*datasets\//.test(sweepCode), 'sweeper imports datasets');
    for (const label of ['groundTruth', 'idealAction', 'recoveryProbability']) {
      assert.ok(!sweepCode.includes(label), `sweeper references "${label}"`);
    }
  });

  test('the sweeper reads no environment variable or credential', () => {
    assert.ok(!/process\.env/.test(sweepCode), 'sweeper reads process.env');
    assert.ok(!sweepCode.includes('API_AUTH_TOKEN'), 'sweeper reads the auth token');
    // Excluding the scrubber, whose whole job is to NAME credential-shaped
    // fields so it can redact them. Matching it here would be a false positive.
    const withoutScrubber = sweepCode.replace(
      /export function safeSweepMessage[\s\S]*?\n}/,
      '',
    );
    assert.ok(
      !/apiKey|keySecret|razorpayKey/.test(withoutScrubber),
      'sweeper references a credential field',
    );
  });

  test('the sweeper introduces no parallelism, queue, or scheduler', () => {
    assert.ok(
      !/Promise\.all|Promise\.allSettled|Promise\.race/.test(sweepCode),
      'sweeper fans out concurrently',
    );
    assert.ok(!/setInterval|setTimeout\(/.test(sweepCode), 'sweeper schedules its own work');
    for (const dep of ['bullmq', 'ioredis', 'redis', 'node-cron', 'agenda']) {
      assert.ok(!readFileSync(SWEEP, 'utf8').includes(dep), `sweeper depends on ${dep}`);
    }
  });
});

describe('sweep architecture — the resolver is state-guarded', () => {
  test('resolveStrandedAction pins the current state to PENDING/EXECUTING', () => {
    // Without this guard, a sweep could overwrite a terminal SUCCESS that a
    // recovering executor had just written, or two sweepers could both
    // "resolve" one action.
    const fn = repoCode.slice(
      repoCode.indexOf('export async function resolveStrandedAction'),
      repoCode.indexOf('export async function listActionsForCase'),
    );
    assert.ok(fn.length > 0, 'resolveStrandedAction was not found');
    assert.ok(
      /execution_status IN \('PENDING', 'EXECUTING'\)/.test(fn),
      'resolveStrandedAction does not pin the pre-state',
    );
    assert.ok(/UPDATE recovery_actions/.test(fn), 'resolveStrandedAction does not update the row');
  });

  test('resolveStrandedAction can only write a terminal-ish status', () => {
    const fn = repoCode.slice(
      repoCode.indexOf('export async function resolveStrandedAction'),
      repoCode.indexOf('export async function listActionsForCase'),
    );
    // The type constrains it to SUCCESS | FAILED | UNCONFIRMED — never back to
    // PENDING or EXECUTING, which would re-arm an execution path.
    assert.ok(
      /'SUCCESS' \| 'FAILED' \| 'UNCONFIRMED'/.test(fn),
      'resolveStrandedAction accepts a non-terminal status',
    );
  });

  test('findStrandedActions only reads PENDING/EXECUTING', () => {
    const fn = repoCode.slice(
      repoCode.indexOf('export async function findStrandedActions'),
      repoCode.indexOf('export async function resolveStrandedAction'),
    );
    assert.ok(
      /execution_status IN \('PENDING', 'EXECUTING'\)/.test(fn),
      'the stranded query does not restrict to non-terminal states',
    );
    // And it must not sweep a row that may still be legitimately in flight.
    assert.ok(/make_interval/.test(fn), 'the stranded query has no age floor');
  });

  test('the stranded query is a read', () => {
    const fn = repoCode.slice(
      repoCode.indexOf('export async function findStrandedActions'),
      repoCode.indexOf('export async function resolveStrandedAction'),
    );
    for (const write of ['INSERT', 'DELETE', 'DROP', 'ALTER']) {
      assert.ok(!new RegExp(write, 'i').test(fn), `the stranded query issues ${write}`);
    }
  });
});

describe('sweep architecture — the job entrypoint', () => {
  test('the CLI cannot execute an action either', () => {
    assert.ok(!/executeAction/.test(cliCode), 'the sweep CLI can execute an action');
    assert.ok(!/executeRecoveryCase/.test(cliCode), 'the sweep CLI executes a case');
    assert.ok(!/from ['"].*executor/.test(cliCode), 'the sweep CLI imports the executor');
  });

  test('the CLI builds its provider through the factory', () => {
    // So the Razorpay live-key guard still applies to a sweep run.
    assert.ok(/createRecoveryProvider/.test(cliCode), 'the CLI bypasses the provider factory');
  });

  test('the CLI runs on demand, not on a timer', () => {
    assert.ok(!/setInterval/.test(cliCode), 'the sweep CLI schedules itself');
  });

  test('the CLI prints no credential', () => {
    assert.ok(!/apiKey|keySecret|API_AUTH_TOKEN|razorpayKey/.test(cliCode));
    // It may print the provider NAME, which is not a secret.
    assert.ok(!/redactedConfig\(\)\.\w*[Kk]ey/.test(cliCode));
  });
});

describe('sweep architecture — HTTP wiring', () => {
  const appSource = readFileSync(join(SRC, 'app.ts'), 'utf8');
  const routeCode = code(join(SRC, 'api', 'analytics.ts'));

  test('the sweep route is registered after the auth hook', () => {
    const authIndex = appSource.indexOf('registerAuth(');
    const routesIndex = appSource.indexOf('registerAnalyticsRoutes(');
    assert.ok(authIndex > 0 && authIndex < routesIndex, 'sweep route registered before auth');
    assert.ok(/\/api\/recovery\/sweep/.test(routeCode), 'the sweep route is not registered');
  });

  test('the sweep route delegates to the service and cannot execute', () => {
    assert.ok(/sweepStrandedActions/.test(routeCode), 'the route does not call the sweep service');
    assert.ok(!/\.executeAction\(/.test(routeCode), 'the route calls a provider directly');
  });

  test('the sweep request schema exposes no retry or force switch', () => {
    // A "force" flag would be a back door into re-execution.
    const schemaCode = code(join(SRC, 'api', 'schemas.ts'));
    const fn = schemaCode.slice(
      schemaCode.indexOf('export const sweepRequestSchema'),
      schemaCode.indexOf('export const analyticsQuerySchema'),
    );
    assert.ok(fn.length > 0, 'sweepRequestSchema was not found');
    for (const forbidden of ['retry', 'force', 'execute', 'reexecute']) {
      assert.ok(!fn.includes(forbidden), `the sweep schema exposes a "${forbidden}" field`);
    }
    assert.ok(/\.strict\(\)/.test(fn), 'the sweep schema is not strict');
  });
});
