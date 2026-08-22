import { randomUUID } from 'node:crypto';
import type { AppConfig } from '../config/index.ts';
import type { Payment, RecoveryCaseStatus } from '../shared/types.ts';
import { assessRisk } from '../risk/detector.ts';
import type { RiskAssessment } from '../risk/types.ts';
import { getCustomerHistory } from '../payments/repository.ts';
import { buildDiagnosisInput } from '../agents/diagnosis/input.ts';
import type { AIProvider } from '../agents/diagnosis/provider.ts';
import type { DiagnosisResult } from '../agents/diagnosis/types.ts';
import { DiagnosisValidationError } from '../agents/diagnosis/types.ts';
import { evaluatePolicy } from '../policies/engine.ts';
import { buildPolicyInput } from '../policies/input.ts';
import type { PolicyResult } from '../policies/types.ts';
import { appendAuditEvent } from '../audit/repository.ts';
import {
  findLiveCaseForPayment,
  insertRecoveryCase,
  type RecoveryCase,
} from './repository.ts';

/**
 * The analysis pipeline:
 *
 *   payment -> deterministic risk detection -> sealed DiagnosisInput
 *           -> AI provider -> strict validation
 *           -> deterministic policy engine (AUTHORIZATION)
 *           -> recovery case
 *
 * What this pipeline deliberately does NOT do:
 *   - it does not execute anything
 *   - it does not touch a payment provider
 *   - it does not modify payment state
 *
 * Authorization is now a real computed decision. Execution is not: an
 * authorized case is permission to act, and the executor that would act on it
 * does not exist yet.
 */

export interface AnalyzeResult {
  payment: Payment;
  assessment: RiskAssessment;
  /** Null when the payment is not at risk, or when the AI step failed. */
  diagnosis: DiagnosisResult | null;
  /**
   * The deterministic authorization decision for the recommended action.
   * Null only when there was no action to authorize (payment not at risk).
   */
  policy: PolicyResult | null;
  /** Null when nothing warranted a case. */
  recoveryCase: RecoveryCase | null;
  /** Set when the AI step failed and the deterministic baseline was used. */
  diagnosisError: string | null;
  /** True when an existing live case was returned instead of a new one. */
  existingCase: boolean;
}

export interface AnalyzeDeps {
  provider: AIProvider;
  config: AppConfig;
  /** Injected for determinism in tests. */
  now?: Date;
}

/**
 * Analyze one payment.
 *
 * The AI is one step in the middle, and a non-fatal one: if the provider
 * throws or returns something the validator rejects, the deterministic
 * assessment still stands and the case is created from the baseline with the
 * failure recorded. The system degrades to rules rather than to nothing.
 */
