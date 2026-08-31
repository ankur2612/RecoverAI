import type pg from 'pg';
import { getPool } from '../db/pool.ts';
import type { RecoveryActionType } from '../shared/types.ts';

type Queryable = Pick<pg.Pool | pg.PoolClient, 'query'>;

/**
 * Human approval decisions.
 *
 * The critical operation is `recordDecision`: it inserts against a UNIQUE
 * index on recovery_case_id, so the DATABASE decides which of N concurrent
 * callers owns the decision. Exactly as `claimAction` does for execution, this
 * is deliberately NOT a read-then-write check — two callers can both read "no
 * decision yet" and both proceed, and only the database can arbitrate.
 *
 * A decision is IMMUTABLE. There is no update and no delete here, and the
 * unique index means a second decision cannot be inserted. Reversing a
 * decision requires a fresh case, which keeps the original recommendation and
 * its human decision intact for audit.
 */

export const APPROVAL_DECISIONS = ['APPROVED', 'REJECTED'] as const;
export type ApprovalDecision = (typeof APPROVAL_DECISIONS)[number];

export interface RecoveryApproval {
  id: string;
  recoveryCaseId: string;
  decision: ApprovalDecision;
  actor: string;
  reason: string | null;
  approvedAction: RecoveryActionType;
  policyVersion: string | null;
  createdAt: Date;
}

interface ApprovalRow {
  id: string;
  recovery_case_id: string;
  decision: string;
  actor: string;
  reason: string | null;
  approved_action: string;
  policy_version: string | null;
  created_at: Date;
}

const APPROVAL_COLUMNS = `id, recovery_case_id, decision, actor, reason,
  approved_action, policy_version, created_at`;

function rowToApproval(row: ApprovalRow): RecoveryApproval {
  return {
    id: row.id,
    recoveryCaseId: row.recovery_case_id,
    decision: row.decision as ApprovalDecision,
    actor: row.actor,
    reason: row.reason,
    approvedAction: row.approved_action as RecoveryActionType,
    policyVersion: row.policy_version,
    createdAt: row.created_at,
  };
}

export interface RecordDecisionArgs {
  id: string;
  recoveryCaseId: string;
  decision: ApprovalDecision;
  actor: string;
  reason: string | null;
  approvedAction: RecoveryActionType;
  policyVersion: string | null;
}

export interface RecordDecisionResult {
  /** True when this caller's decision was the one recorded. */
  recorded: boolean;
  /** The decision now in force — this caller's, or the one that won. */
  approval: RecoveryApproval;
}

/**
 * Atomically record one human decision for a case.
 *
 * `ON CONFLICT DO NOTHING` against the one-decision-per-case unique index
 * makes a second decision a no-op; the follow-up read returns the decision
 * that stands. Exactly one caller ever sees `recorded: true`.
 *
 * This is what makes approve/reject idempotent AND mutually exclusive: a
 * second approval, a second rejection, and a rejection after an approval all
 * take the same path and all leave the first decision untouched.
 */
export async function recordDecision(
  args: RecordDecisionArgs,
  db: Queryable = getPool(),
): Promise<RecordDecisionResult> {
  const { rows } = await db.query<ApprovalRow>(
    `INSERT INTO recovery_approvals (
       id, recovery_case_id, decision, actor, reason, approved_action, policy_version
     )
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (recovery_case_id) DO NOTHING
     RETURNING ${APPROVAL_COLUMNS}`,
    [
      args.id,
      args.recoveryCaseId,
      args.decision,
      args.actor,
      args.reason,
      args.approvedAction,
      args.policyVersion,
    ],
  );

  if (rows.length === 1) {
    return { recorded: true, approval: rowToApproval(rows[0]!) };
  }

  const existing = await findDecisionForCase(args.recoveryCaseId, db);
  if (existing === null) {
    // The conflicting row vanished between insert and select — only possible
    // if something deleted it concurrently. Fail closed rather than retrying
    // the insert, which could record a decision the operator did not make.
    throw new Error(
      `a decision for case "${args.recoveryCaseId}" conflicted but could not be read back`,
    );
  }
  return { recorded: false, approval: existing };
}

/** The decision in force for a case, or null when none has been made. */
export async function findDecisionForCase(
  recoveryCaseId: string,
  db: Queryable = getPool(),
): Promise<RecoveryApproval | null> {
  const { rows } = await db.query<ApprovalRow>(
    `SELECT ${APPROVAL_COLUMNS} FROM recovery_approvals WHERE recovery_case_id = $1`,
    [recoveryCaseId],
  );
  return rows.length === 0 ? null : rowToApproval(rows[0]!);
}

/**
 * Whether a case carries a standing APPROVED decision.
 *
 * This is the single read the execution path uses to populate
 * `humanApprovalGranted`. It answers only "did a human say yes"; whether the
 * action may run remains the policy engine's decision.
 */
export async function hasApproval(
  recoveryCaseId: string,
  db: Queryable = getPool(),
): Promise<boolean> {
  const decision = await findDecisionForCase(recoveryCaseId, db);
  return decision !== null && decision.decision === 'APPROVED';
}
