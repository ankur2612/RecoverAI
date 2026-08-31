import { randomUUID } from 'node:crypto';
import { appendAuditEvent } from '../audit/repository.ts';
// From policies/types, NOT policies/engine: the approval service records a
// human decision and must not be able to reach the evaluator.
import { POLICY_VERSION } from '../policies/types.ts';
import { findCaseById, updateCaseStatus, type RecoveryCase } from './repository.ts';
import {
  findDecisionForCase,
  recordDecision,
  type ApprovalDecision,
  type RecoveryApproval,
} from './approval-repository.ts';

/**
 * ============================================================================
 * THE HUMAN APPROVAL DECISION
 * ============================================================================
 *
 * APPROVAL IS NOT AUTHORIZATION.
 *
 * This module records that a person reviewed a case and said yes or no. It
 * does exactly that and nothing else:
 *
 *   - it NEVER calls a payment provider
 *   - it NEVER calls the executor or the execute service
 *   - it NEVER evaluates policy or computes an authorization
 *   - it NEVER moves money
 *
 * Approving a case does not execute it. Execution remains a separate, explicit
 * step through `executeRecoveryCase`, which re-evaluates the deterministic
 * policy engine against CURRENT payment state at that moment. An approval
 * granted an hour ago cannot act on a payment that has since been captured,
 * exhausted its retry budget, or acquired a duplicate action.
 *
 * What approval DOES do is satisfy the approval GATES the policy engine
 * raised. It cannot satisfy a failure rule — those are computed independently
 * and outrank approval — so a human can authorise a judgement call but never a
 * rule violation.
 *
 * Architecture tests enforce the import boundaries in both directions.
 */

export const APPROVAL_FAILURES = [
  'CASE_NOT_FOUND',
  'CASE_NOT_AWAITING_APPROVAL',
  'ACTION_MISMATCH',
  'ALREADY_DECIDED',
] as const;
export type ApprovalFailure = (typeof APPROVAL_FAILURES)[number];

export interface DecisionResult {
  /** The decision now in force, when one exists. */
  approval: RecoveryApproval | null;
  failure: ApprovalFailure | null;
  recoveryCase: RecoveryCase | null;
  /** True when THIS call recorded the decision (false on a duplicate). */
  recorded: boolean;
  message: string;
}

export interface DecisionInput {
  /** Free-text justification from the operator. Never a credential. */
  reason?: string | undefined;
  /**
   * The action the operator believes they are approving.
   *
   * Optional, but when supplied it must match the case's current
   * recommendation. This stops an approval meant for one action from applying
   * to a different one if the case was re-analysed in between.
   */
  expectedAction?: string | undefined;
}

export interface DecisionDeps {
  /**
   * Who decided. With a shared API token this is a service identity rather
   * than a person — the field exists so a later identity system needs no
   * schema change.
   */
  actor: string;
  /** Injected for determinism in tests. */
  now?: Date;
}

function refuse(
  failure: ApprovalFailure,
  message: string,
  recoveryCase: RecoveryCase | null,
  approval: RecoveryApproval | null = null,
): DecisionResult {
  return { approval, failure, recoveryCase, recorded: false, message };
}

/**
 * Record a human decision on a case.
 *
 * Validation is deliberately narrow: it checks that the case is one a human is
 * actually being asked about, and that the operator is deciding on the action
 * the case currently recommends. It does NOT re-derive authorization — that
 * stays with the policy engine at execution time.
 */
