import type { RecoveryProvider } from '../payments/provider.ts';
import type { PaymentStatus, RecoveryCaseStatus } from '../shared/types.ts';
import { findPaymentById, refreshPaymentStatusFromEvidence } from '../payments/repository.ts';
import { appendAuditEvent } from '../audit/repository.ts';
import { findCaseById, updateCaseStatus, type RecoveryCase } from './repository.ts';
import {
  findLatestCompletedAction,
  recordVerification,
  type RecoveryAction,
} from './action-repository.ts';
import { verifyOutcome } from './verifier.ts';
import type { VerificationResult } from './verification-types.ts';

/**
 * Outcome verification service.
 *
 * Sequence: load the action -> observe the payment -> run the pure verifier ->
 * persist the verdict -> reflect it on the case -> audit.
 *
 * What this service deliberately does NOT do:
 *   - it does not execute or re-execute anything
 *   - it does not retry a payment, even an ambiguous one
 *   - it does not call an LLM or read an AI recommendation
 *   - it does not evaluate or modify policy
 *
 * Verification answers "what happened?". It never answers "what should we do
 * next?" — that belongs to the recovery and policy layers.
 */

export const VERIFY_FAILURES = [
  'CASE_NOT_FOUND',
  'PAYMENT_NOT_FOUND',
  'NO_EXECUTION_TO_VERIFY',
] as const;
export type VerifyFailure = (typeof VERIFY_FAILURES)[number];

export interface VerifyCaseResult {
  verification: VerificationResult | null;
  failure: VerifyFailure | null;
  recoveryCase: RecoveryCase | null;
  action: RecoveryAction | null;
  /** True when an existing terminal verdict was returned unchanged. */
  alreadyVerified: boolean;
  message: string;
}

export interface VerifyCaseDeps {
  provider: RecoveryProvider;
  /** Injected for determinism in tests. */
  now?: Date;
}

/** Case status implied by a verification verdict. */
function caseStatusFor(status: VerificationResult['status']): RecoveryCaseStatus {
  switch (status) {
    case 'VERIFIED':
      // The ONLY path to RECOVERED. Evidence, not acknowledgement.
      return 'RECOVERED';
    case 'NOT_RECOVERED':
      return 'FAILED';
    case 'UNCONFIRMED':
      // Still outstanding: an action exists whose outcome is unknown.
      return 'AWAITING_VERIFICATION';
  }
}

/**
 * Verify the business outcome for one recovery case.
 *
 * Idempotent: repeating it with unchanged evidence returns the same verdict.
 * A terminal verdict short-circuits before any provider lookup, so a repeated
 * call on a VERIFIED action performs no I/O against the provider at all.
 */
