import pg from 'pg';
import { getPool } from '../db/pool.ts';

/**
 * ============================================================================
 * RECOVERY ANALYTICS
 * ============================================================================
 *
 * Answers one question from PERSISTED DOMAIN DATA:
 *
 *   "How much money was at risk, what did RecoverAI actually recover, and
 *    what happened to the rest?"
 *
 * Rules this module follows:
 *
 *   1. READ ONLY. It never executes, verifies, or contacts a provider. A
 *      metric is a report about what already happened, never a cause of it.
 *
 *   2. MONEY IS INTEGER MINOR UNITS. Every amount is a BIGINT sum in paise,
 *      aggregated in the database. No floating-point arithmetic touches an
 *      amount anywhere in this file.
 *
 *   3. RECOVERED MEANS VERIFIED. Only a verification_status of 'VERIFIED'
 *      contributes to recovered revenue. An AI recommendation, a policy
 *      approval, or a provider-accepted execution is NOT recovery — that
 *      distinction is the whole point of the verification layer, and this
 *      module must not blur it.
 *
 *   4. NO GROUND TRUTH. payment_ground_truth is evaluation-only data and is
 *      never queried here. An architecture test enforces that.
 *
 * Aggregation happens in SQL rather than by loading rows into memory, so the
 * endpoint stays constant-memory as the population grows.
 */

type Queryable = Pick<pg.Pool | pg.PoolClient, 'query'>;

export interface RecoveryMetricsFilter {
  /** Restrict to one merchant. Omitted means every merchant. */
  merchantId?: string | undefined;
}

export interface CountByKey {
  key: string;
  count: number;
}

export interface RecoveryMetrics {
  /** Recovery cases in the selected population. */
  totalCases: number;
  /** Distinct payments those cases cover. */
  totalPayments: number;
  /** Sum of revenue_at_risk across the selected cases, in minor units. */
  amountAtRisk: number;
  /**
   * Sum of amounts on actions whose verification_status is 'VERIFIED',
   * in minor units. Provider-grounded outcomes only.
   */
  amountRecovered: number;
  /** amountAtRisk - amountRecovered, in minor units. Never negative. */
  amountUnrecovered: number;
  /**
   * amountRecovered / amountAtRisk, rounded to four decimals.
   *
   * Computed in JavaScript from two integers AFTER aggregation, never by
   * summing floats. Zero when nothing was at risk, so the endpoint never
   * returns NaN.
   */
  recoveryRate: number;
  /** Recovery case counts by case status. */
  casesByStatus: CountByKey[];
  /** Recovery case counts by the action the AI recommended. */
  casesByAction: CountByKey[];
  /** Action counts by execution_status — what the provider told us. */
  actionsByExecutionStatus: CountByKey[];
  /** Action counts by verification_status — what the evidence proved. */
  actionsByVerificationStatus: CountByKey[];
  /**
   * Action counts by policy_status, showing how often authorization refused.
   * Safe to expose: these are policy outcome codes, never credentials.
   */
  actionsByPolicyStatus: CountByKey[];
}

/** A COUNT/SUM row. Cast to ::text in SQL, parsed here, so nothing overflows. */
interface AggregateRow {
  total_cases: string;
  total_payments: string;
  amount_at_risk: string;
}

interface GroupRow {
  key: string | null;
  count: string;
}

/**
 * Parse a ::text-cast integer from Postgres.
 *
 * SUM() over BIGINT returns NUMERIC, which node-postgres delivers as a string
 * regardless of the BIGINT type parser. Casting to ::text and parsing here
 * keeps that explicit, and the safe-integer assertion means a total large
 * enough to lose precision fails loudly rather than silently rounding.
 */
function parseAmount(value: string | null): number {
  if (value === null) return 0;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new RangeError(
      `Aggregate ${value} exceeds Number.MAX_SAFE_INTEGER and cannot be used as a money amount`,
    );
  }
  return parsed;
}

function toCounts(rows: GroupRow[]): CountByKey[] {
  return rows
    .filter((row): row is GroupRow & { key: string } => row.key !== null)
    .map((row) => ({ key: row.key, count: Number(row.count) }));
}

/**
 * Aggregate recovery outcomes over persisted data.
 *
 * The merchant filter reaches recovery_cases through payments, since a case
 * has no merchant column of its own.
 */
