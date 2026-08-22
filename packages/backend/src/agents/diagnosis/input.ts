import type { PolicyConfig } from '../../config/index.ts';
import type { Payment, RecoveryActionType } from '../../shared/types.ts';
import type { CustomerHistory, RiskAssessment } from '../../risk/types.ts';
import { assertNoEvaluationData, type DiagnosisInput } from './types.ts';

/** Actions a provider may recommend in this phase (PRD section 8). */
export const SUPPORTED_ACTIONS: readonly RecoveryActionType[] = Object.freeze([
  'RETRY',
  'REMINDER',
  'CHECKOUT_RECOVERY',
  'SUBSCRIPTION_RETRY',
  'ESCALATE',
  'NO_ACTION',
]);

export interface BuildDiagnosisInputArgs {
  payment: Payment;
  customerHistory: CustomerHistory;
  assessment: RiskAssessment;
  policy: PolicyConfig;
}

/**
 * The ONLY sanctioned way to construct a DiagnosisInput.
 *
 * Two properties make this safe:
 *
 *   1. It copies named fields explicitly. There is no spread of a payment row
 *      anywhere in this function, so a ground-truth column added to the
 *      database later cannot ride along into a prompt by accident.
 *
 *   2. It runs assertNoEvaluationData() on the finished object before
 *      returning. Even if a caller passes a payment object that was polluted
 *      upstream, the leak is caught here and throws rather than reaching a
 *      provider.
 *
 * Note what is absent: this module performs no database access at all, and
 * `CustomerHistory` is derived from payment rows only. The evaluation-labels
 * table is unreachable from here by construction.
 */
export function buildDiagnosisInput(args: BuildDiagnosisInputArgs): DiagnosisInput {
  const { payment, customerHistory, assessment, policy } = args;

  const input: DiagnosisInput = {
    payment: {
      paymentId: payment.id,
      amount: payment.amount,
      currency: payment.currency,
      status: payment.status,
      failureReason: payment.failureReason,
      attemptCount: payment.attemptCount,
      isSubscription: payment.isSubscription,
      ageHours: assessment.ageHours,
    },
    customerHistory: {
      totalPayments: customerHistory.totalPayments,
      successfulPayments: customerHistory.successfulPayments,
      failedPayments: customerHistory.failedPayments,
      successRate: customerHistory.successRate,
      lifetimeValue: customerHistory.lifetimeValue,
    },
    risk: {
      classification: assessment.classification,
      recoverability: assessment.recoverability,
      recoverabilityScore: assessment.recoverabilityScore,
      riskScore: assessment.riskScore,
      baselineAction: assessment.baselineAction,
      factors: [...assessment.factors],
    },
    policy: {
      maxRetryAttempts: policy.maxRetryAttempts,
      maxAutomatedAmount: policy.maxAutomatedAmount,
      minRecoveryConfidence: policy.minRecoveryConfidence,
      recoveryWindowHours: policy.recoveryWindowHours,
      exceedsAutomatedLimit: payment.amount > policy.maxAutomatedAmount,
    },
    supportedActions: SUPPORTED_ACTIONS,
  };

  // Defence in depth: catches anything the type system could not, such as a
  // payment object that arrived as `unknown` from a query and was cast.
  assertNoEvaluationData(input);

  return input;
}
