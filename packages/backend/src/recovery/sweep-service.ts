import type { RecoveryProvider } from '../payments/provider.ts';
import { appendAuditEvent } from '../audit/repository.ts';
import { findStrandedActions, resolveStrandedAction } from './action-repository.ts';
import { verifyRecoveryCase } from './verify-service.ts';

/**
 * ============================================================================
 * CRASH RECOVERY — THE STRANDED ACTION SWEEPER
 * ============================================================================
 *
 * THE ONE RULE: this module NEVER executes anything.
 *
 * A crash can leave an action in one of two non-terminal states:
 *
 *   PENDING    the idempotency key was claimed, the provider was NOT called
 *   EXECUTING  the request was in flight; the provider MAY have acted
 *
 * EXECUTING is the dangerous one. Migration 002 states the rule plainly: such
 * a row "is exactly as ambiguous as UNCONFIRMED and must be resolved by state
 * verification, never by a blind retry". Re-executing it could charge a
 * customer twice for one recovery attempt.
 *
 * So the sweeper resolves by OBSERVATION, not action:
 *
 *   getPaymentStatus (a READ)  ->  SUCCEEDED -> SUCCESS
 *                              ->  FAILED    -> FAILED
 *                              ->  PENDING   -> UNCONFIRMED  (still ambiguous)
 *                              ->  UNKNOWN   -> UNCONFIRMED  (learned nothing)
 *
 * It imports `executeRecoveryCase` and the executor NOT AT ALL, and it never
 * calls `provider.executeAction`. Architecture tests enforce both.
 *
 * WHY PENDING IS NOT SIMPLY FAILED. A PENDING row means the provider was not
 * called *by the process that crashed*. It does not prove the provider was
 * never called at all — a different process could have owned the same key.
 * Rather than reason about that, the sweeper asks the provider and lets the
 * observation decide; an ambiguous answer stays UNCONFIRMED.
 *
 * After the execution status is resolved, the EXISTING verification service
 * establishes the business outcome. The sweeper does not decide whether
 * revenue was recovered — `verifyRecoveryCase` does, exactly as it does for a
 * normal execution.
 */

/**
 * How old a stranded row must be before it is swept.
 *
 * A row younger than this may belong to an execution that is legitimately
 * still in flight. Sweeping it would race a healthy executor: the sweeper
 * could observe a mid-flight payment and write a verdict the executor is
 * about to overwrite. Two minutes is comfortably longer than the provider
 * timeouts in this codebase.
 */
const DEFAULT_MIN_AGE_SECONDS = 120;

/** Conservative default so an accidental run cannot walk the whole table. */
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;

/** What the sweeper concluded about one stranded action. */
export const SWEEP_OUTCOMES = [
  'RESOLVED_SUCCESS',
  'RESOLVED_FAILED',
  'STILL_UNCONFIRMED',
  'ALREADY_RESOLVED',
  'ERROR',
] as const;
export type SweepOutcome = (typeof SWEEP_OUTCOMES)[number];

export interface SweepItemResult {
  actionId: string;
  paymentId: string;
  caseId: string;
  /** The state the action was stranded in. */
  strandedIn: string;
  outcome: SweepOutcome;
  /** What the provider observed, when it was asked. */
  observedState: string | null;
  /** The execution status now recorded. */
  executionStatus: string | null;
  /** The verification verdict, when verification ran afterwards. */
  verificationStatus: string | null;
  /** Safe, non-secret explanation. Never contains credentials. */
  message: string;
}

export interface SweepRunSummary {
  startedAt: Date;
  finishedAt: Date;
  /** Stranded actions the query found. */
  found: number;
  resolvedSuccess: number;
  resolvedFailed: number;
  stillUnconfirmed: number;
  alreadyResolved: number;
  failed: number;
  items: SweepItemResult[];
}

export interface SweepOptions {
  /** Minimum age of a stranded row, in seconds. Defaults to 120. */
  minAgeSeconds?: number | undefined;
  /** Maximum rows to sweep in one pass. Capped at MAX_LIMIT. */
  limit?: number | undefined;
}

