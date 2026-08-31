import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api, ApiError } from '../api/client.ts';
import { formatAge, formatMoney, humanise } from '../lib/format.ts';
import {
  Button,
  EmptyState,
  ErrorState,
  SectionCard,
  StatusBadge,
  TableSkeleton,
} from '../components/primitives.tsx';
import type { PaymentStatus } from '../types/domain.ts';
import type { StatusPresentation } from '../lib/status.ts';

/**
 * The payments table.
 *
 * FILTERS MIRROR THE BACKEND EXACTLY. GET /api/payments accepts
 * `merchant_id`, `customer_id`, `status`, `limit`, and `offset` — nothing
 * else. There is no free-text search, so none is offered: a search box
 * filtering one page client-side would silently misrepresent a 1,000-row
 * dataset as whatever happened to be on screen.
 */

const STATUS_OPTIONS: (PaymentStatus | 'ALL')[] = [
  'ALL',
  'created',
  'authorized',
  'captured',
  'failed',
  'refunded',
  'abandoned',
];

const PAGE_SIZE = 25;

/**
 * Payment status presentation.
 *
 * `captured` is the only green: it is the one state where money is
 * definitively collected. A failed or abandoned payment is the product's
 * subject matter, not an error, so both read as attention rather than danger.
 */
function paymentPresentation(status: PaymentStatus): StatusPresentation {
  switch (status) {
    case 'captured':
      return { label: 'Captured', tone: 'verified', icon: '✓' };
    case 'failed':
      return { label: 'Failed', tone: 'danger', icon: '✕' };
    case 'abandoned':
      return { label: 'Abandoned', tone: 'attention', icon: '◌' };
    case 'authorized':
      return { label: 'Authorized', tone: 'info', icon: '◑' };
    case 'refunded':
      return { label: 'Refunded', tone: 'neutral', icon: '↩' };
    case 'created':
      return { label: 'Created', tone: 'neutral', icon: '○' };
    default:
      return { label: humanise(status), tone: 'neutral', icon: '○' };
  }
}