export async function analyzePayment(
  payment: Payment,
  deps: AnalyzeDeps,
): Promise<AnalyzeResult> {
  const { provider, config } = deps;
  const now = deps.now ?? new Date();

  // ---- 1. Deterministic detection (no AI involved) -----------------------
  const history = await getCustomerHistory(payment.customerId, payment.id);
  const assessment = assessRisk({ payment, customerHistory: history, now }, config.policy);

  await appendAuditEvent({
    paymentId: payment.id,
    caseId: null,
    eventType: 'RISK_ASSESSED',
    actor: 'recoverai-detector',
    decision: assessment.atRisk ? 'AT_RISK' : 'NOT_AT_RISK',
    metadata: {
      classification: assessment.classification,
      recoverability: assessment.recoverability,
      riskScore: assessment.riskScore,
      revenueAtRisk: assessment.revenueAtRisk,
      baselineAction: assessment.baselineAction,
      factors: assessment.factors,
    },
  });

  // A captured payment is not revenue at risk. No case, no AI call.
  if (!assessment.atRisk) {
    return {
      payment,
      assessment,
      diagnosis: null,
      policy: null,
      recoveryCase: null,
      diagnosisError: null,
      existingCase: false,
    };
  }

  // Idempotence at the analysis layer: re-analyzing a payment that already has
  // a live case returns that case rather than creating a competing one.
  const existing = await findLiveCaseForPayment(payment.id);
  if (existing !== null) {
    return {
      payment,
      assessment,
      diagnosis: null,
      policy: null,
      recoveryCase: existing,
      diagnosisError: null,
      existingCase: true,
    };
  }

  // ---- 2. AI diagnosis (recommendation only) -----------------------------
  let diagnosis: DiagnosisResult | null = null;
  let diagnosisError: string | null = null;

  if (assessment.requiresAiDiagnosis) {
    // buildDiagnosisInput enforces the ground-truth boundary.
    const input = buildDiagnosisInput({
      payment,
      customerHistory: history,
      assessment,
      policy: config.policy,
    });

    try {
      diagnosis = await provider.diagnose(input);
      await appendAuditEvent({
        paymentId: payment.id,
        caseId: null,
        eventType: 'AI_DIAGNOSIS',
        actor: `ai:${provider.name}`,
        decision: diagnosis.recommendedAction,
        metadata: {
          classification: diagnosis.classification,
          confidence: diagnosis.confidence,
          expectedRecoveryProbability: diagnosis.expectedRecoveryProbability,
          requiresHumanApproval: diagnosis.requiresHumanApproval,
          model: diagnosis.model,
          // Recorded so the audit trail shows this was a recommendation,
          // never an execution.
          note: 'recommendation_only',
        },
      });
    } catch (error) {
      // A provider failure must never take down analysis. Fall back to the
      // deterministic baseline and record why.
      diagnosisError =
        error instanceof DiagnosisValidationError
          ? `invalid_response: ${error.message}`
          : `provider_error: ${(error as Error).message}`;

      await appendAuditEvent({
        paymentId: payment.id,
        caseId: null,
        eventType: 'DIAGNOSIS_FAILED',
        actor: `ai:${provider.name}`,
        decision: 'FALLBACK_TO_DETERMINISTIC',
        metadata: { error: diagnosisError },
      });
    }
  }

  // When the AI is unavailable or rejected, the deterministic baseline is what
  // gets recorded — never a fabricated confidence.
  const recommendedAction = diagnosis?.recommendedAction ?? assessment.baselineAction;
  const classification = diagnosis?.classification ?? assessment.classification;
  const confidence = diagnosis?.confidence ?? assessment.recoverabilityScore;

  // ---- 3. Deterministic authorization -------------------------------------
  // The recommendation is now an INPUT to policy, not an instruction. Nothing
  // the AI returned can widen a limit or skip a rule.
  const policy = evaluatePolicy(
    buildPolicyInput({
      payment,
      assessment,
      proposedAction: recommendedAction,
      confidence,
      // No executor exists yet, so no recovery action has ever been written.
      // The database's UNIQUE idempotency key is the enforcement point once
      // one does; this stays false rather than pretending to have checked.
      duplicateActionExists: false,
      humanReviewRequested:
        assessment.requiresHumanReview || (diagnosis?.requiresHumanApproval ?? false),
    }),
    config.policy,
  );

  await appendAuditEvent({
    paymentId: payment.id,
    caseId: null,
    eventType: 'POLICY_EVALUATED',
    actor: 'recoverai-policy',
    decision: policy.decision,
    metadata: {
      action: policy.action,
      authorized: policy.authorized,
      requiresHumanApproval: policy.requiresHumanApproval,
      denialReasons: policy.denialReasons,
      approvalReasons: policy.approvalReasons,
      policyVersion: policy.policyVersion,
    },
  });

  // ---- 4. Persist the recovery case ---------------------------------------
  // The case status now reflects the POLICY decision, not a guess. A case that
  // policy did not authorize is never recorded as ready to act on.
  const status: Extract<RecoveryCaseStatus, 'OPEN' | 'ESCALATED' | 'AWAITING_APPROVAL'> =
    policy.authorized
      ? 'OPEN'
      : policy.requiresHumanApproval
        ? 'AWAITING_APPROVAL'
        : 'ESCALATED';

  const recoveryCase = await insertRecoveryCase({
    id: `rc_${randomUUID()}`,
    paymentId: payment.id,
    riskScore: assessment.riskScore,
    recoverabilityScore: assessment.recoverabilityScore,
    classification,
    recommendedAction,
    confidence,
    revenueAtRisk: assessment.revenueAtRisk,
    reason: diagnosis?.reason ?? assessment.reason,
    status,
  });

  await appendAuditEvent({
    paymentId: payment.id,
    caseId: recoveryCase.id,
    eventType: 'RECOVERY_CASE_CREATED',
    actor: 'recoverai-agent',
    decision: status,
    metadata: {
      recommendedAction,
      classification,
      confidence,
      source: diagnosis === null ? 'deterministic_baseline' : `ai:${provider.name}`,
      // The authorization value is now computed by the policy engine.
      // `executed` remains false: this phase authorizes but never acts.
      authorized: policy.authorized,
      policyVersion: policy.policyVersion,
      executed: false,
    },
  });

  return {
    payment,
    assessment,
    diagnosis,
    policy,
    recoveryCase,
    diagnosisError,
    existingCase: false,
  };
}
