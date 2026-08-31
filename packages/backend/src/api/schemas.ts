import { z } from 'zod';
import { AUDIT_EVENT_TYPES } from '../audit/repository.ts';
import {
  CURRENCIES,
  FAILURE_REASONS,
  PAYMENT_STATUSES,
  RECOVERY_ACTIONS,
  RECOVERY_CASE_STATUSES,
} from '../shared/types.ts';

/**
 * Request validation schemas.
 *
 * Every field arriving from a client is validated here before it reaches
 * business logic. Derived fields are deliberately NOT accepted from clients:
 * risk scores, classifications, recoverability, and confidence are computed by
 * the system, never supplied by a caller.
 */

/** Identifier: bounded length, conservative charset, no whitespace or quotes. */
const identifier = (label: string) =>
  z
    .string({ required_error: `${label} is required`, invalid_type_error: `${label} must be a string` })
    .trim()
    .min(1, `${label} must not be empty`)
    .max(64, `${label} must be 64 characters or fewer`)
    .regex(/^[A-Za-z0-9_-]+$/, `${label} may contain only letters, digits, underscore and hyphen`);

/**
 * Money: a positive integer in the smallest currency unit.
 *
 * Rejects floats outright rather than rounding — a fractional paise means the
 * caller has a unit bug, and silently rounding it would corrupt the ledger.
 */
const amountMinorUnits = z
  .number({ required_error: 'amount is required', invalid_type_error: 'amount must be a number' })
  .int('amount must be an integer in the smallest currency unit (paise), not a decimal')
  .positive('amount must be greater than zero')
  .max(Number.MAX_SAFE_INTEGER, 'amount exceeds the maximum safe integer');

/** ISO-8601 timestamp that must parse to a real date. */
const isoTimestamp = z
  .string()
  .datetime({ offset: true, message: 'created_at must be an ISO-8601 timestamp' })
  .refine((value) => !Number.isNaN(Date.parse(value)), {
    message: 'created_at must be a valid date',
  });

/**
 * POST /api/payments body, matching the PRD payment shape (snake_case wire
 * format, camelCase internally).
 *
 * `.strict()` rejects unknown fields so a client cannot smuggle in a
 * `risk_score`, `classification`, or `ground_truth` value.
 */
export const createPaymentSchema = z
  .object({
    payment_id: identifier('payment_id'),
    order_id: identifier('order_id'),
    customer_id: identifier('customer_id'),
    merchant_id: identifier('merchant_id'),
    amount: amountMinorUnits,
    currency: z.enum(CURRENCIES, {
      errorMap: () => ({ message: `currency must be one of ${CURRENCIES.join(', ')}` }),
    }),
    status: z.enum(PAYMENT_STATUSES, {
      errorMap: () => ({ message: `status must be one of ${PAYMENT_STATUSES.join(', ')}` }),
    }),
    failure_reason: z
      .enum(FAILURE_REASONS, {
        errorMap: () => ({ message: `failure_reason must be one of ${FAILURE_REASONS.join(', ')}` }),
      })
      .nullish(),
    attempt_count: z.number().int().min(0).max(100).optional().default(0),
    is_subscription: z.boolean().optional().default(false),
    created_at: isoTimestamp.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    // A failed payment with no reason is not actionable, and a captured
    // payment with a failure reason is contradictory. Reject both rather than
    // storing incoherent data.
    const isFailure = value.status === 'failed' || value.status === 'abandoned';
    if (isFailure && (value.failure_reason === null || value.failure_reason === undefined)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['failure_reason'],
        message: `failure_reason is required when status is "${value.status}"`,
      });
    }
    if (value.status === 'captured' && value.failure_reason) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['failure_reason'],
        message: 'failure_reason must not be set when status is "captured"',
      });
    }
  });

export type CreatePaymentBody = z.infer<typeof createPaymentSchema>;

/** GET /api/payments query parameters. */
export const listPaymentsQuerySchema = z
  .object({
    merchant_id: identifier('merchant_id').optional(),
    customer_id: identifier('customer_id').optional(),
    status: z.enum(PAYMENT_STATUSES).optional(),
    limit: z.coerce.number().int().min(1).max(200).optional().default(50),
    offset: z.coerce.number().int().min(0).optional().default(0),
  })
  .strict();

/** GET /api/recovery/cases query parameters. */
export const listCasesQuerySchema = z
  .object({
    status: z.enum(RECOVERY_CASE_STATUSES).optional(),
    limit: z.coerce.number().int().min(1).max(200).optional().default(50),
    offset: z.coerce.number().int().min(0).optional().default(0),
  })
  .strict();

/**
 * POST /api/recovery/analyze body.
 *
 * Accepts a payment id to analyze. It does NOT accept a classification,
 * confidence, or recommended action — those are outputs of the system, and
 * letting a client supply them would let a caller bypass detection entirely.
 */
