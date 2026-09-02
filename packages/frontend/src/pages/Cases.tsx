import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api, ApiError } from '../api/client.ts';
import { formatAge, formatMoney, humanise } from '../lib/format.ts';
import { casePresentation } from '../lib/status.ts';
import {
  Button,
  EmptyState,
  ErrorState,
  SectionCard,
  StatusBadge,
  TableSkeleton,
} from '../components/primitives.tsx';
import type { CaseStatus } from '../types/domain.ts';

/**
 * The case list.
 *
 * FILTERS REFLECT WHAT THE BACKEND ACTUALLY SUPPORTS. GET /api/recovery/cases
 * accepts `status`, `limit`, and `offset` — nothing else. A search box or a
 * merchant filter would have to be faked client-side over one page of results,
 * which would silently lie about the dataset, so neither is offered.
 */

const STATUS_OPTIONS: (CaseStatus | 'ALL')[] = [
  'ALL',
  'OPEN',
  'AWAITING_APPROVAL',
  'APPROVED',
  'REJECTED',
  'EXECUTING',
  'AWAITING_VERIFICATION',
  'RECOVERED',
  'FAILED',
  'ESCALATED',
  'CLOSED',
];

const PAGE_SIZE = 25;

export function Cases() {
  const [status, setStatus] = useState<CaseStatus | 'ALL'>('ALL');
  const [offset, setOffset] = useState(0);

  const query = useQuery({
    queryKey: ['cases', { status, offset }],
    queryFn: ({ signal }) =>
      api.listCases(
        {
          ...(status === 'ALL' ? {} : { status }),
          limit: PAGE_SIZE,
          offset,
        },
        signal,
      ),
  });

  const cases = query.data?.cases ?? [];

  /**
   * The count comes from the API's own `pagination.total`, never from
   * `cases.length` — that would report the size of the current PAGE and
   * silently understate the dataset (25 of 231 would read as "25 cases").
   *
   * `null` means "no trustworthy count": either the request is in flight or it
   * failed. Rendering 0 in those states would be a misleading number beside an
   * error, so the label is suppressed instead.
   */
  // A malformed envelope costs a label, not the table.
  const total: number | null =
    query.isLoading || query.isError ? null : (query.data?.pagination?.total ?? null);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <label
              htmlFor="status-filter"
              className="block text-[11px] font-medium uppercase tracking-wide text-ink-subtle"
            >
              Status
            </label>
            <select
              id="status-filter"
              value={status}
              onChange={(event) => {
                setStatus(event.target.value as CaseStatus | 'ALL');
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
        </div>

        <div className="flex items-center gap-3">
          <p className="tabular text-[12.5px] text-ink-subtle" aria-live="polite">
            {query.isLoading
              ? 'Loading…'
              : total === null
                ? 'Count unavailable'
                : `${total} case${total === 1 ? '' : 's'}`}
          </p>
          <Button onClick={() => void query.refetch()} size="sm">
            Refresh
          </Button>
        </div>
      </div>

      <SectionCard>
        {query.isLoading ? (
          <TableSkeleton rows={8} columns={7} />
        ) : query.isError ? (
          <ErrorState
            title="Could not load recovery cases"
            message={
              query.error instanceof ApiError
                ? query.error.operatorMessage
                : 'An unexpected error occurred.'
            }
            onRetry={() => void query.refetch()}
          />
        ) : cases.length === 0 ? (
          <EmptyState
            title={status === 'ALL' ? 'No recovery cases yet' : `No ${humanise(status)} cases`}
            description={
              status === 'ALL'
                ? 'Cases appear once a failed payment has been analyzed.'
                : 'Try a different status filter.'
            }
          />
        ) : (
          <>
            <div className="-mx-5 overflow-x-auto">
              <table className="w-full min-w-[860px] text-left">
                <caption className="sr-only">
                  Recovery cases, showing the AI recommendation and current lifecycle state
                </caption>
                <thead>
                  <tr className="border-b border-line text-[11px] uppercase tracking-wide text-ink-subtle">
                    <th scope="col" className="px-5 py-2.5 font-medium">Payment</th>
                    <th scope="col" className="px-5 py-2.5 font-medium">Amount</th>
                    <th scope="col" className="px-5 py-2.5 font-medium">Diagnosis</th>
                    <th scope="col" className="px-5 py-2.5 font-medium">AI action</th>
                    <th scope="col" className="px-5 py-2.5 font-medium">Confidence</th>
                    <th scope="col" className="px-5 py-2.5 font-medium">Status</th>
                    <th scope="col" className="px-5 py-2.5 font-medium">Updated</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {cases.map((item) => (
                    <tr key={item.id} className="group transition hover:bg-canvas">
                      <td className="px-5 py-3">
                        <Link
                          to={`/cases/${item.id}`}
                          className="tabular text-[13px] font-medium text-ink hover:text-info hover:underline"
                        >
                          {item.payment_id}
                        </Link>
                      </td>
                      <td className="tabular px-5 py-3 text-[13px] font-medium text-ink">
                        {formatMoney(item.revenue_at_risk)}
                      </td>
                      <td className="px-5 py-3 text-[13px] text-ink-muted">
                        {humanise(item.classification)}
                      </td>
                      <td className="px-5 py-3">
                        {/*
                          Rendered in the INFO tone, never the success tone: an
                          AI recommendation is not permission to act.
                        */}
                        <span className="rounded border border-info/20 bg-info-bg px-1.5 py-0.5 text-[11px] font-medium text-info">
                          {item.recommended_action}
                        </span>
                      </td>
                      <td className="tabular px-5 py-3 text-[13px] text-ink-muted">
                        {(item.confidence * 100).toFixed(0)}%
                      </td>
                      <td className="px-5 py-3">
                        <StatusBadge presentation={casePresentation(item.status)} size="sm" />
                      </td>
                      <td className="px-5 py-3 text-[12.5px] text-ink-subtle">
                        {formatAge(item.updated_at)}
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
                  {offset + 1}–{Math.min(offset + PAGE_SIZE, total)} of {total}
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
