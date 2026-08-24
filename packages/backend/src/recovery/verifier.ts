import type {
  VerificationEvidence,
  VerificationInput,
  VerificationResult,
} from './verification-types.ts';

/**
 * ============================================================================
 * THE OUTCOME VERIFIER
 * ============================================================================
 *
 * A pure function. No database, no network, no clock, no randomness, no LLM,
 * no policy, no execution. It is handed observations and returns a verdict.
 *
 * The rule it exists to enforce:
 *
 *     A provider acknowledgement is NOT evidence of recovered revenue.
 *
 * Three invariants:
 *
 *   1. FAIL CLOSED. Missing, ambiguous, or unrecognised evidence yields
 *      UNCONFIRMED. There is no "probably recovered".
 *
 *   2. EXECUTION NEVER IMPLIES OUTCOME. Even EXECUTION SUCCESS requires a
 *      corroborating observation of the payment before VERIFIED is possible.
 *
 *   3. NO INFERENCE FROM CONFIDENCE. AI confidence is not an input here and
 *      cannot be — it is absent from VerificationInput entirely.
 */

/** Local payment statuses that corroborate a completed payment. */
const STORED_SUCCESS_STATUSES = new Set(['captured']);
/** Local payment statuses that corroborate a definitively failed payment. */
const STORED_FAILURE_STATUSES = new Set(['failed', 'abandoned']);

function evidence(
  type: VerificationEvidence['type'],
  source: VerificationEvidence['source'],
  value: string,
  detail: string,
  reference: string | null,
  observedAt: string,
): VerificationEvidence {
  return { type, source, value, reference, observedAt, detail };
}

/**
 * Verify the business outcome of one executed recovery action.
 *
 * Rules, in order:
 *
 *   R1  execution UNCONFIRMED  -> consult the payment; still ambiguous stays
 *                                 UNCONFIRMED. This is the UNKNOWN resolution
 *                                 path, and it never re-executes anything.
 *   R2  execution FAILED       -> NOT_RECOVERED. The request was rejected.
 *   R3  execution SUCCESS      -> NOT automatically recovered. The observed
 *                                 payment state decides.
 *   R4  anything unrecognised  -> UNCONFIRMED.
 */
