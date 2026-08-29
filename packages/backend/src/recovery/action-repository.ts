import type pg from 'pg';
import { getPool } from '../db/pool.ts';
import type {
  ExecutionStatus,
  MinorUnits,
  PolicyDecision,
  RecoveryActionType,
  VerificationStatus,
} from '../shared/types.ts';
import type { VerificationEvidence } from './verification-types.ts';

type Queryable = Pick<pg.Pool | pg.PoolClient, 'query'>;

/**
 * Recovery action persistence.
 *
 * The critical operation here is `claimAction`: it inserts a row carrying the
 * idempotency key, relying on the table's UNIQUE constraint to decide which of
 * N concurrent callers owns the right to call the provider.
 *
 * This is deliberately NOT a read-then-write check. Two requests can both read
 * "no existing action" and both proceed; only the database can arbitrate. The
 * insert IS the lock.
 */

export interface RecoveryAction {
  id: string;
  recoveryCaseId: string;
  actionType: RecoveryActionType;
  policyStatus: PolicyDecision;
  policyReason: string | null;
  policyVersion: string | null;
  executionStatus: ExecutionStatus;
  amount: MinorUnits;
  idempotencyKey: string;
  provider: string | null;
  providerReference: string | null;
  errorMessage: string | null;
  createdAt: Date;
  executedAt: Date | null;
  completedAt: Date | null;
  /** Null until verification has run. Never defaulted to a verdict. */
  verificationStatus: VerificationStatus | null;
  verificationReason: string | null;
  verifiedAt: Date | null;
  observedPaymentStatus: string | null;
  verificationEvidence: VerificationEvidence[];
  verificationAttempts: number;
}

interface ActionRow {
  id: string;
  recovery_case_id: string;
  action_type: string;
  policy_status: string;
  policy_reason: string | null;
  policy_version: string | null;
  execution_status: string;
  amount: number;
  idempotency_key: string;
  provider: string | null;
  provider_reference: string | null;
  error_message: string | null;
  created_at: Date;
  executed_at: Date | null;
  completed_at: Date | null;
  verification_status: string | null;
  verification_reason: string | null;
  verified_at: Date | null;
  observed_payment_status: string | null;
  verification_evidence: VerificationEvidence[];
  verification_attempts: number;
}

const ACTION_COLUMNS = `id, recovery_case_id, action_type, policy_status, policy_reason,
  policy_version, execution_status, amount, idempotency_key, provider,
  provider_reference, error_message, created_at, executed_at, completed_at,
  verification_status, verification_reason, verified_at, observed_payment_status,
  verification_evidence, verification_attempts`;

function rowToAction(row: ActionRow): RecoveryAction {
  return {
    id: row.id,
    recoveryCaseId: row.recovery_case_id,
    actionType: row.action_type as RecoveryActionType,
    policyStatus: row.policy_status as PolicyDecision,
    policyReason: row.policy_reason,
    policyVersion: row.policy_version,
    executionStatus: row.execution_status as ExecutionStatus,
    amount: row.amount,
    idempotencyKey: row.idempotency_key,
    provider: row.provider,
    providerReference: row.provider_reference,
    errorMessage: row.error_message,
    createdAt: row.created_at,
    executedAt: row.executed_at,
    completedAt: row.completed_at,
    verificationStatus: row.verification_status as VerificationStatus | null,
    verificationReason: row.verification_reason,
    verifiedAt: row.verified_at,
    observedPaymentStatus: row.observed_payment_status,
    verificationEvidence: row.verification_evidence ?? [],
    verificationAttempts: row.verification_attempts ?? 0,
  };
}

export interface ClaimActionArgs {
  id: string;
  recoveryCaseId: string;
  actionType: RecoveryActionType;
  policyStatus: PolicyDecision;
  policyReason: string | null;
  policyVersion: string;
  amount: MinorUnits;
  idempotencyKey: string;
  provider: string;
}

export interface ClaimResult {
  /** True when this caller won the race and may call the provider. */
  claimed: boolean;
  action: RecoveryAction;
}

/**
 * Atomically claim the right to execute one logical action.
 *
 * `ON CONFLICT (idempotency_key) DO NOTHING` makes the insert a no-op for the
 * loser of a race; the follow-up SELECT then returns the winner's row. Exactly
 * one caller ever sees `claimed: true`, even under concurrency, because the
 * database — not application logic — arbitrates.
 *
 * The row is created in PENDING: the key is owned, but nothing has been sent.
 */