export const analyzeRequestSchema = z
  .object({
    payment_id: identifier('payment_id'),
  })
  .strict();

/**
 * POST /api/recovery/runs
 *
 * Every field is optional: an empty body runs the default population. `execute`
 * defaults to true, so a caller must opt OUT of acting rather than opt in —
 * consistent with the endpoint's name. `.strict()` rejects unknown keys so a
 * typo like "dry_run" fails loudly instead of silently executing.
 */
export const batchRunRequestSchema = z
  .object({
    merchant_id: identifier('merchant_id').optional(),
    statuses: z
      .array(
        z.enum(PAYMENT_STATUSES, {
          errorMap: () => ({ message: `statuses must contain only ${PAYMENT_STATUSES.join(', ')}` }),
        }),
      )
      .min(1, 'statuses must not be empty')
      .optional(),
    limit: z
      .number({ invalid_type_error: 'limit must be a number' })
      .int('limit must be an integer')
      .min(1, 'limit must be at least 1')
      .max(1000, 'limit must be 1000 or fewer')
      .optional(),
    execute: z.boolean({ invalid_type_error: 'execute must be a boolean' }).optional(),
  })
  .strict();

/**
 * POST /api/recovery/sweep
 *
 * Both fields optional. `.strict()` rejects unknown keys so a typo cannot
 * silently widen the sweep. There is deliberately NO "retry" or "force" field:
 * the sweeper resolves by observation and has no execution path to enable.
 */
export const sweepRequestSchema = z
  .object({
    min_age_seconds: z
      .number({ invalid_type_error: 'min_age_seconds must be a number' })
      .int('min_age_seconds must be an integer')
      .min(0, 'min_age_seconds must not be negative')
      .max(86_400, 'min_age_seconds must be 86400 or fewer')
      .optional(),
    limit: z
      .number({ invalid_type_error: 'limit must be a number' })
      .int('limit must be an integer')
      .min(1, 'limit must be at least 1')
      .max(1000, 'limit must be 1000 or fewer')
      .optional(),
  })
  .strict();

/**
 * POST /api/recovery/:caseId/approve  and  /reject
 *
 * Deliberately MINIMAL. The client may supply a justification and, optionally,
 * the action it believes it is deciding on. It may NOT supply:
 *
 *   - an amount            (would let a caller restate the money at stake)
 *   - an arbitrary action  (would let an approval apply to a different action)
 *   - authorized: true     (authorization is the policy engine's, never a
 *                           client's, and no field here can grant it)
 *   - force / override     (there is no bypass to enable)
 *
 * `.strict()` rejects unknown keys, so any of the above fails loudly rather
 * than being silently ignored.
 */
export const approvalDecisionSchema = z
  .object({
    reason: z
      .string({ invalid_type_error: 'reason must be a string' })
      .trim()
      .min(1, 'reason must not be empty when supplied')
      .max(500, 'reason must be 500 characters or fewer')
      .optional(),
    // Echoed back for confirmation, never used to CHOOSE the action.
    expected_action: z
      .enum(RECOVERY_ACTIONS, {
        errorMap: () => ({ message: `expected_action must be one of ${RECOVERY_ACTIONS.join(', ')}` }),
      })
      .optional(),
  })
  .strict();

/**
 * GET /api/audit query parameters.
 *
 * Read-only and strictly bounded. `limit` is capped so a single call cannot
 * pull the whole trail, and every filter is an exact match on an indexed or
 * low-cardinality column — there is no free-text search that could become an
 * expensive scan.
 */
export const listAuditQuerySchema = z
  .object({
    payment_id: identifier('payment_id').optional(),
    case_id: identifier('case_id').optional(),
    event_type: z
      .enum(AUDIT_EVENT_TYPES, {
        errorMap: () => ({ message: `event_type must be one of ${AUDIT_EVENT_TYPES.join(', ')}` }),
      })
      .optional(),
    actor: z
      .string()
      .trim()
      .min(1)
      .max(64)
      .regex(/^[A-Za-z0-9:_-]+$/, 'actor may contain only letters, digits, colon, underscore, hyphen')
      .optional(),
    limit: z.coerce.number().int().min(1).max(200).optional().default(50),
    offset: z.coerce.number().int().min(0).optional().default(0),
  })
  .strict();

/** GET /api/analytics/recovery — read-only, so the only filter is merchant. */
export const analyticsQuerySchema = z
  .object({
    merchant_id: identifier('merchant_id').optional(),
  })
  .strict();

/** Flatten a ZodError into a stable, client-safe shape. */
export function formatZodIssues(error: z.ZodError): { field: string; message: string }[] {
  return error.issues.map((issue) => ({
    field: issue.path.join('.') || '(body)',
    message: issue.message,
  }));
}
