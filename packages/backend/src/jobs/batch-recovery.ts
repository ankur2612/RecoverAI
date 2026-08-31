import { randomUUID } from 'node:crypto';
import type { AppConfig } from '../config/index.ts';
import type { AIProvider } from '../agents/diagnosis/provider.ts';
import type { RecoveryProvider } from '../payments/provider.ts';
import type { Payment, PaymentStatus, RecoveryActionType } from '../shared/types.ts';
import { listPayments } from '../payments/repository.ts';
import { analyzePayment } from '../recovery/analyze.ts';
import { executeRecoveryCase } from '../recovery/execute-service.ts';
import { verifyRecoveryCase } from '../recovery/verify-service.ts';
import { findPaymentsWithCompletedActions } from '../recovery/action-repository.ts';

/**
 * ============================================================================
 * BATCH RECOVERY RUN
 * ============================================================================
 *
 * THIS MODULE IS AN ORCHESTRATOR. It contains no recovery logic of its own.
 *
 * Every decision is made by the existing pipeline, called in the existing
 * order:
 *
 *   analyzePayment      -> risk detection, AI diagnosis, POLICY AUTHORIZATION
 *   executeRecoveryCase -> re-evaluates policy, then the executor
 *   verifyRecoveryCase  -> reads provider evidence, decides the outcome
 *
 * What this module deliberately does NOT do:
 *   - it never calls a payment provider directly
 *   - it never evaluates a policy
 *   - it never decides that an action is authorized
 *   - it never writes an audit event (each service writes its own)
 *   - it never touches ground-truth / evaluation labels
 *   - it never implements its own idempotency
 *
 * Idempotency is NOT re-implemented here. The executor claims a database
 * UNIQUE idempotency key before any provider call, so a second run over the
 * same population produces SKIPPED_DUPLICATE rather than a second charge.
 * The batch layer merely counts what the executor reports.
 *
 * Architecture tests enforce these boundaries at the import level.
 */

/** Terminal-ish payment states a recovery run should consider. */
const DEFAULT_ELIGIBLE_STATUSES: readonly PaymentStatus[] = ['failed', 'abandoned'];

/** Hard ceiling on one run, so an accidental call cannot walk a whole table. */
const MAX_RUN_LIMIT = 1000;
const DEFAULT_RUN_LIMIT = 100;

/**
 * How far a single payment got.
 *
 * These are batch-level observations, not new domain states: each maps
 * directly onto what the underlying service already reported.
 */
export const BATCH_ITEM_STATUSES = [
  'RECOVERED',
  'NOT_RECOVERED',
  'UNCONFIRMED',
  'EXECUTED_UNVERIFIED',
  'REFUSED',
  'NOT_AUTHORIZED',
  'SKIPPED_DUPLICATE',
  'NO_CASE',
  'ERROR',
] as const;
export type BatchItemStatus = (typeof BATCH_ITEM_STATUSES)[number];

export interface BatchItemResult {
  paymentId: string;
  caseId: string | null;
  status: BatchItemStatus;
  /** The action the policy engine authorized, when there was one. */
  action: RecoveryActionType | null;
  /** Policy verdict for this payment, verbatim from the policy engine. */
  policyDecision: string | null;
  /** Executor refusal reason, when the attempt was refused before acting. */
  refusalReason: string | null;
  /** Verification verdict, when verification ran. */
  verificationStatus: string | null;
  /** Amount considered at risk for this payment, in minor units. */
  amountAtRisk: number;
  /** Amount proven recovered by evidence, in minor units. Zero unless VERIFIED. */
  amountRecovered: number;
  /** Safe, non-secret explanation. Never contains credentials. */
  message: string;
}

