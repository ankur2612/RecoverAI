import type { FastifyInstance } from 'fastify';
import { loadConfig } from '../config/index.ts';
import { createAIProvider } from '../agents/diagnosis/factory.ts';
import type { AIProvider } from '../agents/diagnosis/provider.ts';
import { findPaymentById } from '../payments/repository.ts';
import { analyzePayment } from '../recovery/analyze.ts';
import {
  DuplicateOpenCaseError,
  listRecoveryCases,
  type RecoveryCase,
} from '../recovery/repository.ts';
import { analyzeRequestSchema, listCasesQuerySchema, formatZodIssues } from './schemas.ts';
import { serialisePayment } from './payments.ts';
import { executeRecoveryCase } from '../recovery/execute-service.ts';
import { createRecoveryProvider } from '../payments/factory.ts';
import type { RecoveryProvider } from '../payments/provider.ts';
import { listActionsForCase, type RecoveryAction } from '../recovery/action-repository.ts';
import { verifyRecoveryCase } from '../recovery/verify-service.ts';

function serialiseCase(recoveryCase: RecoveryCase) {
  return {
    id: recoveryCase.id,
    payment_id: recoveryCase.paymentId,
    risk_score: recoveryCase.riskScore,
    recoverability_score: recoveryCase.recoverabilityScore,
    classification: recoveryCase.classification,
    recommended_action: recoveryCase.recommendedAction,
    confidence: recoveryCase.confidence,
    revenue_at_risk: recoveryCase.revenueAtRisk,
    reason: recoveryCase.reason,
    status: recoveryCase.status,
    created_at: recoveryCase.createdAt.toISOString(),
    updated_at: recoveryCase.updatedAt.toISOString(),
  };
}

export interface RecoveryRouteOptions {
  /** Injected in tests; defaults to the configured provider. */
  provider?: AIProvider;
  /** Injected in tests; defaults to the configured recovery provider. */
  recoveryProvider?: RecoveryProvider;
}

function serialiseAction(action: RecoveryAction) {
  return {
    id: action.id,
    recovery_case_id: action.recoveryCaseId,
    action_type: action.actionType,
    policy_status: action.policyStatus,
    policy_version: action.policyVersion,
    execution_status: action.executionStatus,
    amount: action.amount,
    idempotency_key: action.idempotencyKey,
    provider: action.provider,
    provider_reference: action.providerReference,
    error_message: action.errorMessage,
    verification_status: action.verificationStatus,
    verification_reason: action.verificationReason,
    verified_at: action.verifiedAt === null ? null : action.verifiedAt.toISOString(),
    observed_payment_status: action.observedPaymentStatus,
    verification_attempts: action.verificationAttempts,
    created_at: action.createdAt.toISOString(),
    executed_at: action.executedAt === null ? null : action.executedAt.toISOString(),
    completed_at: action.completedAt === null ? null : action.completedAt.toISOString(),
  };
}

