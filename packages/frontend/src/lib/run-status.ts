import type { StatusPresentation } from './status.ts';

/**
 * BATCH AND SWEEP OUTCOME SEMANTICS
 *
 * The same rule that governs a single case governs a batch item:
 *
 *   A PROVIDER ACCEPTING A REQUEST IS NOT RECOVERED MONEY.
 *
 * The backend's BatchItemStatus already encodes this distinction correctly —
 * it emits EXECUTED_UNVERIFIED for an execution whose outcome is not yet
 * established, and reserves RECOVERED for a VERIFIED verdict where
 * `recovered` is true (see batch-recovery.ts). This module renders those
 * states without collapsing them.
 *
 * The word "Recovered" appears below EXACTLY ONCE, on the backend's own
 * RECOVERED status. No other branch may produce it.
 */

const NEUTRAL: StatusPresentation = { label: 'Unknown', tone: 'neutral', icon: '○' };

export function batchItemPresentation(status: string): StatusPresentation {
  switch (status) {
    case 'RECOVERED':
      // The ONLY branch permitted to say "Recovered". The backend sets this
      // status only on a VERIFIED verdict with recovered === true.
      return {
        label: 'Recovered',
        tone: 'verified',
        icon: '✓',
        description: 'Verification confirmed by provider evidence that the revenue was recovered.',
      };
    case 'NOT_RECOVERED':
      return {
        label: 'Not recovered',
        tone: 'danger',
        icon: '✕',
        description: 'Evidence confirms the revenue was not recovered.',
      };
    case 'UNCONFIRMED':
      return {
        label: 'Outcome unconfirmed',
        tone: 'attention',
        icon: '?',
        description:
          'The provider outcome could not be determined. RecoverAI will not blindly retry.',
      };
    case 'EXECUTED_UNVERIFIED':
      // The critical case. An execution ran; the money question is still open.
      return {
        label: 'Provider accepted',
        tone: 'info',
        icon: '↑',
        description:
          'The provider accepted the request but verification has not established an outcome. ' +
          'This is NOT recovered revenue.',
      };
    case 'REFUSED':
      return {
        label: 'Refused',
        tone: 'danger',
        icon: '⊘',
        description: 'The executor refused to act. Nothing was sent to the provider.',
      };
    case 'NOT_AUTHORIZED':
      return {
        label: 'Not authorized',
        tone: 'neutral',
        icon: '⏸',
        description:
          'The policy engine did not authorize execution, or this was a preview run.',
      };
    case 'SKIPPED_DUPLICATE':
      return {
        label: 'Skipped — duplicate',
        tone: 'neutral',
        icon: '⊘',
        description:
          'An action already existed for this payment, so the provider was not called again.',
      };
    case 'NO_CASE':
      return {
        label: 'No case',
        tone: 'neutral',
        icon: '○',
        description: 'No recovery case was warranted for this payment.',
      };
    case 'ERROR':
      return {
        label: 'Error',
        tone: 'danger',
        icon: '!',
        description: 'This payment failed unexpectedly. The run continued past it.',
      };
    default:
      return NEUTRAL;
  }
}

/**
 * Sweep outcomes.
 *
 * RESOLVED_SUCCESS means the sweeper OBSERVED a succeeded provider state and
 * recorded it — it is an execution status, not a recovery verdict, so it says
 * "Provider succeeded", never "Recovered". Whether revenue was recovered is
 * decided afterwards by the verification service, and is reported per item in
 * its own `verification_status` field.
 */
export function sweepOutcomePresentation(outcome: string): StatusPresentation {
  switch (outcome) {
    case 'RESOLVED_SUCCESS':
      return {
        label: 'Provider succeeded',
        tone: 'info',
        icon: '↑',
        description:
          'The provider reported the payment succeeded, so the stranded action was resolved to ' +
          'SUCCESS. Verification decides separately whether revenue was recovered.',
      };
    case 'RESOLVED_FAILED':
      return {
        label: 'Provider failed',
        tone: 'danger',
        icon: '✕',
        description: 'The provider reported the payment failed, so the action was resolved to FAILED.',
      };
    case 'STILL_UNCONFIRMED':
      return {
        label: 'Still unconfirmed',
        tone: 'attention',
        icon: '?',
        description:
          'The provider could not tell RecoverAI what happened. The action stays UNCONFIRMED ' +
          'and is never retried.',
      };
    case 'ALREADY_RESOLVED':
      return {
        label: 'Already resolved',
        tone: 'neutral',
        icon: '○',
        description: 'Another process resolved this action before the sweep reached it.',
      };
    case 'ERROR':
      return {
        label: 'Error',
        tone: 'danger',
        icon: '!',
        description: 'This action failed to sweep. The sweep continued past it.',
      };
    default:
      return NEUTRAL;
  }
}

/** Shown on the Sweeper screen. Never varied. */
export const SWEEPER_RESOLVES_BY_OBSERVATION =
  'The sweeper resolves stranded actions by asking the provider what happened. It never ' +
  're-sends a request, and an action whose outcome stays unknown is left UNCONFIRMED rather ' +
  'than retried.';
