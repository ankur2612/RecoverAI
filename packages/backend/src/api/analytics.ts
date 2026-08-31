import type { FastifyInstance } from 'fastify';
import { loadConfig, type AppConfig } from '../config/index.ts';
import { createAIProvider } from '../agents/diagnosis/factory.ts';
import { createRecoveryProvider } from '../payments/factory.ts';
import type { AIProvider } from '../agents/diagnosis/provider.ts';
import type { RecoveryProvider } from '../payments/provider.ts';
import { runBatchRecovery, type BatchRunSummary } from '../jobs/batch-recovery.ts';
import { getRecoveryMetrics, type RecoveryMetrics } from '../analytics/recovery-metrics.ts';
import { sweepStrandedActions, type SweepRunSummary } from '../recovery/sweep-service.ts';
import { listAuditEvents } from '../audit/repository.ts';
import {
  analyticsQuerySchema,
  batchRunRequestSchema,
  listAuditQuerySchema,
  sweepRequestSchema,
  formatZodIssues,
} from './schemas.ts';

/**
 * Batch recovery and analytics routes.
 *
 * Both sit behind the SAME authentication hook as every other protected route:
 * `registerAuth` installs an `onRequest` hook on the root instance in app.ts,
 * so these endpoints inherit it without opting in. Nothing here reads a
 * credential header, and an unauthenticated request never reaches a handler.
 *
 * Neither route makes an authorization decision. The batch endpoint delegates
 * every decision to the existing pipeline, and the analytics endpoint only
 * reads persisted rows.
 */

export interface AnalyticsRouteOptions {
  /** Injected in tests so a run uses a deterministic provider. */
  provider?: AIProvider;
  recoveryProvider?: RecoveryProvider;
  /** Injected so tests can build an app without reading the environment. */
  config?: AppConfig;
}

function serialiseRun(summary: BatchRunSummary) {
  return {
    run_id: summary.runId,
    started_at: summary.startedAt.toISOString(),
    finished_at: summary.finishedAt.toISOString(),
    total_eligible: summary.totalEligible,
    analyzed: summary.analyzed,
    authorized: summary.authorized,
    rejected: summary.rejected,
    executed: summary.executed,
    verified: summary.verified,
    recovered: summary.recovered,
    failed: summary.failed,
    skipped_duplicate: summary.skippedDuplicate,
    // Minor units (paise), matching every other money field in the API.
    amount_at_risk: summary.amountAtRisk,
    amount_recovered: summary.amountRecovered,
    items: summary.items.map((item) => ({
      payment_id: item.paymentId,
      case_id: item.caseId,
      status: item.status,
      action: item.action,
      policy_decision: item.policyDecision,
      refusal_reason: item.refusalReason,
      verification_status: item.verificationStatus,
      amount_at_risk: item.amountAtRisk,
      amount_recovered: item.amountRecovered,
      message: item.message,
    })),
  };
}

function serialiseSweep(summary: SweepRunSummary) {
  return {
    started_at: summary.startedAt.toISOString(),
    finished_at: summary.finishedAt.toISOString(),
    found: summary.found,
    resolved_success: summary.resolvedSuccess,
    resolved_failed: summary.resolvedFailed,
    still_unconfirmed: summary.stillUnconfirmed,
    already_resolved: summary.alreadyResolved,
    failed: summary.failed,
    items: summary.items.map((item) => ({
      action_id: item.actionId,
      payment_id: item.paymentId,
      case_id: item.caseId,
      stranded_in: item.strandedIn,
      outcome: item.outcome,
      observed_state: item.observedState,
      execution_status: item.executionStatus,
      verification_status: item.verificationStatus,
      message: item.message,
    })),
  };
}

