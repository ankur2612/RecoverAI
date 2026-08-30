import type { Classification, RecoveryActionType } from '../../../shared/types.ts';
import type { AIProvider } from '../provider.ts';
import {
  validateDiagnosis,
  type DiagnosisInput,
  type DiagnosisResult,
} from '../types.ts';

/**
 * MockAI — the default provider.
 *
 * This is NOT a simulated LLM and does not pretend to be one. It is a
 * transparent rule-based diagnoser whose purpose is to make the entire
 * architecture executable and testable with no external API call, no key, no
 * cost, and no run-to-run variance.
 *
 * Two properties matter:
 *
 *   1. DETERMINISTIC. The same input always yields the same output. There is
 *      no randomness anywhere — not even seeded — so tests assert exact values
 *      and the batch demo is reproducible.
 *
 *   2. HONEST. Its confidence values are derived from the deterministic
 *      signals actually present in the input, not invented to look impressive.
 *      When the input is ambiguous, it escalates instead of guessing.
 *
 * Its output goes through exactly the same strict validator as a real LLM's,
 * so the validation path is exercised on every run rather than only when a
 * real provider is configured.
 */
export class MockAIProvider implements AIProvider {
  readonly name = 'mock';
  readonly model = 'deterministic';

  // The interface is async because real providers are; MockAI is synchronous.
  async diagnose(input: DiagnosisInput): Promise<DiagnosisResult> {
    const raw = this.buildDiagnosis(input);
    // Deliberately routed through the same validator a real provider uses, so
    // a malformed MockAI response would fail exactly as loudly.
    return validateDiagnosis(raw, this.name, this.model);
  }

  /** Build the raw response object, in the same shape an LLM must return. */
  private buildDiagnosis(input: DiagnosisInput): Record<string, unknown> {
    const { payment, customerHistory, risk, policy } = input;

    // Start from the deterministic detector's classification. MockAI's job is
    // to be a competent baseline, not to disagree for the sake of it.
    const classification: Classification = risk.classification;

    const { action, confidence, probability, reason, requiresApproval } = this.decide(
      classification,
      input,
    );

    // Sustained customer success history raises confidence slightly; a poor
    // history lowers it. Bounded so history alone never crosses a threshold.
    let adjusted = confidence;
    if (customerHistory.successRate !== null && customerHistory.totalPayments >= 3) {
      adjusted += (customerHistory.successRate - 0.5) * 0.1;
    }

    // Repeated attempts erode confidence in any automated recommendation.
    if (payment.attemptCount > 0) {
      adjusted -= payment.attemptCount * 0.05;
    }

    const finalConfidence = round2(clamp01(adjusted));

    // Escalate on low confidence rather than recommending an action the policy
    // engine would have to block anyway.
    const belowThreshold = finalConfidence < policy.minRecoveryConfidence;
    const finalAction: RecoveryActionType =
      belowThreshold && action !== 'NO_ACTION' && action !== 'ESCALATE' ? 'ESCALATE' : action;

    const finalReason =
      finalAction === action
        ? reason
        : `${reason} Confidence ${finalConfidence.toFixed(2)} is below the ${policy.minRecoveryConfidence} automation threshold, so this is escalated for human review.`;

    return {
      classification,
      confidence: finalConfidence,
      reason: truncate(finalReason, 500),
      recommended_action: finalAction,
      expected_recovery_probability: round2(clamp01(probability)),
      requires_human_approval:
        requiresApproval || policy.exceedsAutomatedLimit || finalAction === 'ESCALATE',
    };
  }

