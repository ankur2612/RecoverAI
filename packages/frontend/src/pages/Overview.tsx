import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api, ApiError } from '../api/client.ts';
import { formatAge, formatMoney, formatMoneyCompact, formatPercent, humanise } from '../lib/format.ts';
import { casePresentation } from '../lib/status.ts';
import {
  EmptyState,
  ErrorState,
  MetricCard,
  SectionCard,
  Skeleton,
  StatusBadge,
  TableSkeleton,
  cx,
} from '../components/primitives.tsx';
import type { CountByKey } from '../types/domain.ts';

/**
 * The Overview dashboard.
 *
 * FINANCIAL RULE: "Verified Recovered" is `analytics.amount_recovered`,
 * computed by the backend in SQL and gated on verification_status = VERIFIED.
 * This page never sums, derives, or approximates recovered revenue — doing so
 * would let the UI make a financial claim the evidence does not support.
 */

/** A horizontal distribution bar. Aggregate data only; no invented history. */
function DistributionBar({ items }: { items: CountByKey[] }) {
  const total = items.reduce((sum, item) => sum + item.count, 0);
  if (total === 0) return null;

  const toneFor = (key: string): string => {
    if (key === 'RECOVERED' || key === 'VERIFIED' || key === 'ALLOWED' || key === 'SUCCESS')
      return 'bg-verified';
    if (key === 'AWAITING_APPROVAL' || key === 'UNCONFIRMED' || key === 'EXECUTING' || key === 'PENDING')
      return 'bg-attention';
    if (key === 'FAILED' || key === 'BLOCKED' || key === 'REJECTED' || key === 'NOT_RECOVERED')
      return 'bg-danger';
    if (key === 'OPEN' || key === 'APPROVED') return 'bg-info';
    return 'bg-neutral';
  };

  return (
    <div>
      <div className="flex h-2 overflow-hidden rounded-full bg-line/60" role="presentation">
        {items.map((item) => (
          <div
            key={item.key}
            className={toneFor(item.key)}
            style={{ width: `${(item.count / total) * 100}%` }}
            title={`${humanise(item.key)}: ${item.count}`}
          />
        ))}
      </div>
      <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-2.5 sm:grid-cols-3">
        {items.map((item) => (
          <div key={item.key} className="flex items-center justify-between gap-2">
            <dt className="flex min-w-0 items-center gap-2 text-[12.5px] text-ink-muted">
              <span aria-hidden="true" className={cx('h-2 w-2 shrink-0 rounded-full', toneFor(item.key))} />
              <span className="truncate">{humanise(item.key)}</span>
            </dt>
            <dd className="tabular text-[13px] font-medium text-ink">{item.count}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

export function Overview() {
  const analytics = useQuery({
    queryKey: ['analytics'],
    queryFn: ({ signal }) => api.analytics({}, signal),
  });

  const recentCases = useQuery({
    queryKey: ['cases', { limit: 8 }],
    queryFn: ({ signal }) => api.listCases({ limit: 8 }, signal),
  });

  const awaitingApproval = useQuery({
    queryKey: ['cases', { status: 'AWAITING_APPROVAL', limit: 1 }],
    queryFn: ({ signal }) => api.listCases({ status: 'AWAITING_APPROVAL', limit: 1 }, signal),
  });

  /**
   * Null until the count is genuinely known — pending or failed both mean
   * "not yet", never zero. Optional-chained through `pagination` so a
   * malformed envelope degrades rather than throwing.
   */
  const awaitingApprovalCount: number | null =
    awaitingApproval.isLoading || awaitingApproval.isError
      ? null
      : (awaitingApproval.data?.pagination?.total ?? null);

  if (analytics.isError) {
    return (
      <ErrorState
        title="Could not load recovery analytics"
        message={
          analytics.error instanceof ApiError
            ? analytics.error.operatorMessage
            : 'An unexpected error occurred.'
        }
        onRetry={() => void analytics.refetch()}
      />
    );
  }

  const data = analytics.data;

  return (
    <div className="space-y-6">
      {/* ---- Hero metrics ---- */}
      <section aria-label="Key metrics" className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {analytics.isLoading || data === undefined ? (
          Array.from({ length: 4 }).map((_, index) => (
            <div key={index} className="rounded-xl border border-line bg-surface px-5 py-4">
              <Skeleton className="h-3 w-24" />
              <Skeleton className="mt-3 h-8 w-32" />
            </div>
          ))
        ) : (
          <>
            <MetricCard
              label="Amount at Risk"
              value={formatMoneyCompact(data.amount_at_risk)}
              sublabel={formatMoney(data.amount_at_risk)}
            />
            {/*
              The one emphasised figure in the product. It is the backend's
              VERIFIED-only total, passed through untouched.
            */}
            <MetricCard
              label="Verified Recovered"
              value={formatMoneyCompact(data.amount_recovered)}
              sublabel="Provider-verified outcomes only"
              tone="verified"
              emphasis
            />
            <MetricCard
              label="Recovery Rate"
              value={formatPercent(data.recovery_rate)}
              sublabel={`${formatMoneyCompact(data.amount_unrecovered)} unrecovered`}
            />
            {/*
              This count comes from its OWN query, which can still be in
              flight when the analytics query has already resolved. Rendering
              `?? 0` in that window flashes a confident "0" that then jumps to
              the real figure — and briefly contradicts the recovery-health
              distribution lower down the same page. An em dash while pending
              is honest; a zero is not.
            */}
            <MetricCard
              label="Awaiting Approval"
              value={
                awaitingApprovalCount === null ? '—' : String(awaitingApprovalCount)
              }
              sublabel={
                awaitingApprovalCount === null
                  ? 'Checking…'
                  : awaitingApprovalCount > 0
                    ? 'Human decision required'
                    : 'Nothing waiting'
              }
              tone={(awaitingApprovalCount ?? 0) > 0 ? 'attention' : 'neutral'}
            />
          </>
        )}
      </section>

      {/* ---- How recovery is measured ---- */}
      {data !== undefined && (
        <p className="rounded-lg border border-line bg-surface px-4 py-3 text-[12.5px] leading-relaxed text-ink-muted">
          <span className="font-medium text-ink">How recovery is measured. </span>
          Recovered revenue counts only provider outcomes verified by RecoverAI. AI
          recommendations, policy approvals, and accepted executions do not count as recovered
          revenue.
        </p>
      )}

      {/* ---- Recovery health ---- */}
      <div className="grid gap-4 lg:grid-cols-2">
        <SectionCard
          title="Recovery health"
          description="Where cases currently sit in the lifecycle."
        >
          {analytics.isLoading ? (
            <Skeleton className="h-24 w-full" />
          ) : (data?.cases_by_status.length ?? 0) === 0 ? (
            <EmptyState
              title="No recovery data available yet"
              description="Analyze a payment or run a batch to populate this view."
            />
          ) : (
            <DistributionBar items={data!.cases_by_status} />
          )}
        </SectionCard>

        <SectionCard
          title="Verification outcomes"
          description="What the evidence proved, independent of what the provider accepted."
        >
          {analytics.isLoading ? (
            <Skeleton className="h-24 w-full" />
          ) : (data?.actions_by_verification_status.length ?? 0) === 0 ? (
            <EmptyState
              title="No verified outcomes yet"
              description="Verification runs after an action is executed."
            />
          ) : (
            <DistributionBar items={data!.actions_by_verification_status} />
          )}
        </SectionCard>
      </div>

      {/* ---- Recent cases ---- */}
      <SectionCard
        title="Recent recovery cases"
        description="The most recently updated diagnosed payments."
        actions={
          <Link
            to="/cases"
            className="text-[13px] font-medium text-info hover:underline"
          >
            View all
          </Link>
        }
      >
        {recentCases.isLoading ? (
          <TableSkeleton rows={5} columns={5} />
        ) : recentCases.isError ? (
          <ErrorState
            message={
              recentCases.error instanceof ApiError
                ? recentCases.error.operatorMessage
                : 'Could not load recovery cases.'
            }
            onRetry={() => void recentCases.refetch()}
          />
        ) : (recentCases.data?.cases.length ?? 0) === 0 ? (
          <EmptyState
            title="No recovery cases yet"
            description="Cases appear once a failed payment has been analyzed."
          />
        ) : (
          <div className="-mx-5 overflow-x-auto">
            <table className="w-full min-w-[720px] text-left">
              <caption className="sr-only">Recent recovery cases</caption>
              <thead>
                <tr className="border-b border-line text-[11px] uppercase tracking-wide text-ink-subtle">
                  <th scope="col" className="px-5 py-2 font-medium">Payment</th>
                  <th scope="col" className="px-5 py-2 font-medium">Amount</th>
                  <th scope="col" className="px-5 py-2 font-medium">Diagnosis</th>
                  <th scope="col" className="px-5 py-2 font-medium">AI action</th>
                  <th scope="col" className="px-5 py-2 font-medium">Status</th>
                  <th scope="col" className="px-5 py-2 font-medium">Updated</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {recentCases.data!.cases.map((item) => (
                  <tr key={item.id} className="transition hover:bg-canvas">
                    <td className="px-5 py-3">
                      <Link
                        to={`/cases/${item.id}`}
                        className="tabular text-[13px] font-medium text-ink hover:text-info hover:underline"
                      >
                        {item.payment_id}
                      </Link>
                    </td>
                    <td className="tabular px-5 py-3 text-[13px] text-ink">
                      {formatMoney(item.revenue_at_risk)}
                    </td>
                    <td className="px-5 py-3 text-[13px] text-ink-muted">
                      {humanise(item.classification)}
                    </td>
                    <td className="px-5 py-3">
                      <span className="rounded border border-info/20 bg-info-bg px-1.5 py-0.5 text-[11px] font-medium text-info">
                        {item.recommended_action}
                      </span>
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
        )}
      </SectionCard>
    </div>
  );
}