export async function registerRecoveryRoutes(
  app: FastifyInstance,
  options: RecoveryRouteOptions = {},
): Promise<void> {
  const config = loadConfig();
  // Constructed once at registration so a misconfigured provider fails at
  // startup rather than on the first request.
  const provider = options.provider ?? createAIProvider(config);
  // Constructed at registration so a misconfigured provider fails at startup
  // rather than on the first execution request.
  const recoveryProvider = options.recoveryProvider ?? createRecoveryProvider(config);

  /**
   * POST /api/recovery/analyze
   *
   * ANALYSIS ONLY. This endpoint runs deterministic risk detection, asks the
   * configured AI provider for a recommendation, validates that recommendation
   * against a strict schema, and records a recovery case.
   *
   * It authorizes but never acts: execution lives behind
   * POST /api/recovery/:caseId/execute, which re-validates policy first.
   */
  app.post('/api/recovery/analyze', async (request, reply) => {
    const parsed = analyzeRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'validation_error',
        message: 'The analyze request is invalid.',
        issues: formatZodIssues(parsed.error),
      });
    }

    const payment = await findPaymentById(parsed.data.payment_id);
    if (payment === null) {
      return reply.code(404).send({
        error: 'not_found',
        message: `Payment ${parsed.data.payment_id} was not found.`,
      });
    }

    try {
      const result = await analyzePayment(payment, { provider, config });

      return reply.code(200).send({
        payment: serialisePayment(result.payment),
        risk: {
          at_risk: result.assessment.atRisk,
          revenue_at_risk: result.assessment.revenueAtRisk,
          classification: result.assessment.classification,
          recoverability: result.assessment.recoverability,
          recoverability_score: result.assessment.recoverabilityScore,
          risk_score: result.assessment.riskScore,
          baseline_action: result.assessment.baselineAction,
          requires_human_review: result.assessment.requiresHumanReview,
          factors: result.assessment.factors,
          reason: result.assessment.reason,
        },
        diagnosis:
          result.diagnosis === null
            ? null
            : {
                classification: result.diagnosis.classification,
                confidence: result.diagnosis.confidence,
                reason: result.diagnosis.reason,
                recommended_action: result.diagnosis.recommendedAction,
                expected_recovery_probability: result.diagnosis.expectedRecoveryProbability,
                requires_human_approval: result.diagnosis.requiresHumanApproval,
                provider: result.diagnosis.provider,
                model: result.diagnosis.model,
              },
        diagnosis_error: result.diagnosisError,
        policy:
          result.policy === null
            ? null
            : {
                decision: result.policy.decision,
                authorized: result.policy.authorized,
                requires_human_approval: result.policy.requiresHumanApproval,
                action: result.policy.action,
                denial_reasons: result.policy.denialReasons,
                approval_reasons: result.policy.approvalReasons,
                // Only rules that actually bore on the decision are surfaced;
                // NOT_APPLICABLE entries are internal noise for an operator.
                rules: result.policy.rules
                  .filter((rule) => rule.status !== 'NOT_APPLICABLE')
                  .map((rule) => ({
                    rule: rule.rule,
                    status: rule.status,
                    code: rule.code,
                    reason: rule.reason,
                  })),
                policy_version: result.policy.policyVersion,
              },
        recovery_case: result.recoveryCase === null ? null : serialiseCase(result.recoveryCase),
        existing_case: result.existingCase,
        // `authorized` is the deterministic policy verdict. `executed` stays
        // false here by design: analysis never acts, even when authorized.
        authorized: result.policy?.authorized ?? false,
        executed: false,
      });
    } catch (error) {
      if (error instanceof DuplicateOpenCaseError) {
        return reply.code(409).send({
          error: 'duplicate_case',
          message: `Payment ${error.paymentId} already has a live recovery case.`,
        });
      }
      throw error;
    }
  });

  /**
   * POST /api/recovery/:caseId/execute
   *
   * The only endpoint that can cause a real recovery action.
   *
   * It performs no authorization of its own: the execution service re-runs the
   * policy engine against CURRENT payment state before the executor is
   * reached, so a stale analysis-time verdict can never authorize execution.
   *
   * The route holds no business logic; it adapts HTTP to the service and maps
   * the outcome onto a status code.
   */
  app.post<{ Params: { caseId: string } }>(
    '/api/recovery/:caseId/execute',
    async (request, reply) => {
      const { caseId } = request.params;
      if (typeof caseId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(caseId)) {
        return reply.code(400).send({
          error: 'validation_error',
          message: 'The recovery case id is invalid.',
        });
      }

      const result = await executeRecoveryCase(caseId, {
        provider: recoveryProvider,
        config,
      });

      if (result.failure !== null) {
        const status = result.failure === 'CASE_NOT_ACTIONABLE' ? 409 : 404;
        return reply.code(status).send({
          error: result.failure.toLowerCase(),
          message: result.message,
        });
      }

      const execution = result.execution!;

      // A refusal is a client-visible conflict, not a server error: the request
      // was well-formed but policy does not permit it right now.
      const status =
        execution.outcome === 'REFUSED'
          ? execution.refusalReason === 'REQUIRES_HUMAN_APPROVAL'
            ? 403
            : 409
          : 200;

      return reply.code(status).send({
        case_id: caseId,
        // "A provider request was sent", NOT "the payment was recovered".
        executed: execution.executed,
        outcome: execution.outcome,
        // Always false in this phase: a provider acknowledgement is not
        // evidence of recovered revenue. Verification comes later.
        verified: execution.verified,
        refusal_reason: execution.refusalReason,
        policy_decision: result.policyDecision,
        idempotency_key: result.idempotencyKey,
        provider: execution.provider,
        action: execution.action === null ? null : serialiseAction(execution.action),
        message: execution.message,
      });
    },
  );

  /**
   * POST /api/recovery/:caseId/verify
   *
   * Establishes the BUSINESS OUTCOME from evidence.
   *
   * This is the endpoint that answers "was the revenue actually recovered?".
   * It reads provider and payment state; it never executes, never retries —
   * not even an ambiguous action — and never consults the AI or policy layers.
   */
  app.post<{ Params: { caseId: string } }>(
    '/api/recovery/:caseId/verify',
    async (request, reply) => {
      const { caseId } = request.params;
      if (typeof caseId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(caseId)) {
        return reply.code(400).send({
          error: 'validation_error',
          message: 'The recovery case id is invalid.',
        });
      }

      const result = await verifyRecoveryCase(caseId, { provider: recoveryProvider });

      if (result.failure !== null) {
        // Nothing executed is a conflict, not a missing resource: the case
        // exists but has no outcome to establish.
        const status = result.failure === 'NO_EXECUTION_TO_VERIFY' ? 409 : 404;
        return reply.code(status).send({
          error: result.failure.toLowerCase(),
          message: result.message,
        });
      }

      const verification = result.verification!;

      return reply.code(200).send({
        case_id: caseId,
        verification_status: verification.status,
        // The single fact that matters, and the only place it is asserted.
        recovered: verification.recovered,
        reason: verification.reason,
        verified_at: verification.verifiedAt,
        already_verified: result.alreadyVerified,
        evidence: verification.evidence.map((item) => ({
          type: item.type,
          source: item.source,
          value: item.value,
          reference: item.reference,
          observed_at: item.observedAt,
          detail: item.detail,
        })),
        case_status: result.recoveryCase?.status ?? null,
        action: result.action === null ? null : serialiseAction(result.action),
      });
    },
  );

  /** GET /api/recovery/:caseId/actions — execution history for one case. */
  app.get<{ Params: { caseId: string } }>(
    '/api/recovery/:caseId/actions',
    async (request, reply) => {
      const actions = await listActionsForCase(request.params.caseId);
      return reply.send({ actions: actions.map(serialiseAction) });
    },
  );

  /** GET /api/recovery/cases — list recovery cases. */
  app.get('/api/recovery/cases', async (request, reply) => {
    const parsed = listCasesQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'validation_error',
        message: 'The query parameters are invalid.',
        issues: formatZodIssues(parsed.error),
      });
    }

    const { status, limit, offset } = parsed.data;
    const result = await listRecoveryCases({ status, limit, offset });

    return reply.send({
      cases: result.cases.map(serialiseCase),
      pagination: { total: result.total, limit, offset },
    });
  });
}
