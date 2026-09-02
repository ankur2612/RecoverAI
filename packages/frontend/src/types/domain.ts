/**
 * BACKEND RESPONSE TYPES
 *
 * These mirror what the API actually returns — snake_case, verified against
 * the serialisers in packages/backend/src/api/. They are DESCRIPTIONS of
 * responses, not a re-implementation of the domain.
 *
 * The frontend deliberately does NOT contain:
 *   - policy evaluation        (the deterministic engine decides)
 *   - recovery eligibility     (the batch layer decides)
 *   - idempotency              (the database decides)
 *   - verification             (provider evidence decides)
 *   - recovered-revenue maths  (analytics computes it, VERIFIED-gated, in SQL)
 *
 * If a number matters financially, it comes from the backend as an integer in
 * minor units and is only ever FORMATTED here.
 */


export type PaymentStatus =
  | 'created'
  | 'authorized'
  | 'captured'
  | 'failed'
  | 'refunded'
  | 'abandoned';

export type Classification =
  | 'TEMPORARY_FAILURE'
  | 'CUSTOMER_ACTION_REQUIRED'
  | 'PAYMENT_METHOD_PROBLEM'
  | 'CHECKOUT_ABANDONMENT'
  | 'SUBSCRIPTION_FAILURE'
  | 'REPEATED_FAILURE'
  | 'UNKNOWN';

export type RecoveryAction =
  | 'RETRY'
  | 'REMINDER'
  | 'CHECKOUT_RECOVERY'
  | 'SUBSCRIPTION_RETRY'
  | 'ESCALATE'
  | 'NO_ACTION';

/** What the deterministic policy engine decided. Never set by the AI. */
export type PolicyDecision = 'ALLOWED' | 'BLOCKED' | 'REQUIRES_APPROVAL';

/** What the PROVIDER told us about our request — not what happened to money. */
export type ExecutionStatus =
  | 'PENDING'
  | 'EXECUTING'
  | 'SUCCESS'
  | 'FAILED'
  | 'UNCONFIRMED'
  | 'SKIPPED_DUPLICATE';

/** What the EVIDENCE proves. Only VERIFIED means money moved. */
export type VerificationStatus = 'VERIFIED' | 'NOT_RECOVERED' | 'UNCONFIRMED';

export type CaseStatus =
  | 'OPEN'
  | 'AWAITING_APPROVAL'
  | 'APPROVED'
  | 'REJECTED'
  | 'EXECUTING'
  | 'AWAITING_VERIFICATION'
  | 'RECOVERED'
  | 'FAILED'
  | 'ESCALATED'
  | 'CLOSED';

export type ApprovalDecision = 'APPROVED' | 'REJECTED';


export interface Payment {
  payment_id: string;
  order_id: string;
  customer_id: string;
  merchant_id: string;
  /** Minor units (paise). Never a float, never pre-divided. */
  amount: number;
  currency: string;
  status: PaymentStatus;
  failure_reason: string | null;
  attempt_count: number;
  is_subscription: boolean;
  created_at: string;
  updated_at: string;
}

/**
 * A recovery case carries the AI DIAGNOSIS (classification, recommended
 * action, confidence) plus the current lifecycle status. It does NOT carry the
 * policy verdict — that lives on the action, recorded at execution time.
 */
export interface RecoveryCase {
  id: string;
  payment_id: string;
  risk_score: number;
  recoverability_score: number;
  classification: Classification;
  recommended_action: RecoveryAction;
  confidence: number;
  /** Minor units. */
  revenue_at_risk: number;
  reason: string;
  status: CaseStatus;
  created_at: string;
  updated_at: string;
}

/**
 * One attempted action. This single row spans three DISTINCT lifecycle stages
 * that the UI must never merge:
 *
 *   policy_status        what the rules permitted
 *   execution_status     what the provider said about our request
 *   verification_status  what the evidence proved
 */
export interface RecoveryActionRecord {
  id: string;
  recovery_case_id: string;
  action_type: RecoveryAction;
  policy_status: PolicyDecision;
  policy_version: string | null;
  execution_status: ExecutionStatus;
  /** Minor units. */
  amount: number;
  idempotency_key: string;
  provider: string | null;
  provider_reference: string | null;
  error_message: string | null;
  verification_status: VerificationStatus | null;
  verification_reason: string | null;
  verified_at: string | null;
  observed_payment_status: string | null;
  verification_attempts: number;
  created_at: string;
  executed_at: string | null;
  completed_at: string | null;
}

/** A human decision. Records that a person said yes — never an authorization. */
export interface Approval {
  id: string;
  case_id: string;
  decision: ApprovalDecision;
  /** A service identity under shared-token auth, not a named person. */
  actor: string;
  reason: string | null;
  approved_action: RecoveryAction;
  policy_version: string | null;
  created_at: string;
}