export interface BatchRunSummary {
  runId: string;
  startedAt: Date;
  finishedAt: Date;
  /** Payments selected by the eligibility query. */
  totalEligible: number;
  analyzed: number;
  /** Cases the policy engine authorized for execution. */
  authorized: number;
  /** Cases the policy engine did not authorize (blocked or approval-gated). */
  rejected: number;
  /** Cases where a provider request was actually sent. */
  executed: number;
  /** Cases where verification produced a verdict. */
  verified: number;
  /** Cases proven recovered by evidence. */
  recovered: number;
  /** Cases that errored unexpectedly. The run continued past each. */
  failed: number;
  /** Cases the executor skipped because the idempotency key was taken. */
  skippedDuplicate: number;
  /** Sum of amounts at risk across the population, in minor units. */
  amountAtRisk: number;
  /** Sum of VERIFIED recovered amounts, in minor units. */
  amountRecovered: number;
  items: BatchItemResult[];
}

export interface BatchRunOptions {
  /** Restrict the run to one merchant. */
  merchantId?: string | undefined;
  /** Payment statuses treated as eligible. Defaults to failed + abandoned. */
  statuses?: readonly PaymentStatus[] | undefined;
  /** Maximum payments to consider. Capped at MAX_RUN_LIMIT. */
  limit?: number | undefined;
  /**
   * When false, the run analyzes and authorizes but never executes.
   * A dry run touches no payment provider at all.
   */
  execute?: boolean | undefined;
}

export interface BatchRunDeps {
  provider: AIProvider;
  recoveryProvider: RecoveryProvider;
  config: AppConfig;
  /** Injected for determinism in tests. */
  now?: Date;
}

/** An empty run, so callers get a well-formed summary even with no work. */
function emptySummary(runId: string, at: Date): BatchRunSummary {
  return {
    runId,
    startedAt: at,
    finishedAt: at,
    totalEligible: 0,
    analyzed: 0,
    authorized: 0,
    rejected: 0,
    executed: 0,
    verified: 0,
    recovered: 0,
    failed: 0,
    skippedDuplicate: 0,
    amountAtRisk: 0,
    amountRecovered: 0,
    items: [],
  };
}

/**
 * Reduce an arbitrary thrown value to a safe, non-secret string.
 *
 * A provider error can echo a request, and this message is returned over HTTP,
 * so credential-shaped text is scrubbed rather than trusted. Mirrors the
 * scrubbing the vendor providers already apply to their own errors.
 */
export function safeFailureMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw
    .replace(/rzp_(test|live)_[A-Za-z0-9]+/g, '[redacted-key]')
    .replace(/AIza[A-Za-z0-9_-]{10,}/g, '[redacted-key]')
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, '[redacted-auth]')
    .replace(/Basic\s+[A-Za-z0-9+/=]+/gi, '[redacted-auth]')
    .replace(/"(key|api_key|apiKey|token|secret|password)"\s*:\s*"[^"]*"/gi, '"$1":"[redacted]"')
    .slice(0, 300);
}

/**
 * Run one recovery pass over a population of payments.
 *
 * Processing is SEQUENTIAL. That is deliberate: the pipeline writes recovery
 * cases, actions, and audit events per payment, and a bounded-but-parallel
 * version would buy throughput at the cost of making a failure harder to
 * reason about. Nothing about the demo scale requires more, and the executor's
 * idempotency — not batch concurrency — is what makes re-runs safe.
 *
 * One payment failing NEVER aborts the run: each iteration is wrapped, the
 * failure is recorded as an item, and the loop continues.
 */
