import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { getPool } from '../db/pool.ts';

type Queryable = Pick<pg.Pool | pg.PoolClient, 'query'>;

/**
 * Audit trail writes (PRD section 15).
 *
 * Insert-only by design. There is deliberately no update or delete function in
 * this module — and the database enforces the same rule with triggers, so the
 * immutability does not depend on application discipline alone.
 */

export const AUDIT_EVENT_TYPES = [
  'PAYMENT_INGESTED',
  'RISK_ASSESSED',
  'AI_DIAGNOSIS',
  'RECOVERY_CASE_CREATED',
  'DIAGNOSIS_FAILED',
  'POLICY_EVALUATED',
  'EXECUTION_REQUESTED',
  'EXECUTION_SUCCEEDED',
  'EXECUTION_FAILED',
  'EXECUTION_UNKNOWN',
  'EXECUTION_REFUSED',
  'EXECUTION_SKIPPED_DUPLICATE',
] as const;
export type AuditEventType = (typeof AUDIT_EVENT_TYPES)[number];

export interface AuditEventInput {
  paymentId: string | null;
  caseId: string | null;
  eventType: AuditEventType;
  actor: string;
  decision: string | null;
  metadata: Record<string, unknown>;
}

export interface AuditEvent extends AuditEventInput {
  id: string;
  createdAt: Date;
}

/**
 * Append one audit event.
 *
 * Metadata is stored as JSONB. Callers must pass only non-sensitive values;
 * nothing here should contain a credential, and no caller in this phase does.
 */
export async function appendAuditEvent(
  event: AuditEventInput,
  db: Queryable = getPool(),
): Promise<string> {
  const id = `evt_${randomUUID()}`;
  await db.query(
    `INSERT INTO audit_events (id, payment_id, case_id, event_type, actor, decision, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
    [
      id,
      event.paymentId,
      event.caseId,
      event.eventType,
      event.actor,
      event.decision,
      JSON.stringify(event.metadata),
    ],
  );
  return id;
}

interface AuditRow {
  id: string;
  payment_id: string | null;
  case_id: string | null;
  event_type: string;
  actor: string;
  decision: string | null;
  metadata: Record<string, unknown>;
  created_at: Date;
}

export async function listAuditEventsForPayment(
  paymentId: string,
  db: Queryable = getPool(),
): Promise<AuditEvent[]> {
  const { rows } = await db.query<AuditRow>(
    `SELECT id, payment_id, case_id, event_type, actor, decision, metadata, created_at
     FROM audit_events WHERE payment_id = $1 ORDER BY created_at ASC, id ASC`,
    [paymentId],
  );
  return rows.map((row) => ({
    id: row.id,
    paymentId: row.payment_id,
    caseId: row.case_id,
    eventType: row.event_type as AuditEventType,
    actor: row.actor,
    decision: row.decision,
    metadata: row.metadata,
    createdAt: row.created_at,
  }));
}