export async function verifyRecoveryCase(
  caseId: string,
  deps: VerifyCaseDeps,
): Promise<VerifyCaseResult> {
  const { provider } = deps;
  const now = deps.now ?? new Date();

  const recoveryCase = await findCaseById(caseId);
  if (recoveryCase === null) {
    return {
      verification: null,
      failure: 'CASE_NOT_FOUND',
      recoveryCase: null,
      action: null,
      alreadyVerified: false,
      message: `Recovery case ${caseId} was not found.`,
    };
  }

  const action = await findLatestCompletedAction(caseId);
  if (action === null) {
    // Nothing was executed, so there is no outcome to establish. This is not a
    // failure of verification; it is the absence of anything to verify.
    return {
      verification: null,
      failure: 'NO_EXECUTION_TO_VERIFY',
      recoveryCase,
      action: null,
      alreadyVerified: false,
      message: `Recovery case ${caseId} has no completed execution, so there is no outcome to verify.`,
    };
  }

  // ---- Short-circuit on a terminal verdict --------------------------------
  // Repeating verification must not re-observe, re-persist, or re-audit an
  // outcome that is already established.
  if (action.verificationStatus === 'VERIFIED' || action.verificationStatus === 'NOT_RECOVERED') {
    return {
      verification: {
        status: action.verificationStatus,
        evidence: action.verificationEvidence,
        reason: action.verificationReason ?? '',
        verifiedAt: (action.verifiedAt ?? now).toISOString(),
        recovered: action.verificationStatus === 'VERIFIED',
      },
      failure: null,
      recoveryCase,
      action,
      alreadyVerified: true,
      message: `This outcome is already ${action.verificationStatus}; the existing verdict stands.`,
    };
  }

  const payment = await findPaymentById(recoveryCase.paymentId);
  if (payment === null) {
    return {
      verification: null,
      failure: 'PAYMENT_NOT_FOUND',
      recoveryCase,
      action,
      alreadyVerified: false,
      message: `Payment ${recoveryCase.paymentId} was not found.`,
    };
  }

  await appendAuditEvent({
    paymentId: payment.id,
    caseId: recoveryCase.id,
    eventType: 'OUTCOME_VERIFICATION_STARTED',
    actor: 'recoverai-verifier',
    decision: null,
    metadata: {
      actionId: action.id,
      executionStatus: action.executionStatus,
      provider: action.provider,
      attempt: action.verificationAttempts + 1,
    },
  });

  // ---- Observe the payment ------------------------------------------------
  // A READ. Even for an UNCONFIRMED execution this never re-executes: it asks
  // the provider what the payment's state is now.
  let observedState = null as Awaited<ReturnType<RecoveryProvider['getPaymentStatus']>> | null;
  let observationError: string | null = null;

  // A FAILED execution is conclusive on its own; skipping the lookup avoids a
  // pointless provider call.
  if (action.executionStatus !== 'FAILED') {
    try {
      observedState = await provider.getPaymentStatus(payment.id);
    } catch (error) {
      // A failed lookup means we learned nothing, which is UNCONFIRMED — never
      // an assumption in either direction.
      observationError = `status lookup threw: ${(error as Error).message}`;
    }
  }

  // ---- Verify (pure) ------------------------------------------------------
  const verification = verifyOutcome({
    paymentId: payment.id,
    executionStatus: action.executionStatus,
    observedState: observedState?.state ?? null,
    observedRawStatus: observedState?.rawStatus ?? null,
    observedReference: observedState?.reference ?? null,
    observationError: observationError ?? observedState?.errorMessage ?? null,
    storedPaymentStatus: payment.status as PaymentStatus,
    now,
  });

  // ---- Persist ------------------------------------------------------------
  const updated = await recordVerification({
    id: action.id,
    verificationStatus: verification.status,
    verificationReason: verification.reason,
    observedPaymentStatus: observedState?.rawStatus ?? null,
    evidence: verification.evidence,
  });

  // A refused update means a terminal verdict already stood; the database
  // enforced the no-regression rule.
  const finalAction = updated ?? action;

  // Reflect verified evidence onto the payment record. This is the only place
  // a recovery action can change payment state, and it happens strictly AFTER
  // an observation confirms the outcome — never from an execution result.
  if (verification.status === 'VERIFIED' && payment.status !== 'captured') {
    await refreshPaymentStatusFromEvidence(payment.id, 'captured');
  }

  // Reflect the outcome on the case. RECOVERED is reachable only from VERIFIED.
  const nextCaseStatus = caseStatusFor(verification.status);
  if (recoveryCase.status !== nextCaseStatus) {
    await updateCaseStatus(recoveryCase.id, nextCaseStatus);
  }

  const eventType =
    verification.status === 'VERIFIED'
      ? 'OUTCOME_VERIFIED'
      : verification.status === 'NOT_RECOVERED'
        ? 'OUTCOME_NOT_RECOVERED'
        : 'OUTCOME_UNCONFIRMED';

  await appendAuditEvent({
    paymentId: payment.id,
    caseId: recoveryCase.id,
    eventType,
    actor: 'recoverai-verifier',
    decision: verification.status,
    metadata: {
      actionId: action.id,
      executionStatus: action.executionStatus,
      observedPaymentState: observedState?.state ?? 'NOT_OBSERVED',
      storedPaymentStatus: payment.status,
      provider: action.provider,
      policyVersion: action.policyVersion,
      reason: verification.reason,
      evidenceCount: verification.evidence.length,
      // The one fact a reviewer needs: was money actually recovered?
      recovered: verification.recovered,
      caseStatus: nextCaseStatus,
    },
  });

  return {
    verification,
    failure: null,
    recoveryCase: { ...recoveryCase, status: nextCaseStatus },
    action: finalAction,
    alreadyVerified: false,
    message: verification.reason,
  };
}
