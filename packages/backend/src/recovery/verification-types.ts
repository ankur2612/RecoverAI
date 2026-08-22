import type {
  ExecutionStatus,
  PaymentStatus,
  VerificationStatus,
} from '../shared/types.ts';
import type { ObservedPaymentState } from '../payments/provider.ts';

/**
 * ============================================================================
 * OUTCOME VERIFICATION — TYPES
 * ============================================================================
 *
 * The distinction this layer exists to enforce:
 *
 *   EXECUTION  what the provider said about OUR REQUEST
 *   OUTCOME    what the EVIDENCE says actually happened to the money
 *
 * A provider saying "retry accepted" is not evidence that revenue was
 * recovered. Verification establishes the business outcome independently.
 */

/** Where an observation came from. */
export const EVIDENCE_SOURCES = [
  'PROVIDER_EXECUTION',
  'PROVIDER_PAYMENT_STATUS',
  'LOCAL_PAYMENT_RECORD',
] as const;
export type EvidenceSource = (typeof EVIDENCE_SOURCES)[number];

export const EVIDENCE_TYPES = [
  'EXECUTION_RESULT',
  'OBSERVED_PAYMENT_STATE',
  'STORED_PAYMENT_STATE',
  'MISSING_EVIDENCE',
] as const;
export type EvidenceType = (typeof EVIDENCE_TYPES)[number];

/**
 * One observation supporting a verdict.
 *
 * Deliberately structured rather than free text: a reviewer must be able to
 * reconstruct WHY an outcome was called recovered, and a string blob cannot be
 * queried or aggregated.
 *
 * MUST NOT contain credentials, authorization headers, or raw provider
 * payloads — only the specific facts the verdict rests on.
 */
export interface VerificationEvidence {
  type: EvidenceType;
  source: EvidenceSource;
  /** The observed value, e.g. 'SUCCESS', 'PENDING', 'captured'. */
  value: string;
  /** Opaque provider/local reference for reconciliation. */
  reference: string | null;
  /** ISO-8601 instant the observation was made. */
  observedAt: string;
  /** Short human-readable note. Never internal model reasoning. */
  detail: string;
}

/** Everything the verifier needs. Assembled by the caller; the verifier is pure. */
export interface VerificationInput {
  paymentId: string;
  /** The execution status recorded against the action. */
  executionStatus: ExecutionStatus;
  /** Payment state observed from the provider, or null when not consulted. */
  observedState: ObservedPaymentState | null;
  /** Raw provider status string, for evidence. */
  observedRawStatus: string | null;
  /** Provider reference for the observation. */
  observedReference: string | null;
  /** Error from the status lookup, when it failed. */
  observationError: string | null;
  /** The payment status stored locally, as a corroborating observation. */
  storedPaymentStatus: PaymentStatus | string | null;
  /** Evaluation instant, injected so the verifier stays a pure function. */
  now: Date;
}

/** The verifier's verdict. */
export interface VerificationResult {
  status: VerificationStatus;
  /** Every observation the verdict rests on, in the order gathered. */
  evidence: VerificationEvidence[];
  /** Concise explanation naming the facts that produced the status. */
  reason: string;
  /** ISO-8601 instant of the verdict. */
  verifiedAt: string;
  /**
   * True only for VERIFIED. Present so no consumer has to re-derive the
   * meaning of the status, and so "recovered" has exactly one definition.
   */
  recovered: boolean;
}
