import type {
  CaseStatus,
  ExecutionStatus,
  PolicyDecision,
  RecoveryActionRecord,
  VerificationStatus,
} from '../types/domain.ts';

/**
 * ============================================================================
 * STATUS SEMANTICS — THE MOST IMPORTANT UX RULE IN THE PRODUCT
 * ============================================================================
 *
 * The recovery lifecycle has FIVE distinct stages, and the interface must
 * never collapse them:
 *
 *   1. AI diagnosis    a recommendation. Not permission.
 *   2. Policy          permission. Not an action.
 *   3. Human approval  satisfies an approval GATE. Not an authorization.
 *   4. Execution       the provider accepted a request. NOT recovered money.
 *   5. Verification    evidence. Only VERIFIED means money actually moved.
 *
 * The specific mistake this module exists to prevent: rendering
 * `execution_status: SUCCESS` as "Recovered". A provider accepting a request
 * is not proof that a customer was charged. Only a VERIFIED verdict is.
 *
 * Every tone below is paired with a label and an icon, so no state is
 * communicated by colour alone.
 */

export type Tone = 'verified' | 'attention' | 'danger' | 'info' | 'neutral';

export interface StatusPresentation {
  /** Human-readable label. Never invents a meaning the backend did not give. */
  label: string;
  tone: Tone;
  /** Redundant non-colour cue, for accessibility and for print. */
  icon: string;
  /** Shown on hover/expansion. Explains what the state does and does not mean. */
  description?: string;
}

const NEUTRAL: StatusPresentation = { label: 'Unknown', tone: 'neutral', icon: '○' };

// ---------------------------------------------------------------------------
// Stage 2 — POLICY
// ---------------------------------------------------------------------------

export function policyPresentation(status: PolicyDecision | null): StatusPresentation {
  switch (status) {
    case 'ALLOWED':
      return {
        label: 'Allowed',
        tone: 'verified',
        icon: '✓',
        description: 'The deterministic policy engine permitted this action.',
      };
    case 'BLOCKED':
      return {
        label: 'Blocked',
        tone: 'danger',
        icon: '✕',
        description: 'A policy rule refused this action. It cannot be executed.',
      };
    case 'REQUIRES_APPROVAL':
      return {
        label: 'Approval required',
        tone: 'attention',
        icon: '⏸',
        description: 'Policy gated this action pending a human decision.',
      };
    default:
      return NEUTRAL;
  }
}

// ---------------------------------------------------------------------------
// Stage 4 — EXECUTION
//
// NOTE: none of these say "Recovered". That word belongs to stage 5 alone.
// ---------------------------------------------------------------------------

export function executionPresentation(status: ExecutionStatus | null): StatusPresentation {
  switch (status) {
    case 'SUCCESS':
      return {
        label: 'Provider accepted',
        tone: 'info',
        icon: '↑',
        description:
          'The provider accepted the request. This is NOT proof that money moved — ' +
          'verification decides that.',
      };
    case 'FAILED':
      return {
        label: 'Failed',
        tone: 'danger',
        icon: '✕',
        description: 'The provider explicitly rejected the request.',
      };
    case 'EXECUTING':
      return {
        label: 'In flight',
        tone: 'attention',
        icon: '◐',
        description: 'A request was sent and no response has been recorded yet.',
      };
    case 'PENDING':
      return {
        label: 'Pending',
        tone: 'neutral',
        icon: '○',
        description: 'The action was claimed but the provider has not been called.',
      };
    case 'UNCONFIRMED':
      return {
        label: 'Unconfirmed',
        tone: 'attention',
        icon: '?',
        description:
          'The provider outcome could not be determined. RecoverAI will not blindly retry.',
      };
    case 'SKIPPED_DUPLICATE':
      return {
        label: 'Skipped — duplicate',
        tone: 'neutral',
        icon: '⊘',
        description:
          'An equivalent action already existed, so the provider was not called again.',
      };
    default:
      return NEUTRAL;
  }
}

// ---------------------------------------------------------------------------
// Stage 5 — VERIFICATION. The only stage that can say "recovered".
// ---------------------------------------------------------------------------

