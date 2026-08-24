import type pg from 'pg';
import { getPool } from '../db/pool.ts';
import type {
  Classification,
  MinorUnits,
  RecoveryActionType,
  RecoveryCaseStatus,
} from '../shared/types.ts';

type Queryable = Pick<pg.Pool | pg.PoolClient, 'query'>;

/**
 * Recovery case persistence.
 *
 * A recovery case records that a payment was ANALYZED. That is deliberately
 * distinct from authorized, executed, or recovered (PRD section 11):
 *
 *   OPEN       analysis complete, nothing authorized, nothing executed
 *   ESCALATED  analysis says a human must decide
 *
 * This phase writes only those two statuses. AUTHORIZED and EXECUTED do not
 * appear here because no policy engine and no executor exist yet — creating
 * them now would blur exactly the distinction the architecture depends on.
 */

export interface RecoveryCase {
  id: string;
  paymentId: string;
  riskScore: number;
  recoverabilityScore: number;
  classification: Classification;
  recommendedAction: RecoveryActionType;
  confidence: number;
  revenueAtRisk: MinorUnits;
  reason: string;
  status: RecoveryCaseStatus;
  createdAt: Date;
  updatedAt: Date;
}

interface RecoveryCaseRow {
  id: string;
  payment_id: string;
  risk_score: number;
  recoverability_score: number;
  classification: string;
  recommended_action: string;
  confidence: number;
  revenue_at_risk: number;
  reason: string;
  status: string;
  created_at: Date;
  updated_at: Date;
}

const CASE_COLUMNS = `id, payment_id, risk_score, recoverability_score, classification,
  recommended_action, confidence, revenue_at_risk, reason, status, created_at, updated_at`;

function rowToCase(row: RecoveryCaseRow): RecoveryCase {
  return {
    id: row.id,
    paymentId: row.payment_id,
    riskScore: row.risk_score,
    recoverabilityScore: row.recoverability_score,
    classification: row.classification as Classification,
    recommendedAction: row.recommended_action as RecoveryActionType,
    confidence: row.confidence,
    revenueAtRisk: row.revenue_at_risk,
    reason: row.reason,
    status: row.status as RecoveryCaseStatus,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface InsertRecoveryCaseArgs {
  id: string;
  paymentId: string;
  riskScore: number;
  recoverabilityScore: number;
  classification: Classification;
  recommendedAction: RecoveryActionType;
  confidence: number;
  revenueAtRisk: MinorUnits;
  reason: string;
  /** Only analysis-stage statuses are valid in this phase. */
  status: Extract<RecoveryCaseStatus, 'OPEN' | 'ESCALATED' | 'AWAITING_APPROVAL'>;
}

export class DuplicateOpenCaseError extends Error {
  override name = 'DuplicateOpenCaseError';
  // Explicit field: parameter properties are unsupported by Node's
  // type-stripping loader.
  readonly paymentId: string;

  constructor(paymentId: string) {
    super(`Payment ${paymentId} already has a live recovery case`);
    this.paymentId = paymentId;
  }
}

/**
 * Insert a recovery case.
 *
 * The database enforces one live case per payment via a partial unique index.
 * A violation surfaces as DuplicateOpenCaseError rather than a raw pg error,
 * so the API layer can return a clean 409 instead of a 500.
 */
export async function insertRecoveryCase(
  args: InsertRecoveryCaseArgs,
  db: Queryable = getPool(),
): Promise<RecoveryCase> {
  try {
    const { rows } = await db.query<RecoveryCaseRow>(
      `INSERT INTO recovery_cases (
         id, payment_id, risk_score, recoverability_score, classification,
         recommended_action, confidence, revenue_at_risk, reason, status
       )
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       RETURNING ${CASE_COLUMNS}`,
      [
        args.id,
        args.paymentId,
        args.riskScore,
        args.recoverabilityScore,
        args.classification,
        args.recommendedAction,
        args.confidence,
        args.revenueAtRisk,
        args.reason,
        args.status,
      ],
    );
    return rowToCase(rows[0]!);
  } catch (error) {
    if ((error as { code?: string }).code === '23505') {
      throw new DuplicateOpenCaseError(args.paymentId);
    }
    throw error;
  }
}

export async function findLiveCaseForPayment(
  paymentId: string,
  db: Queryable = getPool(),
): Promise<RecoveryCase | null> {
  const { rows } = await db.query<RecoveryCaseRow>(
    `SELECT ${CASE_COLUMNS} FROM recovery_cases
     WHERE payment_id = $1 AND status IN ('OPEN', 'AWAITING_APPROVAL', 'EXECUTING')
     LIMIT 1`,
    [paymentId],
  );
  return rows.length === 0 ? null : rowToCase(rows[0]!);
}

export async function findCaseById(
  id: string,
  db: Queryable = getPool(),
): Promise<RecoveryCase | null> {
  const { rows } = await db.query<RecoveryCaseRow>(
    `SELECT ${CASE_COLUMNS} FROM recovery_cases WHERE id = $1`,
    [id],
  );
  return rows.length === 0 ? null : rowToCase(rows[0]!);
}

export interface ListCasesFilter {
  status?: RecoveryCaseStatus | undefined;
  limit: number;
  offset: number;
}

export async function listRecoveryCases(
  filter: ListCasesFilter,
  db: Queryable = getPool(),
): Promise<{ cases: RecoveryCase[]; total: number }> {
  const params: unknown[] = [];
  let where = '';
  if (filter.status !== undefined) {
    params.push(filter.status);
    where = `WHERE status = $${params.length}`;
  }

  const countResult = await db.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM recovery_cases ${where}`,
    params,
  );

  params.push(filter.limit, filter.offset);
  const { rows } = await db.query<RecoveryCaseRow>(
    `SELECT ${CASE_COLUMNS} FROM recovery_cases ${where}
     ORDER BY created_at DESC, id DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );

  return { cases: rows.map(rowToCase), total: Number(countResult.rows[0]?.count ?? '0') };
}

/**
 * Move a recovery case to a new lifecycle status.
 *
 * Used by verification to reflect the established outcome. RECOVERED is set
 * here ONLY when verification produced VERIFIED evidence — never from a
 * provider acknowledgement and never from AI confidence.
 */
export async function updateCaseStatus(
  id: string,
  status: RecoveryCaseStatus,
  db: Queryable = getPool(),
): Promise<RecoveryCase | null> {
  const { rows } = await db.query<RecoveryCaseRow>(
    `UPDATE recovery_cases SET status = $2, updated_at = now()
     WHERE id = $1
     RETURNING ${CASE_COLUMNS}`,
    [id, status],
  );
  return rows.length === 0 ? null : rowToCase(rows[0]!);
}
