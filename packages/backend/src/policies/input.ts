import type { Payment } from '../shared/types.ts';
import type { RiskAssessment } from '../risk/types.ts';
import type { PolicyInput } from './types.ts';

/**
 * Adapter from domain objects to PolicyInput.
 *
 * This exists so the evaluator never imports a database row type or a
 * repository. Callers assemble the observed facts here; the engine stays a
 * pure function of an explicit, minimal input.
 *
 * Fields are copied by name. There is no spread of a payment row, so a column
 * added later cannot silently become a policy input.
 */
export interface BuildPolicyInputArgs {
  payment: Payment;
  assessment: RiskAssessment;
  /** The action being authorized. */
  proposedAction: string;
  /** Confidence from the AI diagnosis, or the deterministic baseline. */
  confidence: number;
  /** Established from persisted state by the caller, not inferred here. */
  duplicateActionExists: boolean;
  /** Verified recovery evidence; never an AI claim. */
  alreadyRecovered?: boolean;
  remindersSent?: number;
  /** Seconds since the last attempt, or null when there was none. */
  secondsSinceLastAttempt?: number | null;
  /** Additional human-review flag from the diagnosis layer. */
  humanReviewRequested?: boolean;
  /**
   * Whether a persisted APPROVED decision exists for this case.
   *
   * Defaults to FALSE. An omitted flag must never read as "approved" — every
   * existing caller keeps its current, un-approved behaviour.
   */
  humanApprovalGranted?: boolean;
}

export function buildPolicyInput(args: BuildPolicyInputArgs): PolicyInput {
  const { payment, assessment } = args;

  return {
    paymentId: payment.id,
    amount: payment.amount,
    currency: payment.currency,
    paymentStatus: payment.status,
    failureReason: payment.failureReason,
    attemptCount: payment.attemptCount,
    secondsSinceLastAttempt: args.secondsSinceLastAttempt ?? null,
    proposedAction: args.proposedAction,
    confidence: args.confidence,
    duplicateActionExists: args.duplicateActionExists,
    // A captured payment is recovered by definition; callers may also pass
    // explicit verified evidence.
    alreadyRecovered: args.alreadyRecovered ?? payment.status === 'captured',
    remindersSent: args.remindersSent ?? 0,
    // The detector's own review flag is folded in, so a policy decision cannot
    // be more permissive than the deterministic assessment that preceded it.
    humanReviewRequested: args.humanReviewRequested ?? assessment.requiresHumanReview,
    // Fail closed: absent means not approved.
    humanApprovalGranted: args.humanApprovalGranted ?? false,
  };
}