  /**
   * Per-classification recommendation.
   *
   * Confidence figures reflect how unambiguous each signal genuinely is: a
   * gateway timeout is a well-understood transient fault, while an
   * unclassifiable failure warrants low confidence and escalation.
   */
  private decide(
    classification: Classification,
    input: DiagnosisInput,
  ): {
    action: RecoveryActionType;
    confidence: number;
    probability: number;
    reason: string;
    requiresApproval: boolean;
  } {
    const { payment, risk, policy } = input;
    const retriesLeft = policy.maxRetryAttempts - payment.attemptCount;

    switch (classification) {
      case 'TEMPORARY_FAILURE': {
        if (retriesLeft <= 0) {
          return {
            action: 'ESCALATE',
            confidence: 0.8,
            probability: 0.1,
            reason: 'Transient failure, but the retry budget is exhausted; needs human review.',
            requiresApproval: true,
          };
        }
        return {
          action: 'RETRY',
          confidence: 0.92,
          probability: Math.max(0.4, risk.recoverabilityScore),
          reason:
            `${describeReason(payment.failureReason)} is a transient gateway-side fault that ` +
            `commonly succeeds on retry; ${retriesLeft} attempt(s) remain.`,
          requiresApproval: false,
        };
      }

      case 'SUBSCRIPTION_FAILURE': {
        if (retriesLeft <= 0) {
          return {
            action: 'ESCALATE',
            confidence: 0.78,
            probability: 0.12,
            reason: 'Subscription charge failed and no retry budget remains.',
            requiresApproval: true,
          };
        }
        return {
          action: 'SUBSCRIPTION_RETRY',
          confidence: 0.84,
          probability: Math.max(0.35, risk.recoverabilityScore),
          reason:
            'Subscription charge failed on a recurring mandate; a scheduled retry within the ' +
            'billing window is the standard recovery path.',
          requiresApproval: false,
        };
      }

      case 'CUSTOMER_ACTION_REQUIRED':
        return {
          action: 'REMINDER',
          confidence: 0.86,
          probability: Math.max(0.3, risk.recoverabilityScore),
          reason:
            `${describeReason(payment.failureReason)} requires the customer to act; ` +
            'an immediate retry would fail again, so a reminder is the correct step.',
          requiresApproval: false,
        };

      case 'PAYMENT_METHOD_PROBLEM': {
        // Never retry a broken instrument: it cannot succeed and repeated
        // declines can trip issuer fraud controls.
        if (risk.recoverabilityScore < 0.25) {
          return {
            action: 'NO_ACTION',
            confidence: 0.8,
            probability: 0.05,
            reason:
              `${describeReason(payment.failureReason)} indicates an unusable payment method ` +
              'with little recovery prospect; further contact would only add friction.',
            requiresApproval: false,
          };
        }
        return {
          action: 'REMINDER',
          confidence: 0.82,
          probability: Math.max(0.2, risk.recoverabilityScore),
          reason:
            `${describeReason(payment.failureReason)} cannot be resolved by retrying the same ` +
            'instrument; the customer must update their payment method.',
          requiresApproval: false,
        };
      }

      case 'CHECKOUT_ABANDONMENT': {
        const withinWindow = payment.ageHours <= policy.recoveryWindowHours;
        if (!withinWindow) {
          return {
            action: 'NO_ACTION',
            confidence: 0.79,
            probability: 0.05,
            reason:
              `Checkout was abandoned ${payment.ageHours.toFixed(0)}h ago, outside the ` +
              `${policy.recoveryWindowHours}h recovery window; intent has likely lapsed.`,
            requiresApproval: false,
          };
        }
        return {
          action: 'CHECKOUT_RECOVERY',
          confidence: 0.81,
          probability: Math.max(0.2, risk.recoverabilityScore),
          reason:
            'Checkout was started but never completed and remains inside the recovery window; ' +
            'a recovery link may convert.',
          requiresApproval: false,
        };
      }

      case 'REPEATED_FAILURE':
        return {
          action: 'ESCALATE',
          confidence: 0.88,
          probability: 0.08,
          reason:
            `Payment has failed ${payment.attemptCount} times; further automated attempts are ` +
            'unlikely to succeed and risk customer friction.',
          requiresApproval: true,
        };

      case 'UNKNOWN':
        // PRD section 10: UNKNOWN_FAILURE = no automatic action.
        return {
          action: 'ESCALATE',
          confidence: 0.35,
          probability: 0.15,
          reason:
            'The failure cause could not be determined from the available signals; ' +
            'escalating rather than acting on an unclear diagnosis.',
          requiresApproval: true,
        };
    }
  }
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function round2(value: number): number {
  return Number(value.toFixed(2));
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** Turn a raw gateway reason into readable prose for the explanation. */
function describeReason(reason: string | null): string {
  if (reason === null) return 'An unreported failure';
  const readable = reason.replace(/_/g, ' ');
  return readable.charAt(0).toUpperCase() + readable.slice(1);
}
