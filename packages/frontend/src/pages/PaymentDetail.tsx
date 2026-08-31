import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import { api, ApiError } from '../api/client.ts';
import { formatDateTime, formatMoney, humanise } from '../lib/format.ts';
import {
  casePresentation,
  executionPresentation,
  isRecovered,
  latestAction,
  policyPresentation,
  verificationPresentation,
} from '../lib/status.ts';
import {
  Callout,
  EmptyState,
  ErrorState,
  Field,
  SectionCard,
  Skeleton,
  StatusBadge,
} from '../components/primitives.tsx';

/**
 * Payment detail.
 *
 * HOW THE RECOVERY CASE IS FOUND. `GET /api/payments/:id` returns the payment
 * ALONE, and `GET /api/recovery/cases` does not accept a `payment_id` filter
 * (verified: it 400s with "Unrecognized key"). The audit trail does accept
 * one, and every case-creating event records its `case_id` — so the link is
 * discovered there and the case then loaded through the existing detail
 * endpoint.
 *
 * That is two extra reads rather than a new backend endpoint. Both are
 * read-only and already exist; adding an API purely for view convenience
 * would be a larger change than the problem warrants.
 *
 * A payment with no case is the COMMON case (most payments never fail), so it
 * gets an explicit, calm empty state — never an invented case.
 */