export async function claimAction(
  args: ClaimActionArgs,
  db: Queryable = getPool(),
): Promise<ClaimResult> {
  const { rows } = await db.query<ActionRow>(
    `INSERT INTO recovery_actions (
       id, recovery_case_id, action_type, policy_status, policy_reason,
       policy_version, execution_status, amount, idempotency_key, provider
     )
     VALUES ($1,$2,$3,$4,$5,$6,'PENDING',$7,$8,$9)
     ON CONFLICT (idempotency_key) DO NOTHING
     RETURNING ${ACTION_COLUMNS}`,
    [
      args.id,
      args.recoveryCaseId,
      args.actionType,
      args.policyStatus,
      args.policyReason,
      args.policyVersion,
      args.amount,
      args.idempotencyKey,
      args.provider,
    ],
  );

  if (rows.length === 1) {
    return { claimed: true, action: rowToAction(rows[0]!) };
  }

  // Lost the race (or a prior request already claimed it). Return the existing
  // row so the caller can report the established outcome without acting.
  const existing = await findActionByIdempotencyKey(args.idempotencyKey, db);
  if (existing === null) {
    // The conflicting row vanished between the insert and the select — only
    // possible if something deleted it concurrently. Fail closed rather than
    // retrying the insert, which could double-execute.
    throw new Error(
      `idempotency key "${args.idempotencyKey}" conflicted but no action row could be read`,
    );
  }
  return { claimed: false, action: existing };
}

export async function findActionByIdempotencyKey(
  idempotencyKey: string,
  db: Queryable = getPool(),
): Promise<RecoveryAction | null> {
  const { rows } = await db.query<ActionRow>(
    `SELECT ${ACTION_COLUMNS} FROM recovery_actions WHERE idempotency_key = $1`,
    [idempotencyKey],
  );
  return rows.length === 0 ? null : rowToAction(rows[0]!);
}

export async function findActionById(
  id: string,
  db: Queryable = getPool(),
): Promise<RecoveryAction | null> {
  const { rows } = await db.query<ActionRow>(
    `SELECT ${ACTION_COLUMNS} FROM recovery_actions WHERE id = $1`,
    [id],
  );
  return rows.length === 0 ? null : rowToAction(rows[0]!);
}

/** Move a claimed action to EXECUTING immediately before the provider call. */
export async function markExecuting(
  id: string,
  db: Queryable = getPool(),
): Promise<RecoveryAction> {
  const { rows } = await db.query<ActionRow>(
    `UPDATE recovery_actions
     SET execution_status = 'EXECUTING', executed_at = now()
     WHERE id = $1 AND execution_status = 'PENDING'
     RETURNING ${ACTION_COLUMNS}`,
    [id],
  );
  if (rows.length === 0) {
    // Guard against a second transition: a row already past PENDING must not
    // be re-sent to the provider.
    throw new Error(`action ${id} could not be moved to EXECUTING (not in PENDING)`);
  }
  return rowToAction(rows[0]!);
}

export interface CompleteActionArgs {
  id: string;
  executionStatus: Extract<ExecutionStatus, 'SUCCESS' | 'FAILED' | 'UNCONFIRMED'>;
  providerReference: string | null;
  errorMessage: string | null;
}

/** Record the provider's verdict against a claimed action. */
export async function completeAction(
  args: CompleteActionArgs,
  db: Queryable = getPool(),
): Promise<RecoveryAction> {
  const { rows } = await db.query<ActionRow>(
    `UPDATE recovery_actions
     SET execution_status = $2,
         provider_reference = $3,
         error_message = $4,
         completed_at = now()
     WHERE id = $1
     RETURNING ${ACTION_COLUMNS}`,
    [args.id, args.executionStatus, args.providerReference, args.errorMessage],
  );
  if (rows.length === 0) throw new Error(`action ${args.id} not found while completing`);
  return rowToAction(rows[0]!);
}

export async function listActionsForCase(
  recoveryCaseId: string,
  db: Queryable = getPool(),
): Promise<RecoveryAction[]> {
  const { rows } = await db.query<ActionRow>(
    `SELECT ${ACTION_COLUMNS} FROM recovery_actions
     WHERE recovery_case_id = $1 ORDER BY created_at ASC, id ASC`,
    [recoveryCaseId],
  );
  return rows.map(rowToAction);
}