async function decide(
  caseId: string,
  decision: ApprovalDecision,
  input: DecisionInput,
  deps: DecisionDeps,
): Promise<DecisionResult> {
  const recoveryCase = await findCaseById(caseId);
  if (recoveryCase === null) {
    return refuse('CASE_NOT_FOUND', `Recovery case ${caseId} was not found.`, null);
  }

  // A standing decision is never overwritten.
  //
  // Checked BEFORE the status check on purpose: recording a decision moves the
  // case to APPROVED/REJECTED, so a second attempt would otherwise report the
  // vaguer "not awaiting approval" instead of naming the decision that already
  // stands. Both refuse; this one tells the operator why.
  //
  // The UNIQUE index is still the actual enforcement — this check cannot
  // survive a race, and does not need to.
  const standing = await findDecisionForCase(caseId);
  if (standing !== null) {
    return refuse(
      'ALREADY_DECIDED',
      `Case ${caseId} was already ${standing.decision.toLowerCase()} by ${standing.actor}; ` +
        'a decision cannot be changed. Re-analyse the payment to create a fresh case.',
      recoveryCase,
      standing,
    );
  }

  // Only a case actually awaiting a human may be decided. This blocks
  // deciding an already-executed case, a recovered one, or one policy never
  // gated in the first place.
  if (recoveryCase.status !== 'AWAITING_APPROVAL') {
    return refuse(
      'CASE_NOT_AWAITING_APPROVAL',
      `Case ${caseId} is ${recoveryCase.status}, not AWAITING_APPROVAL; ` +
        'only a case awaiting a human decision can be approved or rejected.',
      recoveryCase,
    );
  }

  // The operator must be deciding on the action the case actually recommends.
  if (
    input.expectedAction !== undefined &&
    input.expectedAction !== recoveryCase.recommendedAction
  ) {
    return refuse(
      'ACTION_MISMATCH',
      `The case recommends "${recoveryCase.recommendedAction}" but the decision named ` +
        `"${input.expectedAction}".`,
      recoveryCase,
    );
  }


  // ---- Persist. The database, not this check, arbitrates a race. ----------
  const result = await recordDecision({
    id: `rap_${randomUUID()}`,
    recoveryCaseId: caseId,
    decision,
    actor: deps.actor,
    reason: input.reason ?? null,
    approvedAction: recoveryCase.recommendedAction,
    policyVersion: POLICY_VERSION,
  });

  if (!result.recorded) {
    // A concurrent caller won. Their decision stands; report it rather than
    // pretending this call succeeded.
    return refuse(
      'ALREADY_DECIDED',
      `Case ${caseId} was decided concurrently (${result.approval.decision}); ` +
        'this request did not change it.',
      recoveryCase,
      result.approval,
    );
  }

  // ---- Move the case to the matching human-decision state ----------------
  //
  // APPROVED means "a person said yes", NOT "policy authorised this". The
  // case still has to pass the full policy re-evaluation at execution time.
  const nextStatus = decision === 'APPROVED' ? 'APPROVED' : 'REJECTED';
  const updated = await updateCaseStatus(caseId, nextStatus);

  await appendAuditEvent({
    paymentId: recoveryCase.paymentId,
    caseId,
    eventType: decision === 'APPROVED' ? 'APPROVAL_GRANTED' : 'APPROVAL_REJECTED',
    actor: deps.actor,
    decision,
    metadata: {
      approvalId: result.approval.id,
      approvedAction: recoveryCase.recommendedAction,
      policyVersion: POLICY_VERSION,
      // The operator's own words, bounded by the API schema. Never a header.
      reason: input.reason ?? null,
      note:
        decision === 'APPROVED'
          ? 'human_decision_only_policy_still_authoritative'
          : 'terminal_for_this_case',
    },
  });

  return {
    approval: result.approval,
    failure: null,
    recoveryCase: updated ?? recoveryCase,
    recorded: true,
    message:
      decision === 'APPROVED'
        ? 'Approval recorded. This does NOT execute the action: policy is re-evaluated ' +
          'against current state when execution is requested, and may still refuse.'
        : 'Rejection recorded. This case will not be executed.',
  };
}

/** Record a human APPROVAL. Executes nothing. */
export async function approveRecoveryCase(
  caseId: string,
  input: DecisionInput,
  deps: DecisionDeps,
): Promise<DecisionResult> {
  return decide(caseId, 'APPROVED', input, deps);
}

/** Record a human REJECTION. Terminal for this case. */
export async function rejectRecoveryCase(
  caseId: string,
  input: DecisionInput,
  deps: DecisionDeps,
): Promise<DecisionResult> {
  return decide(caseId, 'REJECTED', input, deps);
}