export function PaymentDetail() {
  const { paymentId } = useParams<{ paymentId: string }>();

  const paymentQuery = useQuery({
    queryKey: ['payment', paymentId],
    queryFn: ({ signal }) => api.getPayment(paymentId!, signal),
    enabled: paymentId !== undefined,
  });

  // Step 1: find a case id, if this payment ever produced one.
  const auditQuery = useQuery({
    queryKey: ['payment-audit', paymentId],
    queryFn: ({ signal }) => api.listAudit({ payment_id: paymentId!, limit: 200 }, signal),
    enabled: paymentId !== undefined,
  });

  const caseId =
    auditQuery.data?.events.find((event) => event.case_id !== null)?.case_id ?? null;

  // Step 2: load the full case only when one actually exists.
  const caseQuery = useQuery({
    queryKey: ['case', caseId],
    queryFn: ({ signal }) => api.getCase(caseId!, signal),
    enabled: caseId !== null,
  });

  if (paymentQuery.isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-28 w-full rounded-xl" />
        <Skeleton className="h-40 w-full rounded-xl" />
      </div>
    );
  }

  if (paymentQuery.isError) {
    const apiError = paymentQuery.error instanceof ApiError ? paymentQuery.error : null;
    return (
      <ErrorState
        title={apiError?.status === 404 ? 'Payment not found' : 'Could not load this payment'}
        message={apiError?.operatorMessage ?? 'An unexpected error occurred.'}
        onRetry={() => void paymentQuery.refetch()}
      />
    );
  }

  const payment = paymentQuery.data!.payment;
  const detail = caseQuery.data;
  const action = detail === undefined ? null : latestAction(detail.actions);
  const recovered =
    detail === undefined ? false : isRecovered(detail.case.status, detail.actions);

  return (
    <div className="space-y-5">
      <Link to="/payments" className="inline-block text-[13px] text-ink-muted hover:text-ink">
        ← Back to payments
      </Link>

      {/* ---- Header ---- */}
      <div className="rounded-xl border border-line bg-surface px-5 py-4 shadow-[0_1px_2px_rgba(16,24,40,0.04)]">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-ink-subtle">
              Payment
            </p>
            <p className="tabular mt-1 text-[20px] font-semibold tracking-tight text-ink">
              {payment.payment_id}
            </p>
            <p className="mt-1 text-[12.5px] text-ink-subtle">
              Order {payment.order_id} · Customer {payment.customer_id}
            </p>
          </div>
          <div className="flex flex-col items-start gap-2 sm:items-end">
            <p className="tabular text-[22px] font-semibold text-ink">
              {formatMoney(payment.amount, payment.currency)}
            </p>
            <p className="text-[12px] text-ink-subtle">{payment.currency}</p>
          </div>
        </div>
      </div>

      {/* ---- Payment information ---- */}
      <SectionCard
        title="Payment information"
        description="As recorded when the payment event was ingested."
      >
        <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="Status">{humanise(payment.status)}</Field>
          <Field label="Merchant">{payment.merchant_id}</Field>
          <Field label="Failure reason">
            {payment.failure_reason === null ? '—' : humanise(payment.failure_reason)}
          </Field>
          <Field label="Attempts" mono>
            {payment.attempt_count}
          </Field>
          <Field label="Subscription">{payment.is_subscription ? 'Yes' : 'No'}</Field>
          <Field label="Amount (minor units)" mono>
            {payment.amount.toLocaleString('en-IN')}
          </Field>
          <Field label="Created">{formatDateTime(payment.created_at)}</Field>
          <Field label="Updated">{formatDateTime(payment.updated_at)}</Field>
        </dl>
      </SectionCard>

      {/* ---- Recovery information ---- */}
      <SectionCard
        title="Recovery"
        description="Whether RecoverAI has diagnosed and acted on this payment."
        actions={
          detail === undefined ? undefined : (
            <StatusBadge presentation={casePresentation(detail.case.status)} />
          )
        }
      >
        {auditQuery.isLoading || (caseId !== null && caseQuery.isLoading) ? (
          <Skeleton className="h-20 w-full" />
        ) : auditQuery.isError ? (
          <ErrorState
            message={
              auditQuery.error instanceof ApiError
                ? auditQuery.error.operatorMessage
                : 'Could not determine whether a recovery case exists.'
            }
            onRetry={() => void auditQuery.refetch()}
          />
        ) : caseId === null ? (
          /*
            The honest answer, not an invented case. Most payments never fail,
            so this is the ordinary outcome rather than a problem.
          */
          <EmptyState
            title="No recovery case exists for this payment."
            description="A case is created only when a payment is analyzed and found to be at risk."
          />
        ) : caseQuery.isError ? (
          <ErrorState
            message={
              caseQuery.error instanceof ApiError
                ? caseQuery.error.operatorMessage
                : 'Could not load the recovery case.'
            }
            onRetry={() => void caseQuery.refetch()}
          />
        ) : detail === undefined ? (
          <Skeleton className="h-20 w-full" />
        ) : (
          <>
            <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <Field label="Case">
                <Link
                  to={`/cases/${detail.case.id}`}
                  className="text-info hover:underline"
                >
                  {detail.case.id.slice(0, 18)}…
                </Link>
              </Field>
              <Field label="AI recommendation">
                <span className="rounded border border-info/20 bg-info-bg px-1.5 py-0.5 text-[12px] font-medium text-info">
                  {detail.case.recommended_action}
                </span>
              </Field>
              <Field label="Classification">{humanise(detail.case.classification)}</Field>
              <Field label="Revenue at risk" mono>
                {formatMoney(detail.case.revenue_at_risk, payment.currency)}
              </Field>
            </dl>

            {/*
              The three lifecycle stages that live on the action, kept
              separate. `SUCCESS` renders as "Provider accepted" — never as
              recovered money.
            */}
            <dl className="mt-4 grid gap-4 border-t border-line pt-4 sm:grid-cols-3">
              <Field label="Policy">
                <StatusBadge
                  presentation={policyPresentation(action?.policy_status ?? null)}
                  size="sm"
                />
              </Field>
              <Field label="Execution">
                <StatusBadge
                  presentation={executionPresentation(action?.execution_status ?? null)}
                  size="sm"
                />
              </Field>
              <Field label="Verification">
                <StatusBadge
                  presentation={verificationPresentation(action?.verification_status ?? null)}
                  size="sm"
                />
              </Field>
            </dl>

            {recovered && (
              <div className="mt-4">
                <Callout tone="verified" title="Recovery verified">
                  Provider evidence confirms this revenue was recovered.
                </Callout>
              </div>
            )}

            {action?.verification_status === 'UNCONFIRMED' && (
              <div className="mt-4">
                <Callout tone="attention" title="Outcome unconfirmed">
                  RecoverAI will not blindly retry an action when the provider outcome is
                  unknown.
                </Callout>
              </div>
            )}

            <p className="mt-4 text-[12.5px] text-ink-subtle">
              <Link to={`/cases/${detail.case.id}`} className="text-info hover:underline">
                View the full recovery lifecycle →
              </Link>
            </p>
          </>
        )}
      </SectionCard>
    </div>
  );
}
