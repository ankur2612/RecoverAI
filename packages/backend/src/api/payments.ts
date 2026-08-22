import type { FastifyInstance } from 'fastify';
import type { Payment } from '../shared/types.ts';
import {
  DuplicatePaymentError,
  MissingReferenceError,
  insertPayment,
  listPayments,
  findPaymentById,
} from '../payments/repository.ts';
import { createPaymentSchema, listPaymentsQuerySchema, formatZodIssues } from './schemas.ts';
import { appendAuditEvent } from '../audit/repository.ts';

/** Serialise a payment to the PRD's snake_case wire format. */
export function serialisePayment(payment: Payment) {
  return {
    payment_id: payment.id,
    order_id: payment.orderId,
    customer_id: payment.customerId,
    merchant_id: payment.merchantId,
    amount: payment.amount,
    currency: payment.currency,
    status: payment.status,
    failure_reason: payment.failureReason,
    attempt_count: payment.attemptCount,
    is_subscription: payment.isSubscription,
    created_at: payment.createdAt.toISOString(),
    updated_at: payment.updatedAt.toISOString(),
  };
}

export async function registerPaymentRoutes(app: FastifyInstance): Promise<void> {
  /**
   * POST /api/payments — ingest one payment event.
   *
   * Ingestion stores an observation. It performs no analysis, creates no
   * recovery case, and never contacts a payment provider.
   */
  app.post('/api/payments', async (request, reply) => {
    const parsed = createPaymentSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'validation_error',
        message: 'The payment payload is invalid.',
        issues: formatZodIssues(parsed.error),
      });
    }

    const body = parsed.data;

    try {
      const payment = await insertPayment({
        id: body.payment_id,
        merchantId: body.merchant_id,
        customerId: body.customer_id,
        orderId: body.order_id,
        amount: body.amount,
        currency: body.currency,
        status: body.status,
        failureReason: body.failure_reason ?? null,
        attemptCount: body.attempt_count,
        isSubscription: body.is_subscription,
        createdAt: body.created_at === undefined ? new Date() : new Date(body.created_at),
      });

      await appendAuditEvent({
        paymentId: payment.id,
        caseId: null,
        eventType: 'PAYMENT_INGESTED',
        actor: 'api',
        decision: null,
        metadata: { status: payment.status, amount: payment.amount },
      });

      return reply.code(201).send({ payment: serialisePayment(payment) });
    } catch (error) {
      if (error instanceof DuplicatePaymentError) {
        return reply.code(409).send({
          error: 'duplicate_payment',
          message: `Payment ${error.paymentId} already exists.`,
        });
      }
      if (error instanceof MissingReferenceError) {
        return reply.code(422).send({
          error: 'missing_reference',
          message: error.message,
        });
      }
      // Anything else propagates to the app error handler, which returns a
      // generic 500 and keeps the detail in the logs.
      throw error;
    }
  });

  /** GET /api/payments — list payments with optional filters. */
  app.get('/api/payments', async (request, reply) => {
    const parsed = listPaymentsQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'validation_error',
        message: 'The query parameters are invalid.',
        issues: formatZodIssues(parsed.error),
      });
    }

    const { merchant_id, customer_id, status, limit, offset } = parsed.data;
    const result = await listPayments({
      merchantId: merchant_id,
      customerId: customer_id,
      status,
      limit,
      offset,
    });

    return reply.send({
      payments: result.payments.map(serialisePayment),
      pagination: { total: result.total, limit, offset },
    });
  });

  /** GET /api/payments/:paymentId — fetch one payment. */
  app.get<{ Params: { paymentId: string } }>('/api/payments/:paymentId', async (request, reply) => {
    const payment = await findPaymentById(request.params.paymentId);
    if (payment === null) {
      return reply.code(404).send({
        error: 'not_found',
        message: `Payment ${request.params.paymentId} was not found.`,
      });
    }
    return reply.send({ payment: serialisePayment(payment) });
  });
}