function serialiseMetrics(metrics: RecoveryMetrics) {
  return {
    total_cases: metrics.totalCases,
    total_payments: metrics.totalPayments,
    amount_at_risk: metrics.amountAtRisk,
    amount_recovered: metrics.amountRecovered,
    amount_unrecovered: metrics.amountUnrecovered,
    recovery_rate: metrics.recoveryRate,
    currency_unit: 'minor' as const,
    cases_by_status: metrics.casesByStatus,
    cases_by_action: metrics.casesByAction,
    actions_by_execution_status: metrics.actionsByExecutionStatus,
    actions_by_verification_status: metrics.actionsByVerificationStatus,
    actions_by_policy_status: metrics.actionsByPolicyStatus,
    definitions: {
      amount_at_risk: 'Sum of revenue_at_risk across recovery cases, in minor units.',
      amount_recovered:
        'Sum of action amounts whose verification_status is VERIFIED, in minor units. ' +
        'AI recommendations, policy approvals, and accepted executions do NOT count.',
      recovery_rate: 'amount_recovered / amount_at_risk, or 0 when nothing was at risk.',
    },
  };
}

export async function registerAnalyticsRoutes(
  app: FastifyInstance,
  options: AnalyticsRouteOptions = {},
): Promise<void> {
  const config = options.config ?? loadConfig();
  // Built once at registration so a misconfigured provider fails at startup
  // rather than mid-run, matching the recovery routes.
  const provider = options.provider ?? createAIProvider(config);
  const recoveryProvider = options.recoveryProvider ?? createRecoveryProvider(config);

  /**
   * POST /api/recovery/runs
   *
   * Runs the EXISTING pipeline over a population of payments. It makes no
   * recovery decision of its own: policy authorization, executor idempotency,
   * verification, and audit all happen inside the services it calls.
   *
   * Re-running is safe. The executor claims a database-unique idempotency key
   * before contacting a provider, so a second run reports SKIPPED_DUPLICATE
   * rather than acting twice.
   */
  app.post('/api/recovery/runs', async (request, reply) => {
    const parsed = batchRunRequestSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'validation_error',
        message: 'The batch run request is invalid.',
        issues: formatZodIssues(parsed.error),
      });
    }

    const summary = await runBatchRecovery(
      {
        ...(parsed.data.merchant_id === undefined ? {} : { merchantId: parsed.data.merchant_id }),
        ...(parsed.data.statuses === undefined ? {} : { statuses: parsed.data.statuses }),
        ...(parsed.data.limit === undefined ? {} : { limit: parsed.data.limit }),
        ...(parsed.data.execute === undefined ? {} : { execute: parsed.data.execute }),
      },
      { provider, recoveryProvider, config },
    );

    // Run summary, logged at the HTTP boundary rather than inside the batch
    // service — that service is deliberately free of a logger dependency, and
    // its architecture tests enforce it. Counts and totals only: no payment
    // ids, no credentials, no provider payloads.
    request.log.info(
      {
        event: 'batch_run_completed',
        runId: summary.runId,
        totalEligible: summary.totalEligible,
        analyzed: summary.analyzed,
        executed: summary.executed,
        recovered: summary.recovered,
        skippedDuplicate: summary.skippedDuplicate,
        failed: summary.failed,
        // Minor units, matching every other money field in the API.
        amountAtRiskMinor: summary.amountAtRisk,
        amountRecoveredMinor: summary.amountRecovered,
        durationMs: summary.finishedAt.getTime() - summary.startedAt.getTime(),
      },
      'batch recovery run completed',
    );

    return reply.code(200).send(serialiseRun(summary));
  });

  /**
   * POST /api/recovery/sweep
   *
   * CRASH RECOVERY. Resolves actions stranded in PENDING/EXECUTING by asking
   * the provider what actually happened.
   *
   * This endpoint CANNOT execute anything. It delegates to the sweep service,
   * which reaches the provider only through getPaymentStatus — a read — and
   * has no import path to the executor. A stranded action whose outcome cannot
   * be determined stays UNCONFIRMED and is never retried.
   */
  app.post('/api/recovery/sweep', async (request, reply) => {
    const parsed = sweepRequestSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'validation_error',
        message: 'The sweep request is invalid.',
        issues: formatZodIssues(parsed.error),
      });
    }

    const summary = await sweepStrandedActions(
      {
        ...(parsed.data.min_age_seconds === undefined
          ? {}
          : { minAgeSeconds: parsed.data.min_age_seconds }),
        ...(parsed.data.limit === undefined ? {} : { limit: parsed.data.limit }),
      },
      { provider: recoveryProvider },
    );

    // Sweep summary. `stillUnconfirmed` is the number an operator most needs
    // to see: those actions remain genuinely ambiguous and are never retried.
    request.log.info(
      {
        event: 'sweep_completed',
        found: summary.found,
        resolvedSuccess: summary.resolvedSuccess,
        resolvedFailed: summary.resolvedFailed,
        stillUnconfirmed: summary.stillUnconfirmed,
        alreadyResolved: summary.alreadyResolved,
        failed: summary.failed,
        durationMs: summary.finishedAt.getTime() - summary.startedAt.getTime(),
      },
      'stranded action sweep completed',
    );

    return reply.code(200).send(serialiseSweep(summary));
  });

  /**
   * GET /api/audit
   *
   * READ ONLY view of the append-only decision log.
   *
   * Exposing a listing cannot weaken the append-only guarantee: this module
   * has no update or delete, and the database enforces the same rule with
   * triggers regardless of what any route does.
   *
   * `metadata` is returned as stored. Every writer is a RecoverAI service that
   * records decision codes, ids, and scrubbed messages — never a credential,
   * never a raw provider payload. A test asserts that.
   */
  app.get('/api/audit', async (request, reply) => {
    const parsed = listAuditQuerySchema.safeParse(request.query ?? {});
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'validation_error',
        message: 'The audit query is invalid.',
        issues: formatZodIssues(parsed.error),
      });
    }

    const result = await listAuditEvents({
      ...(parsed.data.payment_id === undefined ? {} : { paymentId: parsed.data.payment_id }),
      ...(parsed.data.case_id === undefined ? {} : { caseId: parsed.data.case_id }),
      ...(parsed.data.event_type === undefined ? {} : { eventType: parsed.data.event_type }),
      ...(parsed.data.actor === undefined ? {} : { actor: parsed.data.actor }),
      limit: parsed.data.limit,
      offset: parsed.data.offset,
    });

    return reply.code(200).send({
      events: result.events.map((event) => ({
        id: event.id,
        payment_id: event.paymentId,
        case_id: event.caseId,
        event_type: event.eventType,
        actor: event.actor,
        decision: event.decision,
        metadata: event.metadata,
        created_at: event.createdAt.toISOString(),
      })),
      // Nested to match the established list contract used by
      // GET /api/recovery/cases and GET /api/payments. An endpoint that
      // paginates differently from its siblings forces every consumer to
      // special-case it, which is exactly the kind of inconsistency that
      // produced a silent "0 cases" bug in the frontend.
      pagination: { total: result.total, limit: parsed.data.limit, offset: parsed.data.offset },
    });
  });

  /**
   * GET /api/analytics/recovery
   *
   * Read-only aggregate over persisted recovery data. Contacts no provider:
   * asking a gateway to compute a report would turn a dashboard refresh into
   * outbound API traffic, and the persisted evidence is already authoritative.
   */
  app.get('/api/analytics/recovery', async (request, reply) => {
    const parsed = analyticsQuerySchema.safeParse(request.query ?? {});
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'validation_error',
        message: 'The analytics query is invalid.',
        issues: formatZodIssues(parsed.error),
      });
    }

    const metrics = await getRecoveryMetrics(
      parsed.data.merchant_id === undefined ? {} : { merchantId: parsed.data.merchant_id },
    );

    return reply.code(200).send(serialiseMetrics(metrics));
  });
}