export interface SweepDeps {
  provider: RecoveryProvider;
  /** Injected for determinism in tests. */
  now?: Date;
}

/**
 * Reduce an arbitrary thrown value to a safe, non-secret string.
 *
 * Mirrors the scrubbing the vendor providers and the batch runner already
 * apply. Sweep messages reach the audit trail and an HTTP response, so
 * credential-shaped text is removed rather than trusted.
 */
export function safeSweepMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw
    .replace(/rzp_(test|live)_[A-Za-z0-9]+/g, '[redacted-key]')
    .replace(/AIza[A-Za-z0-9_-]{10,}/g, '[redacted-key]')
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, '[redacted-auth]')
    .replace(/Basic\s+[A-Za-z0-9+/=]+/gi, '[redacted-auth]')
    .replace(/"(key|api_key|apiKey|token|secret|password)"\s*:\s*"[^"]*"/gi, '"$1":"[redacted]"')
    .slice(0, 300);
}

function emptySummary(at: Date): SweepRunSummary {
  return {
    startedAt: at,
    finishedAt: at,
    found: 0,
    resolvedSuccess: 0,
    resolvedFailed: 0,
    stillUnconfirmed: 0,
    alreadyResolved: 0,
    failed: 0,
    items: [],
  };
}

/**
 * Sweep stranded actions, resolving each by provider observation.
 *
 * Sequential by design. A stranded action is by definition already ambiguous;
 * fanning out concurrent provider reads would add contention with no benefit,
 * and the population is small (it is bounded by crashes, not by traffic).
 *
 * One failure never aborts the pass: each action is wrapped, the failure is
 * recorded, and the sweep continues.
 */
export async function sweepStrandedActions(
  options: SweepOptions,
  deps: SweepDeps,
): Promise<SweepRunSummary> {
  const startedAt = deps.now ?? new Date();
  const limit = Math.min(Math.max(1, options.limit ?? DEFAULT_LIMIT), MAX_LIMIT);
  const minAgeSeconds = Math.max(0, options.minAgeSeconds ?? DEFAULT_MIN_AGE_SECONDS);

  const stranded = await findStrandedActions({ olderThanSeconds: minAgeSeconds, limit });

  const summary = emptySummary(startedAt);
  summary.found = stranded.length;
  if (stranded.length === 0) {
    summary.finishedAt = deps.now ?? new Date();
    return summary;
  }

  for (const entry of stranded) {
    let item: SweepItemResult;
    try {
      item = await resolveOne(entry.action, entry.paymentId, deps);
    } catch (error) {
      item = {
        actionId: entry.action.id,
        paymentId: entry.paymentId,
        caseId: entry.action.recoveryCaseId,
        strandedIn: entry.action.executionStatus,
        outcome: 'ERROR',
        observedState: null,
        executionStatus: null,
        verificationStatus: null,
        message: safeSweepMessage(error),
      };
    }

    summary.items.push(item);
    switch (item.outcome) {
      case 'RESOLVED_SUCCESS':
        summary.resolvedSuccess += 1;
        break;
      case 'RESOLVED_FAILED':
        summary.resolvedFailed += 1;
        break;
      case 'STILL_UNCONFIRMED':
        summary.stillUnconfirmed += 1;
        break;
      case 'ALREADY_RESOLVED':
        summary.alreadyResolved += 1;
        break;
      case 'ERROR':
        summary.failed += 1;
        break;
    }
  }

  summary.finishedAt = deps.now ?? new Date();
  return summary;
}

