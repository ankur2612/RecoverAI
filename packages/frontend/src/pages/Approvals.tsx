import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api, ApiError } from '../api/client.ts';
import { formatAge, formatMoney, formatMoneyCompact, humanise } from '../lib/format.ts';
import { APPROVAL_IS_NOT_EXECUTION, casePresentation } from '../lib/status.ts';
import {
  Button,
  Callout,
  EmptyState,
  ErrorState,
  MetricCard,
  SectionCard,
  StatusBadge,
  Skeleton,
  TableSkeleton,
} from '../components/primitives.tsx';
import type { CaseListResponse, CaseStatus } from '../types/domain.ts';

/**
 * The approvals queue.
 *
 * READ ONLY BY DESIGN. This screen shows what is waiting and what was
 * decided; it offers no approve or reject control. Recording a decision is a
 * financial act — the backend re-evaluates policy before anything executes —
 * and putting that button here without the confirmation flow it deserves
 * would be the wrong first version.
 *
 * WHAT THE API ACTUALLY PROVIDES. `GET /api/recovery/cases?status=…` returns
 * case fields only: classification, recommended action, confidence, revenue at
 * risk, and the AI's `reason`. It does NOT return the policy's
 * `approval_reasons` — those are computed by the engine and returned only by
 * POST /analyze, which creates state. So this screen shows why the AI made its
 * recommendation and links to Case Detail for the recorded policy verdict. It
 * does not invent an approval reason.
 */

const PAGE_LIMIT = 50;

