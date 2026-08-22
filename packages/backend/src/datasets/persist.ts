import { withTransaction } from '../db/pool.ts';
import type { SyntheticDataset } from '../shared/types.ts';

export interface PersistCounts {
  merchants: number;
  customers: number;
  payments: number;
  groundTruth: number;
}

/** Insert rows in chunks so a large dataset does not exceed parameter limits. */
const CHUNK_SIZE = 500;

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Build a multi-row VALUES clause: ($1,$2), ($3,$4), ...
 * Parameterised throughout — no value is ever interpolated into SQL text.
 */
function valuesClause(rowCount: number, columnCount: number): string {
  const rows: string[] = [];
  for (let r = 0; r < rowCount; r++) {
    const params: string[] = [];
    for (let c = 1; c <= columnCount; c++) params.push(`$${r * columnCount + c}`);
    rows.push(`(${params.join(', ')})`);
  }
  return rows.join(', ');
}

/**
 * Persist a generated dataset into PostgreSQL.
 *
 * Idempotent: re-running with the same seed produces the same ids and upserts
 * rather than duplicating. The whole load runs in one transaction, so a
 * failure part-way leaves the database untouched rather than half-seeded.
 *
 * Ground-truth labels go into their own table and are never written onto the
 * payments row — they must stay unavailable to the diagnosis path.
 */
export async function persistDataset(dataset: SyntheticDataset): Promise<PersistCounts> {
  return withTransaction(async (client) => {
    for (const group of chunk(dataset.merchants, CHUNK_SIZE)) {
      const params = group.flatMap((m) => [m.id, m.name, m.currency, m.createdAt]);
      await client.query(
        `INSERT INTO merchants (id, name, currency, created_at)
         VALUES ${valuesClause(group.length, 4)}
         ON CONFLICT (id) DO UPDATE
           SET name = EXCLUDED.name, currency = EXCLUDED.currency`,
        params,
      );
    }

    for (const group of chunk(dataset.customers, CHUNK_SIZE)) {
      const params = group.flatMap((c) => [c.id, c.merchantId, c.name, c.email, c.createdAt]);
      await client.query(
        `INSERT INTO customers (id, merchant_id, name, email, created_at)
         VALUES ${valuesClause(group.length, 5)}
         ON CONFLICT (id) DO UPDATE
           SET name = EXCLUDED.name, email = EXCLUDED.email`,
        params,
      );
    }

    const payments = dataset.records.map((r) => r.payment);
    for (const group of chunk(payments, CHUNK_SIZE)) {
      const params = group.flatMap((p) => [
        p.id,
        p.merchantId,
        p.customerId,
        p.orderId,
        p.amount,
        p.currency,
        p.status,
        p.failureReason,
        p.attemptCount,
        p.isSubscription,
        p.createdAt,
        p.updatedAt,
      ]);
      await client.query(
        `INSERT INTO payments (
           id, merchant_id, customer_id, order_id, amount, currency,
           status, failure_reason, attempt_count, is_subscription,
           created_at, updated_at
         )
         VALUES ${valuesClause(group.length, 12)}
         ON CONFLICT (id) DO UPDATE
           SET status = EXCLUDED.status,
               failure_reason = EXCLUDED.failure_reason,
               attempt_count = EXCLUDED.attempt_count,
               updated_at = EXCLUDED.updated_at`,
        params,
      );
    }

    for (const group of chunk(dataset.records, CHUNK_SIZE)) {
      const params = group.flatMap((r) => [
        r.payment.id,
        r.groundTruth.classification,
        r.groundTruth.recoverable,
        r.groundTruth.recoveryProbability,
        r.groundTruth.idealAction,
        r.split,
      ]);
      await client.query(
        `INSERT INTO payment_ground_truth (
           payment_id, classification, recoverable,
           recovery_probability, ideal_action, split
         )
         VALUES ${valuesClause(group.length, 6)}
         ON CONFLICT (payment_id) DO UPDATE
           SET classification = EXCLUDED.classification,
               recoverable = EXCLUDED.recoverable,
               recovery_probability = EXCLUDED.recovery_probability,
               ideal_action = EXCLUDED.ideal_action,
               split = EXCLUDED.split`,
        params,
      );
    }

    return {
      merchants: dataset.merchants.length,
      customers: dataset.customers.length,
      payments: payments.length,
      groundTruth: dataset.records.length,
    };
  });
}