export async function runBatchRecovery(
  options: BatchRunOptions,
  deps: BatchRunDeps,
): Promise<BatchRunSummary> {
  const runId = `run_${randomUUID()}`;
  const startedAt = deps.now ?? new Date();
  const shouldExecute = options.execute ?? true;

  const limit = Math.min(
    Math.max(1, options.limit ?? DEFAULT_RUN_LIMIT),
    MAX_RUN_LIMIT,
  );
  const statuses = options.statuses ?? DEFAULT_ELIGIBLE_STATUSES;

  // Eligibility uses the EXISTING payment listing query. One call per status,
  // because listPayments filters on a single status by design.
  const payments: Payment[] = [];
  for (const status of statuses) {
    if (payments.length >= limit) break;
    const page = await listPayments({
      ...(options.merchantId === undefined ? {} : { merchantId: options.merchantId }),
      status,
      limit: limit - payments.length,
      offset: 0,
    });
    payments.push(...page.payments);
  }

  if (payments.length === 0) {
    return emptySummary(runId, startedAt);
  }

  // ---- RE-RUN GUARD -------------------------------------------------------
  //
  // Screen out payments that already have a completed action.
  //
  // Per-CASE idempotency is guaranteed by the database UNIQUE key and is not
  // duplicated here. But a case that reached a terminal status is no longer
  // "live", so re-analysing its payment would create a SECOND case with a
  // legitimately different key — and the executor would correctly allow it.
  // Without this screen, running the same batch three times would send three
  // provider requests for one payment.
  //
  // The screen belongs here rather than in the executor: the executor's
  // contract is "one action per authorized case", and it is honouring it.
  // Deciding that a payment has already been ATTEMPTED is a population-level
  // question, which is exactly what the batch layer is for.
  const alreadyAttempted = shouldExecute
    ? await findPaymentsWithCompletedActions(payments.map((p) => p.id))
    : new Set<string>();

  const summary = emptySummary(runId, startedAt);
  summary.totalEligible = payments.length;

  for (const payment of payments) {
    if (alreadyAttempted.has(payment.id)) {
      summary.items.push({
        paymentId: payment.id,
        caseId: null,
        status: 'SKIPPED_DUPLICATE',
        action: null,
        policyDecision: null,
        refusalReason: null,
        verificationStatus: null,
        amountAtRisk: payment.amount,
        amountRecovered: 0,
        message: 'A recovery action has already been executed for this payment.',
      });
      summary.amountAtRisk += payment.amount;
      summary.analyzed += 1;
      summary.skippedDuplicate += 1;
      continue;
    }

    let item: BatchItemResult;
    try {
      item = await processOnePayment(payment, shouldExecute, deps);
    } catch (error) {
      // A single payment must never abort the run. The failure is recorded
      // with a scrubbed message and the loop continues.
      item = {
        paymentId: payment.id,
        caseId: null,
        status: 'ERROR',
        action: null,
        policyDecision: null,
        refusalReason: null,
        verificationStatus: null,
        amountAtRisk: payment.amount,
        amountRecovered: 0,
        message: safeFailureMessage(error),
      };
    }

    summary.items.push(item);
    summary.amountAtRisk += item.amountAtRisk;
    summary.amountRecovered += item.amountRecovered;

    if (item.status === 'ERROR') summary.failed += 1;
    else summary.analyzed += 1;

    if (item.status === 'NOT_AUTHORIZED' || item.status === 'REFUSED') summary.rejected += 1;
    if (item.policyDecision === 'ALLOWED') summary.authorized += 1;
    if (item.status === 'SKIPPED_DUPLICATE') summary.skippedDuplicate += 1;
    if (
      item.status === 'RECOVERED' ||
      item.status === 'NOT_RECOVERED' ||
      item.status === 'UNCONFIRMED' ||
      item.status === 'EXECUTED_UNVERIFIED'
    ) {
      summary.executed += 1;
    }
    if (item.verificationStatus !== null) summary.verified += 1;
    if (item.status === 'RECOVERED') summary.recovered += 1;
  }

  summary.finishedAt = deps.now ?? new Date();
  return summary;
}

/**
 * One payment through the existing pipeline.
 *
 * Analyze -> (execute) -> (verify). Each step short-circuits on the previous
 * step's verdict; nothing here second-guesses a service's decision.
 */