/** Resolve one stranded action from observed provider state. */
async function resolveOne(
  action: { id: string; recoveryCaseId: string; executionStatus: string },
  paymentId: string,
  deps: SweepDeps,
): Promise<SweepItemResult> {
  const base = {
    actionId: action.id,
    paymentId,
    caseId: action.recoveryCaseId,
    strandedIn: action.executionStatus,
  };

  // ---- 1. OBSERVE. A read, never an execution. ---------------------------
  // A throw here means we learned nothing, which is UNKNOWN — never an
  // assumption in either direction.
  let observedState: string;
  let reference: string | null = null;
  let rawStatus: string | null = null;
  let lookupError: string | null = null;

  try {
    const status = await deps.provider.getPaymentStatus(paymentId);
    observedState = status.state;
    reference = status.reference;
    rawStatus = status.rawStatus;
    lookupError = status.errorMessage;
  } catch (error) {
    observedState = 'UNKNOWN';
    lookupError = safeSweepMessage(error);
  }

  // ---- 2. Map observation -> execution status ----------------------------
  //
  // Only an observably completed payment can settle an ambiguous request as
  // SUCCESS. Anything else that is not an explicit failure stays UNCONFIRMED,
  // which keeps the action out of every re-execution path.
  const executionStatus =
    observedState === 'SUCCEEDED' ? 'SUCCESS' : observedState === 'FAILED' ? 'FAILED' : 'UNCONFIRMED';

  const errorMessage =
    lookupError === null
      ? `resolved from provider observation "${observedState}" while stranded in ${action.executionStatus}`
      : `stranded in ${action.executionStatus}; provider lookup: ${safeSweepMessage(lookupError)}`;

  // ---- 3. Persist, guarded on the row STILL being stranded ---------------
  // A null return means someone else resolved it first. The database picks
  // the winner, so two concurrent sweepers cannot both resolve one action.
  const resolved = await resolveStrandedAction({
    id: action.id,
    executionStatus,
    providerReference: reference,
    errorMessage,
  });

  if (resolved === null) {
    return {
      ...base,
      outcome: 'ALREADY_RESOLVED',
      observedState,
      executionStatus: null,
      verificationStatus: null,
      message: 'The action was resolved by another process before this sweep could record it.',
    };
  }

  // ---- 4. Audit, using the EXISTING execution vocabulary ------------------
  // The actor distinguishes a swept resolution from a live execution, so an
  // auditor can tell the two apart without a new event type.
  await appendAuditEvent({
    paymentId,
    caseId: action.recoveryCaseId,
    eventType:
      executionStatus === 'SUCCESS'
        ? 'EXECUTION_SUCCEEDED'
        : executionStatus === 'FAILED'
          ? 'EXECUTION_FAILED'
          : 'EXECUTION_UNKNOWN',
    actor: 'recoverai-sweeper',
    decision: executionStatus,
    metadata: {
      actionId: action.id,
      strandedIn: action.executionStatus,
      observedState,
      providerRawStatus: rawStatus,
      resolvedBy: 'state_observation',
      note: 'provider_not_re_executed',
    },
  });

  // ---- 5. Delegate the BUSINESS outcome to the existing verifier ----------
  // The sweeper resolves what the provider did. Whether that means revenue was
  // recovered is not its call — verifyRecoveryCase decides, exactly as it does
  // after a normal execution.
  let verificationStatus: string | null = null;
  try {
    const verification = await verifyRecoveryCase(action.recoveryCaseId, {
      provider: deps.provider,
      ...(deps.now === undefined ? {} : { now: deps.now }),
    });
    verificationStatus = verification.verification?.status ?? null;
  } catch (error) {
    // The execution status is already resolved and durable. A verification
    // failure is reported but must not undo that, and must not be retried
    // here — a later verify or sweep pass can pick it up.
    return {
      ...base,
      outcome: executionStatus === 'SUCCESS' ? 'RESOLVED_SUCCESS' : 'RESOLVED_FAILED',
      observedState,
      executionStatus,
      verificationStatus: null,
      message: `Execution resolved; verification failed: ${safeSweepMessage(error)}`,
    };
  }

  return {
    ...base,
    outcome:
      executionStatus === 'SUCCESS'
        ? 'RESOLVED_SUCCESS'
        : executionStatus === 'FAILED'
          ? 'RESOLVED_FAILED'
          : 'STILL_UNCONFIRMED',
    observedState,
    executionStatus,
    verificationStatus,
    message: errorMessage,
  };
}