export function Payments() {
  const [status, setStatus] = useState<PaymentStatus | 'ALL'>('ALL');
  const [merchantId, setMerchantId] = useState('');
  const [offset, setOffset] = useState(0);

  const query = useQuery({
    queryKey: ['payments', { status, merchantId, offset }],
    queryFn: ({ signal }) =>
      api.listPayments(
        {
          ...(status === 'ALL' ? {} : { status }),
          ...(merchantId.trim() === '' ? {} : { merchant_id: merchantId.trim() }),
          limit: PAGE_SIZE,
          offset,
        },
        signal,
      ),
  });

  const payments = query.data?.payments ?? [];

  /**
   * The authoritative count is the API's own `pagination.total`, never
   * `payments.length` — that reports the size of the current PAGE and would
   * show "25 payments" for a dataset of 1,000.
   *
   * `null` means the count is not known (loading, failed, or a malformed
   * envelope). Rendering 0 in those states asserts something the UI cannot
   * know, so the label is suppressed instead.
   */
  const total: number | null =
    query.isLoading || query.isError ? null : (query.data?.pagination?.total ?? null);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <label
              htmlFor="payment-status"
              className="block text-[11px] font-medium uppercase tracking-wide text-ink-subtle"
            >
              Status
            </label>
            <select
              id="payment-status"
              value={status}
              onChange={(event) => {
                setStatus(event.target.value as PaymentStatus | 'ALL');
                setOffset(0);
              }}
              className="mt-1 rounded-lg border border-line-strong bg-surface px-3 py-1.5 text-[13px] text-ink"
            >
              {STATUS_OPTIONS.map((option) => (
                <option key={option} value={option}>
                  {option === 'ALL' ? 'All statuses' : humanise(option)}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label
              htmlFor="payment-merchant"
              className="block text-[11px] font-medium uppercase tracking-wide text-ink-subtle"
            >
              Merchant
            </label>
            <input
              id="payment-merchant"
              type="text"
              value={merchantId}
              placeholder="merchant_001"
              onChange={(event) => {
                setMerchantId(event.target.value);
                setOffset(0);
              }}
              className="mt-1 w-40 rounded-lg border border-line-strong bg-surface px-3 py-1.5 text-[13px] text-ink placeholder:text-ink-subtle/60"
            />
          </div>
        </div>

        <div className="flex items-center gap-3">
          <p className="tabular text-[12.5px] text-ink-subtle" aria-live="polite">
            {query.isLoading
              ? 'Loading…'
              : total === null
                ? 'Count unavailable'
                : `${total.toLocaleString('en-IN')} payment${total === 1 ? '' : 's'}`}
          </p>
          <Button onClick={() => void query.refetch()} size="sm">
            Refresh
          </Button>
        </div>
      </div>

      <SectionCard>
        {query.isLoading ? (
          <TableSkeleton rows={8} columns={6} />
        ) : query.isError ? (
          <ErrorState
            title="Could not load payments"
            message={
              query.error instanceof ApiError
                ? query.error.operatorMessage
                : 'An unexpected error occurred.'
            }
            onRetry={() => void query.refetch()}
          />
        ) : payments.length === 0 ? (
          <EmptyState
            title="No payments match these filters"
            description={
              status === 'ALL' && merchantId === ''
                ? 'Payments appear once they have been ingested through the API.'
                : 'Try a different status or merchant.'
            }
          />
        ) : (
          <>
            <div className="-mx-5 overflow-x-auto">
              <table className="w-full min-w-[820px] text-left">
                <caption className="sr-only">
                  Ingested payments with their current status
                </caption>
                <thead>
                  <tr className="border-b border-line text-[11px] uppercase tracking-wide text-ink-subtle">
                    <th scope="col" className="px-5 py-2.5 font-medium">Payment</th>
                    <th scope="col" className="px-5 py-2.5 font-medium">Amount</th>
                    <th scope="col" className="px-5 py-2.5 font-medium">Currency</th>
                    <th scope="col" className="px-5 py-2.5 font-medium">Status</th>
                    <th scope="col" className="px-5 py-2.5 font-medium">Failure reason</th>
                    <th scope="col" className="px-5 py-2.5 font-medium">Attempts</th>
                    <th scope="col" className="px-5 py-2.5 font-medium">Created</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {payments.map((payment) => (
                    <tr key={payment.payment_id} className="transition hover:bg-canvas">
                      <td className="px-5 py-3">
                        <Link
                          to={`/payments/${payment.payment_id}`}
                          className="tabular text-[13px] font-medium text-ink hover:text-info hover:underline"
                        >
                          {payment.payment_id}
                        </Link>
                      </td>
                      <td className="tabular px-5 py-3 text-[13px] font-medium text-ink">
                        {formatMoney(payment.amount, payment.currency)}
                      </td>
                      <td className="px-5 py-3 text-[13px] text-ink-muted">{payment.currency}</td>
                      <td className="px-5 py-3">
                        <StatusBadge presentation={paymentPresentation(payment.status)} size="sm" />
                      </td>
                      <td className="px-5 py-3 text-[13px] text-ink-muted">
                        {payment.failure_reason === null
                          ? '—'
                          : humanise(payment.failure_reason)}
                      </td>
                      <td className="tabular px-5 py-3 text-[13px] text-ink-muted">
                        {payment.attempt_count}
                      </td>
                      <td className="px-5 py-3 text-[12.5px] text-ink-subtle">
                        {formatAge(payment.created_at)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {total !== null && total > PAGE_SIZE && (
              <nav
                aria-label="Pagination"
                className="mt-4 flex items-center justify-between border-t border-line pt-3"
              >
                <p className="tabular text-[12.5px] text-ink-subtle">
                  {offset + 1}–{Math.min(offset + PAGE_SIZE, total)} of{' '}
                  {total.toLocaleString('en-IN')}
                </p>
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    disabled={offset === 0}
                    onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
                  >
                    Previous
                  </Button>
                  <Button
                    size="sm"
                    disabled={offset + PAGE_SIZE >= total}
                    onClick={() => setOffset(offset + PAGE_SIZE)}
                  >
                    Next
                  </Button>
                </div>
              </nav>
            )}
          </>
        )}
      </SectionCard>
    </div>
  );
}
