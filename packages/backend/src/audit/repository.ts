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
  'OUTCOME_VERIFICATION_STARTED',
  'OUTCOME_VERIFIED',
  'OUTCOME_NOT_RECOVERED',
  'OUTCOME_UNCONFIRMED',
  // Human decisions. Distinct from POLICY_EVALUATED: a person deciding is not
  // the engine authorizing, and conflating them in the trail would hide which
  // of the two permitted an action.
  'APPROVAL_GRANTED',
  'APPROVAL_REJECTED',
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

export interface ListAuditFilter {
  paymentId?: string | undefined;
  caseId?: string | undefined;
  eventType?: AuditEventType | undefined;
  actor?: string | undefined;
  limit: number;
  offset: number;
}

export interface ListAuditResult {
  events: AuditEvent[];
  total: number;
}

/**
 * Paginated, filterable read over the audit trail.
 *
 * READ ONLY. This module has no update or delete by design, and the database
 * enforces the same rule with triggers, so exposing a listing cannot weaken
 * the append-only guarantee.
 *
 * Ordered NEWEST FIRST, unlike listAuditEventsForPayment: that one
 * reconstructs one payment's story in sequence, while an operator scanning the
 * whole log wants the most recent activity at the top.
 */
export async function listAuditEvents(
  filter: ListAuditFilter,
  db: Queryable = getPool(),
): Promise<ListAuditResult> {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (filter.paymentId !== undefined) {
    params.push(filter.paymentId);
    conditions.push(`payment_id = $${params.length}`);
  }
  if (filter.caseId !== undefined) {
    params.push(filter.caseId);
    conditions.push(`case_id = $${params.length}`);
  }
  if (filter.eventType !== undefined) {
    params.push(filter.eventType);
    conditions.push(`event_type = $${params.length}`);
  }
  if (filter.actor !== undefined) {
    params.push(filter.actor);
    conditions.push(`actor = $${params.length}`);
  }

  const where = conditions.length === 0 ? '' : `WHERE ${conditions.join(' AND ')}`;

  const countResult = await db.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM audit_events ${where}`,
    params,
  );
  const total = Number(countResult.rows[0]?.count ?? '0');

  params.push(filter.limit, filter.offset);
  const { rows } = await db.query<AuditRow>(
    `SELECT id, payment_id, case_id, event_type, actor, decision, metadata, created_at
     FROM audit_events ${where}
     ORDER BY created_at DESC, id DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );

  return {
    events: rows.map((row) => ({
      id: row.id,
      paymentId: row.payment_id,
      caseId: row.case_id,
      eventType: row.event_type as AuditEventType,
      actor: row.actor,
      decision: row.decision,
      metadata: row.metadata,
      createdAt: row.created_at,
    })),
    total,
  };
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
