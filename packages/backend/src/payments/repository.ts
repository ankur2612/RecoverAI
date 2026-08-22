import type pg from 'pg';
import { getPool } from '../db/pool.ts';
import type { Currency, FailureReason, Payment, PaymentStatus } from '../shared/types.ts';
import { EMPTY_CUSTOMER_HISTORY, type CustomerHistory } from '../risk/types.ts';

/**
 * Payment persistence and retrieval.
 *
 * All SQL here is parameterised. No value is ever interpolated into a query
 * string, including values that look safe such as limits and sort directions —
 * those are validated against allow-lists instead.
 */

type Queryable = Pick<pg.Pool | pg.PoolClient, 'query'>;

/** Shape of a payments row as returned by Postgres. */
interface PaymentRow {
  id: string;
  merchant_id: string;
  customer_id: string;
  order_id: string;
  amount: number;
  currency: string;
  status: string;
  failure_reason: string | null;
  attempt_count: number;
  is_subscription: boolean;
  created_at: Date;
  updated_at: Date;
}

function rowToPayment(row: PaymentRow): Payment {
  return {
    id: row.id,
    merchantId: row.merchant_id,
    customerId: row.customer_id,
    orderId: row.order_id,
    amount: row.amount,
    currency: row.currency as Currency,
    status: row.status as PaymentStatus,
    failureReason: row.failure_reason as FailureReason | null,
    attemptCount: row.attempt_count,
    isSubscription: row.is_subscription,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const PAYMENT_COLUMNS = `id, merchant_id, customer_id, order_id, amount, currency,
  status, failure_reason, attempt_count, is_subscription, created_at, updated_at`;

export interface InsertPaymentArgs {
  id: string;
  merchantId: string;
  customerId: string;
  orderId: string;
  amount: number;
  currency: Currency;
  status: PaymentStatus;
  failureReason: FailureReason | null;
  attemptCount: number;
  isSubscription: boolean;
  createdAt: Date;
}

export class DuplicatePaymentError extends Error {
  override name = 'DuplicatePaymentError';
  // Written as an explicit field rather than a constructor parameter property:
  // Node's type-stripping loader does not support parameter properties.
  readonly paymentId: string;

  constructor(paymentId: string) {
    super(`Payment ${paymentId} already exists`);
    this.paymentId = paymentId;
  }
}

export class MissingReferenceError extends Error {
  override name = 'MissingReferenceError';
}

/**
 * Insert one payment.
 *
 * Rejects a duplicate id rather than upserting: silently overwriting a stored
 * payment would let a later ingest rewrite financial history. The synthetic
 * dataset loader has its own explicit upsert path for re-seeding; this one is
 * for genuine ingestion.
 */
export async function insertPayment(
  args: InsertPaymentArgs,
  db: Queryable = getPool(),
): Promise<Payment> {
  try {
    const { rows } = await db.query<PaymentRow>(
      `INSERT INTO payments (
         id, merchant_id, customer_id, order_id, amount, currency,
         status, failure_reason, attempt_count, is_subscription,
         created_at, updated_at
       )
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11)
       RETURNING ${PAYMENT_COLUMNS}`,
      [
        args.id,
        args.merchantId,
        args.customerId,
        args.orderId,
        args.amount,
        args.currency,
        args.status,
        args.failureReason,
        args.attemptCount,
        args.isSubscription,
        args.createdAt,
      ],
    );
    return rowToPayment(rows[0]!);
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === '23505') throw new DuplicatePaymentError(args.id);
    if (code === '23503') {
      throw new MissingReferenceError(
        `merchant "${args.merchantId}" or customer "${args.customerId}" does not exist`,
      );
    }
    throw error;
  }
}

export async function findPaymentById(
  id: string,
  db: Queryable = getPool(),
): Promise<Payment | null> {
  const { rows } = await db.query<PaymentRow>(
    `SELECT ${PAYMENT_COLUMNS} FROM payments WHERE id = $1`,
    [id],
  );
  return rows.length === 0 ? null : rowToPayment(rows[0]!);
}

export interface ListPaymentsFilter {
  merchantId?: string | undefined;
  customerId?: string | undefined;
  status?: PaymentStatus | undefined;
  limit: number;
  offset: number;
}

export interface ListPaymentsResult {
  payments: Payment[];
  total: number;
}

/**
 * List payments with optional filters.
 *
 * Filters are appended as numbered parameters; `limit` and `offset` are
 * likewise parameterised and are validated by the API layer before arriving.
 */
export async function listPayments(
  filter: ListPaymentsFilter,
  db: Queryable = getPool(),
): Promise<ListPaymentsResult> {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (filter.merchantId !== undefined) {
    params.push(filter.merchantId);
    conditions.push(`merchant_id = $${params.length}`);
  }
  if (filter.customerId !== undefined) {
    params.push(filter.customerId);
    conditions.push(`customer_id = $${params.length}`);
  }
  if (filter.status !== undefined) {
    params.push(filter.status);
    conditions.push(`status = $${params.length}`);
  }

  const where = conditions.length === 0 ? '' : `WHERE ${conditions.join(' AND ')}`;

  const countResult = await db.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM payments ${where}`,
    params,
  );
  const total = Number(countResult.rows[0]?.count ?? '0');

  params.push(filter.limit, filter.offset);
  const { rows } = await db.query<PaymentRow>(
    `SELECT ${PAYMENT_COLUMNS} FROM payments ${where}
     ORDER BY created_at DESC, id DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );

  return { payments: rows.map(rowToPayment), total };
}

/**
 * Derive a customer's payment history from stored payments.
 *
 * Deliberately reads the payments table ONLY. It never touches
 * payment_ground_truth — that table is evaluation-only and must not influence
 * a diagnosis.
 *
 * `excludePaymentId` omits the payment being diagnosed, so a payment is never
 * counted as part of its own history.
 */
export async function getCustomerHistory(
  customerId: string,
  excludePaymentId: string | null = null,
  db: Queryable = getPool(),
): Promise<CustomerHistory> {
  const { rows } = await db.query<{
    total: string;
    successful: string;
    failed: string;
    lifetime_value: string | null;
  }>(
    `SELECT
       COUNT(*)::text AS total,
       COUNT(*) FILTER (WHERE status = 'captured')::text AS successful,
       COUNT(*) FILTER (WHERE status IN ('failed', 'abandoned'))::text AS failed,
       COALESCE(SUM(amount) FILTER (WHERE status = 'captured'), 0)::text AS lifetime_value
     FROM payments
     WHERE customer_id = $1
       AND ($2::text IS NULL OR id <> $2)`,
    [customerId, excludePaymentId],
  );

  const row = rows[0];
  if (row === undefined) return EMPTY_CUSTOMER_HISTORY;

  const total = Number(row.total);
  const successful = Number(row.successful);
  const failed = Number(row.failed);

  return {
    totalPayments: total,
    successfulPayments: successful,
    failedPayments: failed,
    successRate: total === 0 ? null : Number((successful / total).toFixed(4)),
    lifetimeValue: Number(row.lifetime_value ?? '0'),
  };
}