export async function getRecoveryMetrics(
  filter: RecoveryMetricsFilter = {},
  db: Queryable = getPool(),
): Promise<RecoveryMetrics> {
  const params: unknown[] = [];
  let merchantJoin = '';
  let merchantWhere = '';

  if (filter.merchantId !== undefined) {
    params.push(filter.merchantId);
    merchantJoin = 'JOIN payments p ON p.id = rc.payment_id';
    merchantWhere = `WHERE p.merchant_id = $${params.length}`;
  }

  // ---- headline totals ----------------------------------------------------
  //
  // Two separate aggregates rather than one correlated query: cases carry the
  // at-risk amount, actions carry the recovered amount, and joining them in a
  // single pass would multiply revenue_at_risk by the number of actions on a
  // case. Summing them independently keeps each figure honest.
  const { rows } = await db.query<AggregateRow>(
    `SELECT
       COUNT(*)::text                             AS total_cases,
       COUNT(DISTINCT rc.payment_id)::text        AS total_payments,
       COALESCE(SUM(rc.revenue_at_risk), 0)::text AS amount_at_risk
     FROM recovery_cases rc
     ${merchantJoin}
     ${merchantWhere}`,
    params,
  );

  // Recovered revenue reads ONLY verification_status = 'VERIFIED'. It
  // deliberately ignores execution_status: an execution the provider accepted
  // is not proof that money moved.
  const recoveredResult = await db.query<{ amount_recovered: string }>(
    `SELECT COALESCE(SUM(ra.amount), 0)::text AS amount_recovered
     FROM recovery_actions ra
     JOIN recovery_cases rc ON rc.id = ra.recovery_case_id
     ${merchantJoin}
     ${merchantWhere === '' ? "WHERE ra.verification_status = 'VERIFIED'" : `${merchantWhere} AND ra.verification_status = 'VERIFIED'`}`,
    params,
  );

  const totals = rows[0];
  const amountAtRisk = parseAmount(totals?.amount_at_risk ?? '0');
  const amountRecovered = parseAmount(recoveredResult.rows[0]?.amount_recovered ?? '0');

  // ---- breakdowns ---------------------------------------------------------
  const caseGroup = async (column: string): Promise<CountByKey[]> => {
    const result = await db.query<GroupRow>(
      `SELECT rc.${column} AS key, COUNT(*)::text AS count
       FROM recovery_cases rc
       ${merchantJoin}
       ${merchantWhere}
       GROUP BY rc.${column}
       ORDER BY rc.${column}`,
      params,
    );
    return toCounts(result.rows);
  };

  const actionGroup = async (column: string): Promise<CountByKey[]> => {
    const result = await db.query<GroupRow>(
      `SELECT ra.${column} AS key, COUNT(*)::text AS count
       FROM recovery_actions ra
       JOIN recovery_cases rc ON rc.id = ra.recovery_case_id
       ${merchantJoin}
       ${merchantWhere}
       GROUP BY ra.${column}
       ORDER BY ra.${column}`,
      params,
    );
    return toCounts(result.rows);
  };

  // Column names are literals in this file, never caller-supplied, so the
  // interpolation above cannot become an injection point.
  const [
    casesByStatus,
    casesByAction,
    actionsByExecutionStatus,
    actionsByVerificationStatus,
    actionsByPolicyStatus,
  ] = await Promise.all([
    caseGroup('status'),
    caseGroup('recommended_action'),
    actionGroup('execution_status'),
    actionGroup('verification_status'),
    actionGroup('policy_status'),
  ]);

  return {
    totalCases: Number(totals?.total_cases ?? '0'),
    totalPayments: Number(totals?.total_payments ?? '0'),
    amountAtRisk,
    amountRecovered,
    // Clamped at zero: a recovered total above the at-risk total would mean a
    // data inconsistency, and a negative "unrecovered" figure would be a
    // misleading way to report it.
    amountUnrecovered: Math.max(0, amountAtRisk - amountRecovered),
    recoveryRate:
      amountAtRisk === 0 ? 0 : Math.round((amountRecovered / amountAtRisk) * 10_000) / 10_000,
    casesByStatus,
    casesByAction,
    actionsByExecutionStatus,
    actionsByVerificationStatus,
    actionsByPolicyStatus,
  };
}
