import type { PolicyConfig } from '../config/index.ts';
import { PAYMENT_STATUSES, RECOVERY_ACTIONS, type PolicyDecision } from '../shared/types.ts';
import {
  POLICY_VERSION,
  type PolicyInput,
  type PolicyReasonCode,
  type PolicyResult,
  type RuleResult,
} from './types.ts';

/**
 * ============================================================================
 * THE DETERMINISTIC POLICY ENGINE
 * ============================================================================
 *
 * A pure function. No database, no network, no clock, no randomness, no LLM.
 * The same input always produces the same decision, which is what makes an
 * authorization decision auditable and reproducible.
 *
 * Three invariants this module must never violate:
 *
 *   1. FAIL CLOSED. Anything missing, malformed, or unrecognised produces
 *      authorized = false. There is no path that defaults to permission.
 *
 *   2. APPROVAL IS NOT AUTHORIZATION. A rule returning REQUIRES_APPROVAL sets
 *      requiresHumanApproval = true and leaves authorized = false. Needing a
 *      human is never silently upgraded into permission to act.
 *
 *   3. VALUE NEVER OVERRIDES SAFETY. Expected recovery value is not an input
 *      here (PRD section 16). A ₹10,000 opportunity is blocked exactly as
 *      readily as a ₹10 one when a rule says so.
 *
 * The AI recommendation arrives as `proposedAction`. It is data to be checked,
 * never an instruction to be obeyed — no field in PolicyInput can widen a limit.
 */

/** Statuses from which a recovery action can legitimately be attempted. */
const RECOVERABLE_STATUSES = new Set(['failed', 'abandoned', 'created', 'authorized']);

/** Terminal states where intervention is wrong or conflicting. */
const CONFLICTING_STATUSES: Readonly<Record<string, PolicyReasonCode>> = Object.freeze({
  captured: 'PAYMENT_ALREADY_CAPTURED',
  refunded: 'PAYMENT_ALREADY_REFUNDED',
});

/** Actions that move money and therefore face the full financial rule set. */
const MONEY_MOVING_ACTIONS = new Set(['RETRY', 'SUBSCRIPTION_RETRY']);

/** Actions that contact the customer and therefore face communication limits. */
const CUSTOMER_CONTACT_ACTIONS = new Set(['REMINDER', 'CHECKOUT_RECOVERY']);

/**
 * Actions that are inert: they neither move money nor contact anyone.
 * They are still evaluated (so the audit record is complete) but are not
 * subject to amount, retry, or confidence gates.
 */
const PASSIVE_ACTIONS = new Set(['NO_ACTION', 'ESCALATE']);

function pass(rule: RuleResult['rule'], reason: string): RuleResult {
  return { rule, status: 'PASS', code: null, reason };
}

function fail(rule: RuleResult['rule'], code: PolicyReasonCode, reason: string): RuleResult {
  return { rule, status: 'FAIL', code, reason };
}

function approval(rule: RuleResult['rule'], code: PolicyReasonCode, reason: string): RuleResult {
  return { rule, status: 'REQUIRES_APPROVAL', code, reason };
}

function notApplicable(rule: RuleResult['rule'], reason: string): RuleResult {
  return { rule, status: 'NOT_APPLICABLE', code: null, reason };
}

/** Assemble the final verdict from the collected rule results. */
function summarise(action: string, rules: RuleResult[]): PolicyResult {
  const denialReasons = rules
    .filter((r) => r.status === 'FAIL')
    .map((r) => r.code)
    .filter((code): code is PolicyReasonCode => code !== null);

  const approvalReasons = rules
    .filter((r) => r.status === 'REQUIRES_APPROVAL')
    .map((r) => r.code)
    .filter((code): code is PolicyReasonCode => code !== null);

  const hasFailure = denialReasons.length > 0;
  const needsApproval = approvalReasons.length > 0;

  // Authorization requires the absence of BOTH failures and approval gates.
  // This is the line that keeps "a human must look at it" from becoming "go".
  const authorized = !hasFailure && !needsApproval;

  const decision: PolicyDecision = hasFailure
    ? 'BLOCKED'
    : needsApproval
      ? 'REQUIRES_APPROVAL'
      : 'ALLOWED';

  return {
    authorized,
    requiresHumanApproval: needsApproval,
    action,
    decision,
    rules,
    denialReasons,
    approvalReasons,
    policyVersion: POLICY_VERSION,
  };
}