export function verificationPresentation(status: VerificationStatus | null): StatusPresentation {
  switch (status) {
    case 'VERIFIED':
      return {
        label: 'Verified',
        tone: 'verified',
        icon: '✓',
        description: 'Provider evidence confirms the revenue was recovered.',
      };
    case 'NOT_RECOVERED':
      return {
        label: 'Not recovered',
        tone: 'danger',
        icon: '✕',
        description: 'Evidence confirms the revenue was NOT recovered.',
      };
    case 'UNCONFIRMED':
      return {
        label: 'Outcome unconfirmed',
        tone: 'attention',
        icon: '?',
        description:
          'RecoverAI will not blindly retry an action when the provider outcome is unknown.',
      };
    default:
      return {
        label: 'Not verified',
        tone: 'neutral',
        icon: '○',
        description: 'Verification has not run for this action yet.',
      };
  }
}

// ---------------------------------------------------------------------------
// Overall case status
// ---------------------------------------------------------------------------

export function casePresentation(status: CaseStatus): StatusPresentation {
  switch (status) {
    case 'RECOVERED':
      return {
        label: 'Recovered',
        tone: 'verified',
        icon: '✓',
        description: 'Verified by provider evidence.',
      };
    case 'AWAITING_APPROVAL':
      return { label: 'Awaiting approval', tone: 'attention', icon: '⏸' };
    case 'APPROVED':
      return {
        label: 'Approved',
        tone: 'info',
        icon: '👤',
        description:
          'Human approved — execution is still subject to current policy checks.',
      };
    case 'REJECTED':
      return {
        label: 'Rejected',
        tone: 'danger',
        icon: '✕',
        description: 'A human declined this case. It will not be executed.',
      };
    case 'EXECUTING':
      return { label: 'Executing', tone: 'attention', icon: '◐' };
    case 'AWAITING_VERIFICATION':
      return {
        label: 'Awaiting verification',
        tone: 'attention',
        icon: '◔',
        description: 'An action ran; the business outcome is not yet established.',
      };
    case 'FAILED':
      return { label: 'Failed', tone: 'danger', icon: '✕' };
    case 'ESCALATED':
      return { label: 'Escalated', tone: 'attention', icon: '↑' };
    case 'OPEN':
      return { label: 'Open', tone: 'info', icon: '●' };
    case 'CLOSED':
      return { label: 'Closed', tone: 'neutral', icon: '○' };
    default:
      return NEUTRAL;
  }
}

// ---------------------------------------------------------------------------
// Derived helpers — read backend state, never invent it
// ---------------------------------------------------------------------------

/** The most recent action, which carries the current lifecycle position. */
export function latestAction(
  actions: readonly RecoveryActionRecord[],
): RecoveryActionRecord | null {
  if (actions.length === 0) return null;
  return [...actions].sort(
    (a, b) => Date.parse(b.created_at) - Date.parse(a.created_at),
  )[0]!;
}

/**
 * Whether this case may be shown as recovered.
 *
 * The single source of truth for the word "recovered" on a case. It requires
 * BOTH a VERIFIED verdict and the backend's own RECOVERED status — either
 * alone would be the frontend drawing a financial conclusion of its own.
 */
export function isRecovered(
  caseStatus: CaseStatus,
  actions: readonly RecoveryActionRecord[],
): boolean {
  const action = latestAction(actions);
  return caseStatus === 'RECOVERED' && action?.verification_status === 'VERIFIED';
}

/**
 * Whether the UI must show the no-blind-retry explanation.
 *
 * True when the outcome is genuinely unknown — from either the execution
 * attempt or the verification verdict.
 */
export function isUnconfirmed(action: RecoveryActionRecord | null): boolean {
  if (action === null) return false;
  return (
    action.execution_status === 'UNCONFIRMED' ||
    action.verification_status === 'UNCONFIRMED' ||
    action.execution_status === 'EXECUTING'
  );
}

/** The sentence shown wherever an outcome is unconfirmed. Never varied. */
export const NO_BLIND_RETRY =
  'RecoverAI will not blindly retry an action when the provider outcome is unknown.';

/** Shown wherever approval is offered or displayed. Never varied. */
export const APPROVAL_IS_NOT_EXECUTION =
  'Approval does not execute the recovery. Policy will be re-evaluated before execution.';

export const TONE_CLASSES: Record<Tone, string> = {
  verified: 'bg-verified-bg text-verified border-verified/20',
  attention: 'bg-attention-bg text-attention border-attention/25',
  danger: 'bg-danger-bg text-danger border-danger/20',
  info: 'bg-info-bg text-info border-info/20',
  neutral: 'bg-neutral-bg text-neutral border-line',
};
