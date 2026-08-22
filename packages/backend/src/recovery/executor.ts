import { randomUUID } from 'node:crypto';
import type { MinorUnits, RecoveryActionType } from '../shared/types.ts';
import type { PolicyResult } from '../policies/types.ts';
import { isExecutableAction, type RecoveryProvider } from '../payments/provider.ts';
import { appendAuditEvent } from '../audit/repository.ts';
import {
  claimAction,
  completeAction,
  markExecuting,
  type RecoveryAction,
} from './action-repository.ts';

/**
 * ============================================================================
 * THE RECOVERY EXECUTOR
 * ============================================================================
 *
 * The first component permitted to cause something to happen outside this
 * process. Its authority is narrow and entirely borrowed:
 *
 *   AI recommends -> Policies authorize -> EXECUTOR EXECUTES -> Provider
 *   performs -> Evidence verifies.
 *
 * The executor makes NO decisions of its own. It does not read the AI
 * recommendation, does not re-run policy, and does not reinterpret either. It
 * receives an authorization and either honours it or refuses it.
 *
 * Two properties it must never lose:
 *
 *   1. FAIL CLOSED. Anything other than an explicit `authorized: true` results
 *      in refusal and zero provider calls.
 *
 *   2. THE DATABASE OWNS IDEMPOTENCY. The provider is called only after the
 *      database has confirmed this caller owns the idempotency key. A
 *      read-then-write check would let two concurrent callers both proceed.
 */

/** Why an execution attempt was refused before reaching the provider. */
export const REFUSAL_REASONS = [
  'NOT_AUTHORIZED',
  'REQUIRES_HUMAN_APPROVAL',
  'POLICY_BLOCKED',
  'MISSING_IDEMPOTENCY_KEY',
  'UNSUPPORTED_ACTION',
  'INVALID_PAYMENT_STATE',
  'POLICY_ACTION_MISMATCH',
] as const;
export type RefusalReason = (typeof REFUSAL_REASONS)[number];

/** Outcome of an execution attempt, from the executor's perspective. */
export const EXECUTION_OUTCOMES = [
  'EXECUTION_SUCCEEDED',
  'EXECUTION_FAILED',
  'EXECUTION_UNKNOWN',
  'SKIPPED_DUPLICATE',
  'REFUSED',
] as const;
export type ExecutionOutcome = (typeof EXECUTION_OUTCOMES)[number];

export interface ExecuteInput {
  recoveryCaseId: string;
  paymentId: string;
  action: RecoveryActionType | string;
  amount: MinorUnits;
  currency: string;
  /** Current payment status, used only as an eligibility guard. */
  paymentStatus: string;
  /** The authorization this execution rests on. Not recomputed here. */
  policy: PolicyResult;
  /** Required. A missing or blank key is a refusal, never a generated one. */
  idempotencyKey: string;
}

export interface ExecuteResult {
  /**
   * True when a provider request was actually sent. Note this is "the request
   * left the building", NOT "the payment was recovered".
   */
  executed: boolean;
  outcome: ExecutionOutcome;
  /**
   * Whether the business outcome has been verified. Always false in this
   * phase: outcome verification does not exist yet, and a provider SUCCESS is
   * not evidence of recovered revenue.
   */
  verified: boolean;
  /** Set when the attempt was refused before any provider call. */
  refusalReason: RefusalReason | null;
  /** The persisted action row, when one was created. */
  action: RecoveryAction | null;
  /** Provider identifier, when one was consulted. */
  provider: string | null;
  message: string;
}

function refuse(reason: RefusalReason, message: string): ExecuteResult {
  return {
    executed: false,
    outcome: 'REFUSED',
    verified: false,
    refusalReason: reason,
    action: null,
    provider: null,
    message,
  };
}

/** Payment statuses from which an execution may proceed. */
const EXECUTABLE_PAYMENT_STATUSES = new Set(['failed', 'abandoned', 'created', 'authorized']);

/**
 * Build the deterministic idempotency key for a logical action.
 *
 * Design: `recovery:{caseId}:{actionType}:{policyVersion}`
 *
 * The key identifies the LOGICAL action, not the HTTP request. Submitting the
 * same case and action twice produces the same key, so the second attempt
 * collides and never reaches the provider — which is the entire point. A
 * per-request random key would defeat this completely.
 *
 * The policy version is included deliberately: if the rule set changes, the
 * action was authorized under different rules and is a genuinely different
 * logical action. That is a considered trade-off — bumping the policy version
 * permits one further execution of a case that already executed under the old
 * rules. Once approval and re-validation land, that transition must be an
 * explicit decision rather than an accident of deployment.
 */