/** One decided-cases section. Renders an honest empty state when none exist. */
function DecidedSection({
  title,
  description,
  status,
  query,
  emptyTitle,
  emptyDescription,
}: {
  title: string;
  description: string;
  status: CaseStatus;
  query: ReturnType<typeof useQuery<CaseListResponse>>;
  emptyTitle: string;
  emptyDescription: string;
}) {
  const cases = query.data?.cases ?? [];
  const total: number | null =
    query.isLoading || query.isError ? null : (query.data?.pagination?.total ?? null);

  return (
    <SectionCard
      title={title}
      description={description}
      actions={
        <span className="tabular text-[12.5px] text-ink-subtle">
          {query.isLoading
            ? 'Loading…'
            : total === null
              ? 'Count unavailable'
              : `${total.toLocaleString('en-IN')}`}
        </span>
      }
    >
      {query.isLoading ? (
        <TableSkeleton rows={3} columns={4} />
      ) : query.isError ? (
        <ErrorState
          message={
            query.error instanceof ApiError
              ? query.error.operatorMessage
              : 'Could not load these cases.'
          }
          onRetry={() => void query.refetch()}
        />
      ) : cases.length === 0 ? (
        <EmptyState title={emptyTitle} description={emptyDescription} />
      ) : (
        <div className="-mx-5 overflow-x-auto">
          <table className="w-full min-w-[640px] text-left">
            <caption className="sr-only">{title}</caption>
            <thead>
              <tr className="border-b border-line text-[11px] uppercase tracking-wide text-ink-subtle">
                <th scope="col" className="px-5 py-2.5 font-medium">Payment</th>
                <th scope="col" className="px-5 py-2.5 font-medium">Amount</th>
                <th scope="col" className="px-5 py-2.5 font-medium">Action</th>
                <th scope="col" className="px-5 py-2.5 font-medium">Status</th>
                <th scope="col" className="px-5 py-2.5 font-medium">Decided</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {cases.map((item) => (
                <tr key={item.id} className="transition hover:bg-canvas">
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
                  <td className="px-5 py-3">
                    <span className="rounded border border-info/20 bg-info-bg px-1.5 py-0.5 text-[11px] font-medium text-info">
                      {item.recommended_action}
                    </span>
                  </td>
                  <td className="px-5 py-3">
                    <StatusBadge presentation={casePresentation(status)} size="sm" />
                  </td>
                  <td className="px-5 py-3 text-[12.5px] text-ink-subtle">
                    {formatAge(item.updated_at)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </SectionCard>
  );
}

export function Approvals() {
  const awaiting = useQuery({
    queryKey: ['cases', { status: 'AWAITING_APPROVAL', limit: PAGE_LIMIT }],
    queryFn: ({ signal }) =>
      api.listCases({ status: 'AWAITING_APPROVAL', limit: PAGE_LIMIT }, signal),
  });

  const approved = useQuery({
    queryKey: ['cases', { status: 'APPROVED', limit: PAGE_LIMIT }],
    queryFn: ({ signal }) => api.listCases({ status: 'APPROVED', limit: PAGE_LIMIT }, signal),
  });

  const rejected = useQuery({
    queryKey: ['cases', { status: 'REJECTED', limit: PAGE_LIMIT }],
    queryFn: ({ signal }) => api.listCases({ status: 'REJECTED', limit: PAGE_LIMIT }, signal),
  });

  const queue = awaiting.data?.cases ?? [];

  // The API's own count, never the page length. Null while unknown.
  const awaitingTotal: number | null =
    awaiting.isLoading || awaiting.isError
      ? null
      : (awaiting.data?.pagination?.total ?? null);

  /*
   * Null while either half is unknown, never zero. A failed query must not
   * render as "0 decided" — that is a factual claim about the record, and it
   * would be indistinguishable from a genuine empty queue.
   */
  const decidedTotal: number | null =
    approved.isLoading || approved.isError || rejected.isLoading || rejected.isError
      ? null
      : (approved.data?.pagination?.total ?? 0) + (rejected.data?.pagination?.total ?? 0);

  // Sum of amounts on the CURRENT PAGE only, and labelled as such. This is a
  // display aggregation over case-level figures — never recovered revenue,
  // which stays backend-derived on Analytics.
  const queuedValue = queue.reduce((sum, item) => sum + item.revenue_at_risk, 0);

  return (
    <div className="space-y-6">
      {/* ---- Queue metrics ---- */}
      <section aria-label="Approval queue" className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {awaiting.isLoading ? (
          Array.from({ length: 3 }).map((_, index) => (
            <div key={index} className="rounded-xl border border-line bg-surface px-5 py-4">
              <Skeleton className="h-3 w-24" />
              <Skeleton className="mt-3 h-8 w-24" />
            </div>
          ))
        ) : (
          <>
            <MetricCard
              label="Awaiting Approval"
              value={awaitingTotal === null ? '—' : String(awaitingTotal)}
              sublabel={
                awaitingTotal === null
                  ? 'Checking…'
                  : awaitingTotal > 0
                    ? 'Human decision required'
                    : 'Nothing waiting'
              }
              tone={(awaitingTotal ?? 0) > 0 ? 'attention' : 'neutral'}
            />
            <MetricCard
              label="Value in Queue"
              value={formatMoneyCompact(queuedValue)}
              sublabel={
                awaitingTotal !== null && queue.length < awaitingTotal
                  ? `Across the ${queue.length} shown`
                  : 'Revenue at risk, pending review'
              }
            />
            <MetricCard
              label="Decided"
              value={decidedTotal === null ? '—' : String(decidedTotal)}
              sublabel={
                approved.isError || rejected.isError
                  ? 'Count unavailable'
                  : approved.isLoading || rejected.isLoading
                    ? 'Checking…'
                    : 'Approved or rejected'
              }
            />
          </>
        )}
      </section>

      {/* ---- The boundary, stated where decisions are reviewed ---- */}
      <Callout tone="info" title="Approval is not authorization">
        {APPROVAL_IS_NOT_EXECUTION} This screen is read-only: decisions are recorded through the
        API, and the deterministic policy engine remains the sole authority on whether an action
        may run.
      </Callout>

      {/* ---- The queue ---- */}
      <SectionCard
        title="Awaiting approval"
        description="Cases the policy engine gated pending a human decision."
        actions={
          <Button size="sm" onClick={() => void awaiting.refetch()}>
            Refresh
          </Button>
        }
      >
        {awaiting.isLoading ? (
          <TableSkeleton rows={6} columns={6} />
        ) : awaiting.isError ? (
          <ErrorState
            title="Could not load the approval queue"
            message={
              awaiting.error instanceof ApiError
                ? awaiting.error.operatorMessage
                : 'An unexpected error occurred.'
            }
            onRetry={() => void awaiting.refetch()}
          />
        ) : queue.length === 0 ? (
          <EmptyState
            title="You're all caught up."
            description="No cases are currently waiting on a human decision."
          />
        ) : (
          <div className="-mx-5 overflow-x-auto">
            <table className="w-full min-w-[880px] text-left">
              <caption className="sr-only">
                Cases awaiting a human approval decision
              </caption>
              <thead>
                <tr className="border-b border-line text-[11px] uppercase tracking-wide text-ink-subtle">
                  <th scope="col" className="px-5 py-2.5 font-medium">Payment</th>
                  <th scope="col" className="px-5 py-2.5 font-medium">Amount</th>
                  <th scope="col" className="px-5 py-2.5 font-medium">Diagnosis</th>
                  <th scope="col" className="px-5 py-2.5 font-medium">AI action</th>
                  <th scope="col" className="px-5 py-2.5 font-medium">Confidence</th>
                  <th scope="col" className="px-5 py-2.5 font-medium">Waiting</th>
                  <th scope="col" className="px-5 py-2.5 font-medium">Review</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {queue.map((item) => (
                  <tr key={item.id} className="align-top transition hover:bg-canvas">
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
                    <td className="px-5 py-3">
                      <p className="text-[13px] text-ink-muted">
                        {humanise(item.classification)}
                      </p>
                      {/*
                        The AI's own reasoning. Labelled as such, because the
                        API does not expose the POLICY's approval reasons —
                        those live on the case detail's recorded verdict.
                      */}
                      <p className="mt-0.5 max-w-sm text-[11.5px] leading-snug text-ink-subtle">
                        {item.reason.length > 110
                          ? `${item.reason.slice(0, 110)}…`
                          : item.reason}
                      </p>
                    </td>
                    <td className="px-5 py-3">
                      <span className="rounded border border-info/20 bg-info-bg px-1.5 py-0.5 text-[11px] font-medium text-info">
                        {item.recommended_action}
                      </span>
                    </td>
                    <td className="tabular px-5 py-3 text-[13px] text-ink-muted">
                      {(item.confidence * 100).toFixed(0)}%
                    </td>
                    <td className="px-5 py-3 text-[12.5px] text-ink-subtle">
                      {formatAge(item.created_at)}
                    </td>
                    <td className="px-5 py-3">
                      <Link
                        to={`/cases/${item.id}`}
                        className="text-[12.5px] font-medium text-info hover:underline"
                      >
                        Review →
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            {awaitingTotal !== null && awaitingTotal > queue.length && (
              <p className="mt-4 border-t border-line px-5 pt-3 text-[12.5px] text-ink-subtle">
                Showing the first {queue.length} of {awaitingTotal.toLocaleString('en-IN')}{' '}
                waiting cases.
              </p>
            )}
          </div>
        )}
      </SectionCard>

      {/* ---- Decided ---- */}
      <div className="grid gap-4 lg:grid-cols-2">
        <DecidedSection
          title="Approved"
          description="A human approved these. Execution remains subject to current policy."
          status="APPROVED"
          query={approved}
          emptyTitle="No approvals recorded yet."
          emptyDescription="An approved case appears here once a decision is recorded through the API."
        />
        <DecidedSection
          title="Rejected"
          description="A human declined these. They will not be executed."
          status="REJECTED"
          query={rejected}
          emptyTitle="No rejections recorded yet."
          emptyDescription="A rejected case appears here once a decision is recorded through the API."
        />
      </div>
    </div>
  );
}