/**
 * Evaluate one proposed action against deterministic policy.
 *
 * Every rule is evaluated and reported even after an earlier one fails, so the
 * operator sees the complete picture rather than only the first objection.
 */
export function evaluatePolicy(input: PolicyInput, config: PolicyConfig): PolicyResult {
  const rules: RuleResult[] = [];
  const action = typeof input.proposedAction === 'string' ? input.proposedAction : '';

  // ---- Rule: required information present (fail closed) ------------------
  // Runs first because every later rule depends on these values being sane.
  const missing: string[] = [];
  if (typeof input.paymentId !== 'string' || input.paymentId.trim() === '') {
    missing.push('paymentId');
  }
  if (!Number.isFinite(input.amount) || !Number.isInteger(input.amount) || input.amount <= 0) {
    missing.push('amount');
  }
  if (!Number.isFinite(input.confidence) || input.confidence < 0 || input.confidence > 1) {
    missing.push('confidence');
  }
  if (!Number.isInteger(input.attemptCount) || input.attemptCount < 0) {
    missing.push('attemptCount');
  }

  if (missing.length > 0) {
    const code: PolicyReasonCode = missing.includes('paymentId')
      ? 'MISSING_PAYMENT_ID'
      : 'MISSING_REQUIRED_INFORMATION';
    rules.push(
      fail(
        'REQUIRED_INFORMATION_PRESENT',
        code,
        `Safety-critical information is missing or invalid: ${missing.join(', ')}. Failing closed.`,
      ),
    );
    // Nothing further can be judged reliably; return blocked immediately.
    return summarise(action, rules);
  }
  rules.push(pass('REQUIRED_INFORMATION_PRESENT', 'All safety-critical fields are present.'));

  // ---- Rule: action is supported -----------------------------------------
  const actionSupported = (RECOVERY_ACTIONS as readonly string[]).includes(action);
  rules.push(
    actionSupported
      ? pass('ACTION_SUPPORTED', `"${action}" is a supported recovery action.`)
      : fail(
          'ACTION_SUPPORTED',
          'UNSUPPORTED_ACTION',
          `"${action}" is not a supported recovery action.`,
        ),
  );

  // ---- Rule: payment state is recognised ---------------------------------
  const statusKnown = (PAYMENT_STATUSES as readonly string[]).includes(String(input.paymentStatus));
  rules.push(
    statusKnown
      ? pass('PAYMENT_STATE_KNOWN', `Payment status "${input.paymentStatus}" is recognised.`)
      : fail(
          'PAYMENT_STATE_KNOWN',
          'UNKNOWN_PAYMENT_STATE',
          `Payment status "${input.paymentStatus}" is not recognised; refusing to act on an unknown state.`,
        ),
  );

  // ---- Rule: not already recovered ---------------------------------------
  rules.push(
    input.alreadyRecovered
      ? fail(
          'PAYMENT_NOT_ALREADY_RECOVERED',
          'PAYMENT_ALREADY_RECOVERED',
          'Payment has already been recovered; further intervention would be duplicate work and customer friction.',
        )
      : pass('PAYMENT_NOT_ALREADY_RECOVERED', 'Payment has not been recovered yet.'),
  );

  // ---- Rule: no conflicting terminal state -------------------------------
  const conflictCode = CONFLICTING_STATUSES[String(input.paymentStatus)];
  rules.push(
    conflictCode === undefined
      ? pass('PAYMENT_STATE_NOT_CONFLICTING', 'Payment is not in a conflicting terminal state.')
      : fail(
          'PAYMENT_STATE_NOT_CONFLICTING',
          conflictCode,
          `Payment is already ${input.paymentStatus}; acting on it would conflict with settled state.`,
        ),
  );

  // ---- Rule: payment eligible for recovery -------------------------------
  const eligible = RECOVERABLE_STATUSES.has(String(input.paymentStatus));
  rules.push(
    eligible
      ? pass('PAYMENT_ELIGIBLE_FOR_RECOVERY', `Status "${input.paymentStatus}" is recoverable.`)
      : fail(
          'PAYMENT_ELIGIBLE_FOR_RECOVERY',
          'PAYMENT_NOT_ELIGIBLE',
          `Status "${input.paymentStatus}" is not eligible for a recovery action.`,
        ),
  );

  // ---- Rule: no duplicate action -----------------------------------------
  rules.push(
    input.duplicateActionExists
      ? fail(
          'NO_DUPLICATE_ACTION',
          'DUPLICATE_ACTION',
          'An equivalent recovery action already exists for this payment.',
        )
      : pass('NO_DUPLICATE_ACTION', 'No duplicate recovery action exists.'),
  );

  const isPassive = PASSIVE_ACTIONS.has(action);
  const movesMoney = MONEY_MOVING_ACTIONS.has(action);
  const contactsCustomer = CUSTOMER_CONTACT_ACTIONS.has(action);

  // ---- Rule: retry limit --------------------------------------------------
  if (movesMoney) {
    const withinLimit = input.attemptCount < config.maxRetryAttempts;
    rules.push(
      withinLimit
        ? pass(
            'RETRY_LIMIT_AVAILABLE',
            `${input.attemptCount} of ${config.maxRetryAttempts} retry attempts used.`,
          )
        : fail(
            'RETRY_LIMIT_AVAILABLE',
            'MAX_RETRIES_EXCEEDED',
            `Retry limit reached: ${input.attemptCount} attempts against a maximum of ${config.maxRetryAttempts}.`,
          ),
    );

    // ---- Rule: retry cooldown --------------------------------------------
    // A null elapsed time means no prior attempt, so no cooldown applies.
    const elapsed = input.secondsSinceLastAttempt;
    if (elapsed === null || input.attemptCount === 0) {
      rules.push(notApplicable('RETRY_COOLDOWN_ELAPSED', 'No previous attempt to cool down from.'));
    } else if (elapsed >= config.retryCooldownSeconds) {
      rules.push(
        pass(
          'RETRY_COOLDOWN_ELAPSED',
          `${Math.floor(elapsed)}s since the last attempt meets the ${config.retryCooldownSeconds}s cooldown.`,
        ),
      );
    } else {
      rules.push(
        fail(
          'RETRY_COOLDOWN_ELAPSED',
          'RETRY_COOLDOWN_ACTIVE',
          `Only ${Math.floor(elapsed)}s since the last attempt; the cooldown is ${config.retryCooldownSeconds}s.`,
        ),
      );
    }
  } else {
    rules.push(notApplicable('RETRY_LIMIT_AVAILABLE', `"${action}" does not consume a retry.`));
    rules.push(notApplicable('RETRY_COOLDOWN_ELAPSED', `"${action}" is not a retry.`));
  }

  // ---- Rule: amount within automated limit -------------------------------
  // Applies to any action that touches the customer or their money. A passive
  // action moves nothing, so the ceiling is irrelevant to it.
  if (isPassive) {
    rules.push(
      notApplicable('AMOUNT_WITHIN_AUTOMATED_LIMIT', `"${action}" performs no automated action.`),
    );
  } else if (input.amount <= config.maxAutomatedAmount) {
    rules.push(
      pass(
        'AMOUNT_WITHIN_AUTOMATED_LIMIT',
        `Amount ${input.amount} is within the automated limit of ${config.maxAutomatedAmount}.`,
      ),
    );
  } else {
    // Exceeding the AUTOMATED ceiling means "too large to act on without a
    // human" — not "impossible". The PRD's own worked example (sections 11 and
    // 17) shows a ₹25,000 payment above the threshold routed to manual
    // approval, not dead-ended. So this gates rather than denies.
    //
    // It is still not authorization: requiresHumanApproval blocks execution
    // just as firmly, and a human must act before anything happens.
    rules.push(
      approval(
        'AMOUNT_WITHIN_AUTOMATED_LIMIT',
        'AMOUNT_EXCEEDS_AUTOMATED_LIMIT',
        `Amount ${input.amount} exceeds the automated limit of ${config.maxAutomatedAmount}; a human must approve.`,
      ),
    );
  }

  // ---- Rule: confidence sufficient ---------------------------------------
  if (isPassive) {
    rules.push(
      notApplicable('CONFIDENCE_SUFFICIENT', `"${action}" does not require a confidence threshold.`),
    );
  } else {
    const confident = input.confidence >= config.minRecoveryConfidence;
    rules.push(
      confident
        ? pass(
            'CONFIDENCE_SUFFICIENT',
            `Confidence ${input.confidence.toFixed(2)} meets the ${config.minRecoveryConfidence} minimum.`,
          )
        : fail(
            'CONFIDENCE_SUFFICIENT',
            'INSUFFICIENT_CONFIDENCE',
            `Confidence ${input.confidence.toFixed(2)} is below the ${config.minRecoveryConfidence} minimum for automated action.`,
          ),
    );
  }

  // ---- Rule: high-value approval -----------------------------------------
  // This gates rather than denies: the action may well be correct, but a human
  // must sign off. Note this is REQUIRES_APPROVAL, never PASS.
  if (isPassive) {
    rules.push(notApplicable('HIGH_VALUE_APPROVAL', `"${action}" moves no money.`));
  } else if (input.amount >= config.highValueThreshold) {
    rules.push(
      approval(
        'HIGH_VALUE_APPROVAL',
        'HIGH_VALUE_REQUIRES_APPROVAL',
        `Amount ${input.amount} is at or above the high-value threshold of ${config.highValueThreshold}; a human must approve.`,
      ),
    );
  } else if (input.humanReviewRequested) {
    rules.push(
      approval(
        'HIGH_VALUE_APPROVAL',
        'CUSTOMER_INTERVENTION_REQUIRES_APPROVAL',
        'This case was flagged for human review by the detection or diagnosis layer.',
      ),
    );
  } else if (contactsCustomer && input.remindersSent >= config.maxRemindersPerPayment) {
    rules.push(
      approval(
        'HIGH_VALUE_APPROVAL',
        'CUSTOMER_INTERVENTION_REQUIRES_APPROVAL',
        `${input.remindersSent} reminders already sent (limit ${config.maxRemindersPerPayment}); further contact needs approval.`,
      ),
    );
  } else {
    rules.push(pass('HIGH_VALUE_APPROVAL', 'Amount is below the threshold requiring approval.'));
  }

  // ESCALATE is by definition a request for a human. Recording it as an
  // approval requirement keeps the decision honest: it is not an authorized
  // automated action.
  if (action === 'ESCALATE') {
    rules.push(
      approval(
        'PAYMENT_ELIGIBLE_FOR_RECOVERY',
        'ESCALATION_REQUIRES_HUMAN',
        'The recommended action is escalation, which by definition requires a human.',
      ),
    );
  }

  return summarise(action, rules);
}

/**
 * Convenience predicate used by callers that only need the verdict.
 * Kept separate so no caller is tempted to reconstruct the rule from parts.
 */
export function isAuthorized(result: PolicyResult): boolean {
  return result.authorized;
}
