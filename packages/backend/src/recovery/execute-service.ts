import type { AppConfig } from '../config/index.ts';
import { findPaymentById } from '../payments/repository.ts';
import { evaluatePolicy } from '../policies/engine.ts';
import { buildPolicyInput } from '../policies/input.ts';
import { POLICY_VERSION } from '../policies/types.ts';
import { assessRisk } from '../risk/detector.ts';
import { EMPTY_CUSTOMER_HISTORY } from '../risk/types.ts';
import { getCustomerHistory } from '../payments/repository.ts';
import type { RecoveryProvider } from '../payments/provider.ts';
import { findCaseById, updateCaseStatus, type RecoveryCase } from './repository.ts';
import { findActionByIdempotencyKey } from './action-repository.ts';
import { findDecisionForCase } from './approval-repository.ts';
import {
  buildIdempotencyKey,
  executeRecoveryAction,
  type ExecuteResult,
} from './executor.ts';

/**
 * Execution service: turns "execute case X" into a safe executor call.
 *
 * Deliberately sits between the HTTP route and the executor so the route stays
 * a thin adapter and this logic is testable without a server.
 *
 * The important behaviour here is POLICY RE-VALIDATION. The stored recovery
 * case records what policy decided at ANALYSIS time, which may be minutes or
 * days ago. Executing on that stale verdict would let an old authorization act
 * indefinitely, so policy is re-evaluated against current payment state and
 * current configuration immediately before execution.
 */

export const EXECUTE_FAILURES = ['CASE_NOT_FOUND', 'PAYMENT_NOT_FOUND', 'CASE_NOT_ACTIONABLE'] as const;
export type ExecuteFailure = (typeof EXECUTE_FAILURES)[number];

export interface ExecuteCaseResult {
  /** Null when the request failed before an execution attempt was possible. */
  execution: ExecuteResult | null;
  failure: ExecuteFailure | null;
  recoveryCase: RecoveryCase | null;
  /** The freshly computed authorization the attempt rested on. */
  policyDecision: string | null;
  idempotencyKey: string | null;
  message: string;
}

export interface ExecuteCaseDeps {
  provider: RecoveryProvider;
  config: AppConfig;
  /** Injected for determinism in tests. */
  now?: Date;
}

/**
 * Execute the recommended action for one recovery case.
 *
 * Steps, in order:
 *   1. load the case and its payment
 *   2. re-run risk detection and the policy engine against CURRENT state
 *   3. derive the deterministic idempotency key
 *   4. hand the fresh authorization to the executor
 */
export async function executeRecoveryCase(
  caseId: string,
  deps: ExecuteCaseDeps,
): Promise<ExecuteCaseResult> {
  const { provider, config } = deps;
  const now = deps.now ?? new Date();

  const recoveryCase = await findCaseById(caseId);
  if (recoveryCase === null) {
    return {
      execution: null,
      failure: 'CASE_NOT_FOUND',
      recoveryCase: null,
      policyDecision: null,
      idempotencyKey: null,
      message: `Recovery case ${caseId} was not found.`,
    };
  }

  const payment = await findPaymentById(recoveryCase.paymentId);
  if (payment === null) {
    return {
      execution: null,
      failure: 'PAYMENT_NOT_FOUND',
      recoveryCase,
      policyDecision: null,
      idempotencyKey: null,
      message: `Payment ${recoveryCase.paymentId} for case ${caseId} was not found.`,
    };
  }

  // ---- Re-validate against CURRENT state and CURRENT policy ---------------
  // Never execute on the authorization stored at analysis time.
  const history = await getCustomerHistory(payment.customerId, payment.id).catch(
    () => EMPTY_CUSTOMER_HISTORY,
  );
  const assessment = assessRisk({ payment, customerHistory: history, now }, config.policy);

  // A duplicate check for reporting only. It is NOT the enforcement point —
  // the database's UNIQUE constraint is, inside the executor.
  // Keyed on the CURRENT policy version, matching the verdict being acted on.
  const idempotencyKey = buildIdempotencyKey(
    recoveryCase.id,
    recoveryCase.recommendedAction,
    POLICY_VERSION,
  );

  const existing = await findActionByIdempotencyKey(idempotencyKey);

  // ---- The human decision, read fresh at execution time -------------------
  //
  // A REJECTED case is terminal: it must never execute, whatever policy would
  // otherwise say. Checked before authorization so a rejection cannot be
  // overtaken by a later change in policy configuration.
  const decision = await findDecisionForCase(recoveryCase.id);
  if (decision !== null && decision.decision === 'REJECTED') {
    return {
      execution: null,
      failure: 'CASE_NOT_ACTIONABLE',
      recoveryCase,
      policyDecision: null,
      idempotencyKey: null,
      message: `Case ${caseId} was rejected by ${decision.actor} and cannot be executed.`,
    };
  }

  // An approval decision covers the action it was granted for. If the case has
  // since been re-analysed into a different recommendation, the old approval
  // does not carry over.
  const approvalGranted =
    decision !== null &&
    decision.decision === 'APPROVED' &&
    decision.approvedAction === recoveryCase.recommendedAction;

  const policy = evaluatePolicy(
    buildPolicyInput({
      payment,
      assessment,
      proposedAction: recoveryCase.recommendedAction,
      confidence: recoveryCase.confidence,
      // Now a real value: a prior action for this logical key means duplicate.
      duplicateActionExists: existing !== null,
      humanReviewRequested: assessment.requiresHumanReview,
      // Satisfies APPROVAL GATES ONLY. Every failure rule — retry ceiling,
      // cooldown, duplicate action, already recovered — is computed
      // independently and still denies an approved case.
      humanApprovalGranted: approvalGranted,
    }),
    config.policy,
  );

  const execution = await executeRecoveryAction(
    {
      recoveryCaseId: recoveryCase.id,
      paymentId: payment.id,
      action: recoveryCase.recommendedAction,
      amount: payment.amount,
      currency: payment.currency,
      paymentStatus: payment.status,
      policy,
      idempotencyKey,
    },
    { provider },
  );

  // An executed action leaves the case awaiting verification: a request was
  // sent, but whether revenue was recovered is not yet established. The case
  // must NOT be marked RECOVERED here — only verified evidence can do that.
  if (execution.executed && recoveryCase.status !== 'AWAITING_VERIFICATION') {
    await updateCaseStatus(recoveryCase.id, 'AWAITING_VERIFICATION');
  }

  return {
    execution,
    failure: null,
    recoveryCase: execution.executed
      ? { ...recoveryCase, status: 'AWAITING_VERIFICATION' }
      : recoveryCase,
    policyDecision: policy.decision,
    idempotencyKey,
    message: execution.message,
  };
}