export function verifyOutcome(input: VerificationInput): VerificationResult {
  const at = input.now.toISOString();
  const gathered: VerificationEvidence[] = [];

  // Every verdict records what the provider said about our request.
  gathered.push(
    evidence(
      'EXECUTION_RESULT',
      'PROVIDER_EXECUTION',
      input.executionStatus,
      `The provider reported execution status ${input.executionStatus}.`,
      null,
      at,
    ),
  );

  // ---- Executions that never reached a provider verdict ------------------
  // PENDING/EXECUTING mean the request is unresolved; SKIPPED_DUPLICATE means
  // this action never ran at all. None can support an outcome claim.
  if (
    input.executionStatus === 'PENDING' ||
    input.executionStatus === 'EXECUTING' ||
    input.executionStatus === 'SKIPPED_DUPLICATE'
  ) {
    gathered.push(
      evidence(
        'MISSING_EVIDENCE',
        'PROVIDER_EXECUTION',
        input.executionStatus,
        'The action has no completed provider result, so no outcome can be established.',
        null,
        at,
      ),
    );
    return conclude(
      'UNCONFIRMED',
      gathered,
      `Execution is ${input.executionStatus}; no provider result exists yet, so the outcome is unconfirmed.`,
      at,
    );
  }

  // ---- R2: an explicit rejection is conclusive ---------------------------
  if (input.executionStatus === 'FAILED') {
    // The provider definitively rejected the request. No further observation
    // can turn this action into a recovery: a different, successful execution
    // would be required.
    return conclude(
      'NOT_RECOVERED',
      gathered,
      'The provider rejected the recovery request, so no revenue was recovered by this action.',
      at,
    );
  }

  // ---- Observation of the payment itself ---------------------------------
  const observed = input.observedState;

  if (observed === null) {
    gathered.push(
      evidence(
        'MISSING_EVIDENCE',
        'PROVIDER_PAYMENT_STATUS',
        'NOT_OBSERVED',
        input.observationError ??
          'The payment state was not observed, so the outcome cannot be established.',
        null,
        at,
      ),
    );
    return conclude(
      'UNCONFIRMED',
      gathered,
      'No payment observation is available; failing closed rather than assuming an outcome.',
      at,
    );
  }

  gathered.push(
    evidence(
      'OBSERVED_PAYMENT_STATE',
      'PROVIDER_PAYMENT_STATUS',
      observed,
      input.observationError === null
        ? `The provider reports the payment as ${observed}${input.observedRawStatus === null ? '' : ` (${input.observedRawStatus})`}.`
        : `Payment observation reported ${observed}: ${input.observationError}`,
      input.observedReference,
      at,
    ),
  );

  // The locally stored payment status is a second, independent observation.
  if (input.storedPaymentStatus !== null) {
    gathered.push(
      evidence(
        'STORED_PAYMENT_STATE',
        'LOCAL_PAYMENT_RECORD',
        String(input.storedPaymentStatus),
        `The stored payment record shows status "${input.storedPaymentStatus}".`,
        input.paymentId,
        at,
      ),
    );
  }

  // ---- R1 and R3 both resolve on the observed state ----------------------
  // Note that UNCONFIRMED and SUCCESS executions converge here: an ambiguous
  // execution whose payment is observably SUCCEEDED is genuinely recovered,
  // which is exactly how an UNKNOWN action gets resolved without retrying.
  const wasUnconfirmed = input.executionStatus === 'UNCONFIRMED';

  switch (observed) {
    case 'SUCCEEDED': {
      // The provider observation is authoritative for the payment's CURRENT
      // state. The stored record is expected to be stale here: execution
      // deliberately never mutates payment state, so a genuinely recovered
      // payment still reads "failed" locally until verification updates it.
      // Treating that lag as a contradiction would block every legitimate
      // recovery, so the stored value is recorded as corroborating context
      // rather than used as a veto.
      const stored = input.storedPaymentStatus;
      const staleLocal =
        stored !== null &&
        STORED_FAILURE_STATUSES.has(String(stored)) &&
        !STORED_SUCCESS_STATUSES.has(String(stored));

      return conclude(
        'VERIFIED',
        gathered,
        (wasUnconfirmed
          ? 'Execution was unconfirmed, but the payment is observably completed, so the revenue was recovered.'
          : 'The provider accepted the request and the payment is observably completed, so the revenue was recovered.') +
          (staleLocal
            ? ` The stored record still shows "${stored}" and is refreshed from this observation.`
            : ''),
        at,
      );
    }

    case 'FAILED':
      return conclude(
        'NOT_RECOVERED',
        gathered,
        'The payment is observably failed, so no revenue was recovered.',
        at,
      );

    case 'PENDING':
      // Not yet: a pending payment may still complete. Claiming either outcome
      // now would be guessing.
      return conclude(
        'UNCONFIRMED',
        gathered,
        'The payment is still pending; the outcome cannot be established yet.',
        at,
      );

    case 'UNKNOWN':
      return conclude(
        'UNCONFIRMED',
        gathered,
        'The payment state could not be determined; failing closed rather than assuming an outcome.',
        at,
      );
  }

  // Unreachable given the exhaustive switch, but the fallback must be safe.
  return conclude(
    'UNCONFIRMED',
    gathered,
    'The payment state was not recognised; failing closed.',
    at,
  );
}

function conclude(
  status: VerificationResult['status'],
  evidenceList: VerificationEvidence[],
  reason: string,
  verifiedAt: string,
): VerificationResult {
  return {
    status,
    evidence: evidenceList,
    reason,
    verifiedAt,
    // "Recovered" has exactly one definition: a VERIFIED outcome.
    recovered: status === 'VERIFIED',
  };
}

/**
 * Whether a stored verdict may be replaced by a new one.
 *
 * The state machine forbids regression without new evidence:
 *   - VERIFIED is terminal. Money that was verifiably recovered does not
 *     become unrecovered because a later lookup was flaky.
 *   - NOT_RECOVERED is terminal for THIS action. A different, successful
 *     execution would produce a different action with its own verification.
 *   - UNCONFIRMED is the only status open to revision, which is precisely the
 *     resolution path an ambiguous execution needs.
 */
export function canTransition(
  current: VerificationResult['status'] | null,
  next: VerificationResult['status'],
): boolean {
  if (current === null) return true;
  if (current === 'UNCONFIRMED') return true;
  // Re-affirming an existing terminal verdict is allowed; changing it is not.
  return current === next;
}