export function buildIdempotencyKey(
  caseId: string,
  actionType: string,
  policyVersion: string,
): string {
  return `recovery:${caseId}:${actionType}:${policyVersion}`;
}

export interface ExecutorDeps {
  provider: RecoveryProvider;
}

/**
 * Execute one authorized recovery action.
 *
 * The ordering below is load-bearing: every refusal check happens before the
 * idempotency claim, and the claim happens before the provider call. No path
 * reaches the provider without passing both.
 */
export async function executeRecoveryAction(
  input: ExecuteInput,
  deps: ExecutorDeps,
): Promise<ExecuteResult> {
  const { provider } = deps;
  const { policy } = input;

  // ---- 1. Authorization boundary (no provider call beyond this point) -----
  // The executor trusts the policy engine's verdict and nothing else. It does
  // not inspect the AI recommendation or re-derive permission.
  if (policy.requiresHumanApproval) {
    await auditRefusal(input, 'REQUIRES_HUMAN_APPROVAL');
    return refuse(
      'REQUIRES_HUMAN_APPROVAL',
      'This action requires human approval and cannot be executed automatically.',
    );
  }

  if (!policy.authorized) {
    const reason: RefusalReason =
      policy.decision === 'BLOCKED' ? 'POLICY_BLOCKED' : 'NOT_AUTHORIZED';
    await auditRefusal(input, reason);
    return refuse(
      reason,
      `Policy did not authorize this action (decision: ${policy.decision}).`,
    );
  }

  // The authorization must be for the action actually being executed.
  // Otherwise a caller could pass an authorization for NO_ACTION and execute
  // a RETRY with it.
  if (policy.action !== input.action) {
    await auditRefusal(input, 'POLICY_ACTION_MISMATCH');
    return refuse(
      'POLICY_ACTION_MISMATCH',
      `The authorization covers "${policy.action}" but "${input.action}" was submitted.`,
    );
  }

  // ---- 2. Idempotency key is mandatory -----------------------------------
  if (typeof input.idempotencyKey !== 'string' || input.idempotencyKey.trim() === '') {
    await auditRefusal(input, 'MISSING_IDEMPOTENCY_KEY');
    return refuse(
      'MISSING_IDEMPOTENCY_KEY',
      'An idempotency key is required; the executor will not generate one on a caller\'s behalf.',
    );
  }

  // ---- 3. Action must be executable --------------------------------------
  if (!isExecutableAction(input.action)) {
    await auditRefusal(input, 'UNSUPPORTED_ACTION');
    return refuse(
      'UNSUPPORTED_ACTION',
      `"${input.action}" cannot be executed by any configured provider yet.`,
    );
  }

  // ---- 4. Payment must still be in an executable state -------------------
  if (!EXECUTABLE_PAYMENT_STATUSES.has(input.paymentStatus)) {
    await auditRefusal(input, 'INVALID_PAYMENT_STATE');
    return refuse(
      'INVALID_PAYMENT_STATE',
      `Payment status "${input.paymentStatus}" cannot accept a recovery action.`,
    );
  }

  // ---- 5. Claim the idempotency key --------------------------------------
  // THE PROVIDER IS NOT CALLED UNTIL THIS SUCCEEDS. The database's UNIQUE
  // constraint decides which concurrent caller owns the action.
  const claim = await claimAction({
    id: `ract_${randomUUID()}`,
    recoveryCaseId: input.recoveryCaseId,
    actionType: input.action,
    policyStatus: policy.decision,
    policyReason: policy.approvalReasons.concat(policy.denialReasons).join(',') || null,
    policyVersion: policy.policyVersion,
    amount: input.amount,
    idempotencyKey: input.idempotencyKey,
    provider: provider.name,
  });

  if (!claim.claimed) {
    // Another request already owns this logical action. Report its established
    // state and call nothing.
    await appendAuditEvent({
      paymentId: input.paymentId,
      caseId: input.recoveryCaseId,
      eventType: 'EXECUTION_SKIPPED_DUPLICATE',
      actor: 'recoverai-executor',
      decision: 'SKIPPED_DUPLICATE',
      metadata: {
        action: input.action,
        idempotencyKey: input.idempotencyKey,
        existingActionId: claim.action.id,
        existingStatus: claim.action.executionStatus,
        note: 'provider_not_called',
      },
    });

    return {
      executed: false,
      outcome: 'SKIPPED_DUPLICATE',
      verified: false,
      refusalReason: null,
      action: claim.action,
      provider: provider.name,
      message:
        `An equivalent action already exists (status ${claim.action.executionStatus}); ` +
        'the provider was not called again.',
    };
  }

  // ---- 6. Execute ---------------------------------------------------------
  await markExecuting(claim.action.id);

  await appendAuditEvent({
    paymentId: input.paymentId,
    caseId: input.recoveryCaseId,
    eventType: 'EXECUTION_REQUESTED',
    actor: 'recoverai-executor',
    decision: 'EXECUTING',
    metadata: {
      action: input.action,
      actionId: claim.action.id,
      idempotencyKey: input.idempotencyKey,
      policyVersion: policy.policyVersion,
      provider: provider.name,
      amount: input.amount,
    },
  });

  let outcome: 'SUCCESS' | 'FAILED' | 'UNKNOWN';
  let providerReference: string | null = null;
  let errorMessage: string | null = null;

  try {
    const result = await provider.executeAction({
      idempotencyKey: input.idempotencyKey,
      action: input.action,
      paymentId: input.paymentId,
      amount: input.amount,
      currency: input.currency,
    });
    outcome = result.outcome;
    providerReference = result.rawReference ?? result.providerActionId;
    errorMessage = result.errorMessage;
  } catch (error) {
    // A thrown transport error does NOT prove the remote side did nothing, so
    // it is UNKNOWN rather than FAILED. Collapsing it into FAILED would invite
    // a retry that could double-charge.
    outcome = 'UNKNOWN';
    errorMessage = `provider threw: ${(error as Error).message}`;
  }

  // ---- 7. Persist the verdict --------------------------------------------
  const executionStatus = outcome === 'SUCCESS' ? 'SUCCESS' : outcome === 'FAILED' ? 'FAILED' : 'UNCONFIRMED';

  const action = await completeAction({
    id: claim.action.id,
    executionStatus,
    providerReference,
    errorMessage,
  });

  const eventType =
    outcome === 'SUCCESS'
      ? 'EXECUTION_SUCCEEDED'
      : outcome === 'FAILED'
        ? 'EXECUTION_FAILED'
        : 'EXECUTION_UNKNOWN';

  await appendAuditEvent({
    paymentId: input.paymentId,
    caseId: input.recoveryCaseId,
    eventType,
    actor: 'recoverai-executor',
    decision: executionStatus,
    metadata: {
      action: input.action,
      actionId: action.id,
      idempotencyKey: input.idempotencyKey,
      policyVersion: policy.policyVersion,
      provider: provider.name,
      providerReference,
      errorMessage,
      // Recorded explicitly so no downstream reader can mistake a provider
      // acknowledgement for recovered revenue.
      verified: false,
      note:
        outcome === 'SUCCESS'
          ? 'provider_accepted_request_recovery_not_verified'
          : outcome === 'UNKNOWN'
            ? 'execution_state_unknown_requires_verification_no_automatic_retry'
            : 'provider_rejected_request',
    },
  });

  return {
    executed: true,
    outcome:
      outcome === 'SUCCESS'
        ? 'EXECUTION_SUCCEEDED'
        : outcome === 'FAILED'
          ? 'EXECUTION_FAILED'
          : 'EXECUTION_UNKNOWN',
    // Always false: the provider's word is not verification. Outcome
    // verification is a later phase.
    verified: false,
    refusalReason: null,
    action,
    provider: provider.name,
    message:
      outcome === 'SUCCESS'
        ? 'The provider accepted the request. Revenue recovery is NOT yet verified.'
        : outcome === 'FAILED'
          ? 'The provider rejected the request.'
          : 'The execution state is UNKNOWN. The action will not be retried automatically; provider/payment state must be verified.',
  };
}

/** Record a refusal so the attempt is auditable without implying money moved. */
async function auditRefusal(input: ExecuteInput, reason: RefusalReason): Promise<void> {
  await appendAuditEvent({
    paymentId: input.paymentId,
    caseId: input.recoveryCaseId,
    eventType: 'EXECUTION_REFUSED',
    actor: 'recoverai-executor',
    decision: reason,
    metadata: {
      action: input.action,
      policyDecision: input.policy.decision,
      policyVersion: input.policy.policyVersion,
      refusalReason: reason,
      // Unambiguous: nothing was sent anywhere.
      providerCalled: false,
      executed: false,
    },
  });
}