export interface AuditEvent {
  id: string;
  payment_id: string | null;
  case_id: string | null;
  event_type: string;
  actor: string;
  decision: string | null;
  /** Written by services; contains decision codes and scrubbed messages only. */
  metadata: Record<string, unknown>;
  created_at: string;
}


export interface CaseDetail {
  case: RecoveryCase;
  payment: Payment | null;
  actions: RecoveryActionRecord[];
  approval: Approval | null;
  audit: AuditEvent[];
}

/**
 * Pagination envelope.
 *
 * EVERY list endpoint nests pagination under this key: /api/recovery/cases,
 * /api/payments, and /api/audit. Verified against the live API rather than
 * assumed — an earlier revision of this file declared these fields flat,
 * which silently produced `total: undefined` and rendered "0 cases" beside a
 * full table.
 */
export interface Pagination {
  total: number;
  limit: number;
  offset: number;
}

export interface CaseListResponse {
  cases: RecoveryCase[];
  pagination: Pagination;
}

export interface PaymentListResponse {
  payments: Payment[];
  pagination: Pagination;
}

export interface AuditListResponse {
  events: AuditEvent[];
  pagination: Pagination;
}

export interface CountByKey {
  key: string;
  count: number;
}

/**
 * Aggregate recovery analytics.
 *
 * `amount_recovered` counts ONLY actions whose verification_status is
 * VERIFIED. The backend enforces that in SQL; the frontend must never
 * recompute or approximate it.
 */
export interface RecoveryAnalytics {
  total_cases: number;
  total_payments: number;
  amount_at_risk: number;
  amount_recovered: number;
  amount_unrecovered: number;
  recovery_rate: number;
  currency_unit: 'minor';
  cases_by_status: CountByKey[];
  cases_by_action: CountByKey[];
  actions_by_execution_status: CountByKey[];
  actions_by_verification_status: CountByKey[];
  actions_by_policy_status: CountByKey[];
  definitions: Record<string, string>;
}

export interface BatchItem {
  payment_id: string;
  case_id: string | null;
  status: string;
  action: RecoveryAction | null;
  policy_decision: string | null;
  refusal_reason: string | null;
  verification_status: VerificationStatus | null;
  amount_at_risk: number;
  amount_recovered: number;
  message: string;
}

export interface BatchRun {
  run_id: string;
  started_at: string;
  finished_at: string;
  total_eligible: number;
  analyzed: number;
  authorized: number;
  rejected: number;
  executed: number;
  verified: number;
  recovered: number;
  failed: number;
  skipped_duplicate: number;
  amount_at_risk: number;
  amount_recovered: number;
  items: BatchItem[];
}

export interface SweepItem {
  action_id: string;
  payment_id: string;
  case_id: string;
  stranded_in: string;
  outcome: string;
  observed_state: string | null;
  execution_status: string | null;
  verification_status: string | null;
  message: string;
}

export interface SweepRun {
  started_at: string;
  finished_at: string;
  found: number;
  resolved_success: number;
  resolved_failed: number;
  still_unconfirmed: number;
  already_resolved: number;
  failed: number;
  items: SweepItem[];
}

export interface DecisionResponse {
  recorded: boolean;
  message: string;
  approval: Approval | null;
  case: RecoveryCase | null;
  note: string;
}

/**
 * Health, including redactedConfig().
 *
 * Every credential field here is a PRESENCE FLAG, never a value — the backend
 * reduces secrets before serialising. The Settings screen shows "Configured",
 * never a key.
 */
export interface HealthResponse {
  status: 'ok' | 'degraded';
  service: string;
  version: string;
  timestamp: string;
  database: { reachable: boolean; error?: string };
  config: {
    nodeEnv: string;
    port: number;
    logLevel: string;
    databaseConfigured: boolean;
    /** True when either the payment or AI provider is mocked. Never a credential. */
    simulated: boolean;
    // `model` is OMITTED from the JSON entirely when the provider is mock,
    // so it is optional rather than `string | undefined` — a consumer must
    // handle its absence, not merely a null value.
    ai: { provider: string; model?: string; credentialPresent: boolean };
    payments: { provider: string; credentialPresent: boolean; mode: 'test' };
    auth: { enabled: boolean; credentialPresent: boolean };
    rateLimit: { enabled: boolean; max: number; windowMs: number };
    /*
     * Named explicitly rather than Record<string, number>: an index signature
     * makes every field possibly-undefined under noUncheckedIndexedAccess,
     * which forces non-null assertions at each use. These keys are a fixed,
     * documented contract (PolicyConfig in the backend), so they are declared.
     */
    policy: {
      maxRetryAttempts: number;
      maxAutomatedAmount: number;
      minRecoveryConfidence: number;
      retryCooldownSeconds: number;
      highValueThreshold: number;
      recoveryWindowHours: number;
      maxRemindersPerPayment: number;
    };
    dataset: {
      seed: number;
      recordCount: number;
      evalSplit: number;
      avgTransactionValue: number;
      customerRepeatRate: number;
    };
  };
}