async function processOnePayment(
  payment: Payment,
  shouldExecute: boolean,
  deps: BatchRunDeps,
): Promise<BatchItemResult> {
  const base: BatchItemResult = {
    paymentId: payment.id,
    caseId: null,
    status: 'NO_CASE',
    action: null,
    policyDecision: null,
    refusalReason: null,
    verificationStatus: null,
    amountAtRisk: 0,
    amountRecovered: 0,
    message: '',
  };

  // ---- 1. ANALYZE: risk detection + AI diagnosis + POLICY AUTHORIZATION ---
  const analysis = await analyzePayment(payment, {
    provider: deps.provider,
    config: deps.config,
    ...(deps.now === undefined ? {} : { now: deps.now }),
  });

  if (analysis.recoveryCase === null) {
    return {
      ...base,
      message: analysis.assessment.atRisk
        ? 'No recovery case was warranted for this payment.'
        : 'Payment is not at risk.',
    };
  }

  const recoveryCase = analysis.recoveryCase;
  const withCase: BatchItemResult = {
    ...base,
    caseId: recoveryCase.id,
    action: recoveryCase.recommendedAction,
    // Amount at risk is the case's own figure, not a batch re-derivation.
    amountAtRisk: recoveryCase.revenueAtRisk,
    policyDecision: analysis.policy?.decision ?? null,
  };

  // The policy engine's verdict is final. The batch layer does not override
  // it, retry it, or look for a second opinion.
  if (analysis.policy === null || !analysis.policy.authorized) {
    return {
      ...withCase,
      status: 'NOT_AUTHORIZED',
      message:
        analysis.policy === null
          ? 'No action required authorization.'
          : `Policy did not authorize this action (${analysis.policy.decision}).`,
    };
  }

  if (!shouldExecute) {
    return {
      ...withCase,
      status: 'NOT_AUTHORIZED',
      message: 'Dry run: authorized but not executed.',
    };
  }

  // ---- 2. EXECUTE: re-evaluates policy, then the executor ----------------
  // executeRecoveryCase deliberately re-runs authorization against CURRENT
  // state rather than trusting the verdict computed moments ago.
  const execution = await executeRecoveryCase(recoveryCase.id, {
    provider: deps.recoveryProvider,
    config: deps.config,
    ...(deps.now === undefined ? {} : { now: deps.now }),
  });

  if (execution.execution === null) {
    return {
      ...withCase,
      status: 'REFUSED',
      message: execution.message,
    };
  }

  const result = execution.execution;

  if (result.refusalReason !== null) {
    return {
      ...withCase,
      status: 'REFUSED',
      refusalReason: result.refusalReason,
      message: result.message,
    };
  }

  // The executor's own duplicate signal, produced by the database UNIQUE
  // constraint on the idempotency key. This is what makes a re-run safe.
  if (result.outcome === 'SKIPPED_DUPLICATE') {
    return {
      ...withCase,
      status: 'SKIPPED_DUPLICATE',
      message: 'An action for this case and policy version already exists.',
    };
  }

  // ---- 3. VERIFY: provider evidence decides the business outcome ---------
  const verification = await verifyRecoveryCase(recoveryCase.id, {
    provider: deps.recoveryProvider,
    ...(deps.now === undefined ? {} : { now: deps.now }),
  });

  if (verification.verification === null) {
    return {
      ...withCase,
      status: 'EXECUTED_UNVERIFIED',
      message: verification.message,
    };
  }

  const verdict = verification.verification;
  const verified: BatchItemResult = {
    ...withCase,
    verificationStatus: verdict.status,
    message: verdict.reason,
  };

  // RECOVERED revenue counts ONLY on a VERIFIED verdict. An execution that
  // succeeded, or an action the policy allowed, is not recovered revenue.
  if (verdict.status === 'VERIFIED' && verdict.recovered) {
    return {
      ...verified,
      status: 'RECOVERED',
      amountRecovered: recoveryCase.revenueAtRisk,
    };
  }
  if (verdict.status === 'NOT_RECOVERED') {
    return { ...verified, status: 'NOT_RECOVERED' };
  }
  return { ...verified, status: 'UNCONFIRMED' };
}