export interface RecordVerificationArgs {
  id: string;
  verificationStatus: VerificationStatus;
  verificationReason: string;
  observedPaymentStatus: string | null;
  evidence: VerificationEvidence[];
}

/**
 * Persist a verification verdict against an action.
 *
 * The WHERE clause enforces the no-regression rule in SQL rather than in
 * application code: a terminal verdict (VERIFIED / NOT_RECOVERED) can only be
 * re-affirmed, never changed. Only NULL or UNCONFIRMED is open to revision,
 * which is exactly the resolution path an ambiguous execution needs.
 *
 * Returns null when the update was refused, so the caller can report the
 * existing verdict rather than silently overwriting it.
 */
export async function recordVerification(
  args: RecordVerificationArgs,
  db: Queryable = getPool(),
): Promise<RecoveryAction | null> {
  const { rows } = await db.query<ActionRow>(
    `UPDATE recovery_actions
     SET verification_status = $2,
         verification_reason = $3,
         observed_payment_status = $4,
         verification_evidence = $5::jsonb,
         verified_at = now(),
         verification_attempts = verification_attempts + 1
     WHERE id = $1
       AND (
         verification_status IS NULL
         OR verification_status = 'UNCONFIRMED'
         OR verification_status = $2
       )
     RETURNING ${ACTION_COLUMNS}`,
    [
      args.id,
      args.verificationStatus,
      args.verificationReason,
      args.observedPaymentStatus,
      JSON.stringify(args.evidence),
    ],
  );
  return rows.length === 0 ? null : rowToAction(rows[0]!);
}

/**
 * The most recent completed action for a case.
 *
 * Verification targets a completed execution; PENDING/EXECUTING rows have no
 * provider verdict to verify yet.
 */
/**
 * Payment ids, from the supplied set, that already have an attempted action.
 *
 * "Attempted" means an action row exists in any state other than
 * SKIPPED_DUPLICATE — i.e. the idempotency key was claimed for that payment,
 * so a provider request either completed, is in flight, or may have been sent.
 *
 * This exists for the batch layer's eligibility check. Per-case idempotency is
 * already guaranteed by the UNIQUE idempotency key, but a payment whose case
 * reached a terminal state is no longer "live", so re-analysis would create a
 * SECOND case with a legitimately different key — and the executor, correctly,
 * would allow it. Screening those payments out is the batch layer's job; it
 * must not be solved by weakening the executor.
 *
 * WHY EVERY NON-DUPLICATE STATE COUNTS, not just the terminal ones:
 *
 *   EXECUTING is the window between claiming the key and hearing back from the
 *   provider. Migration 002 states it plainly — a row stuck in EXECUTING after
 *   a crash "is exactly as ambiguous as UNCONFIRMED and must be resolved by
 *   state verification, never by a blind retry". Treating it as un-attempted
 *   would let a re-run fork a second case and send a second request for a
 *   payment that may already have been charged.
 *
 *   PENDING means the key is claimed but the provider was not called. Forking
 *   a second case for it would still produce a duplicate live attempt.
 *
 * SKIPPED_DUPLICATE is excluded deliberately: it records that an execution was
 * refused, never that one happened.
 *
 * Returns a Set for O(1) membership, and takes the population as a parameter
 * so one query covers a whole run.
 */
export async function findPaymentsWithCompletedActions(
  paymentIds: readonly string[],
  db: Queryable = getPool(),
): Promise<Set<string>> {
  if (paymentIds.length === 0) return new Set();
  const { rows } = await db.query<{ payment_id: string }>(
    `SELECT DISTINCT rc.payment_id
     FROM recovery_actions ra
     JOIN recovery_cases rc ON rc.id = ra.recovery_case_id
     WHERE rc.payment_id = ANY($1)
       AND ra.execution_status <> 'SKIPPED_DUPLICATE'`,
    [paymentIds],
  );
  return new Set(rows.map((row) => row.payment_id));
}

export async function findLatestCompletedAction(
  recoveryCaseId: string,
  db: Queryable = getPool(),
): Promise<RecoveryAction | null> {
  const { rows } = await db.query<ActionRow>(
    `SELECT ${ACTION_COLUMNS} FROM recovery_actions
     WHERE recovery_case_id = $1
       AND execution_status IN ('SUCCESS', 'FAILED', 'UNCONFIRMED')
     ORDER BY completed_at DESC NULLS LAST, created_at DESC
     LIMIT 1`,
    [recoveryCaseId],
  );
  return rows.length === 0 ? null : rowToAction(rows[0]!);
}
