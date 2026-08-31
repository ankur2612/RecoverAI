import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, ApiError } from '../api/client.ts';
import { formatMoney, formatMoneyCompact, formatPercent, humanise } from '../lib/format.ts';
import {
  Button,
  EmptyState,
  ErrorState,
  MetricCard,
  SectionCard,
  Skeleton,
  cx,
} from '../components/primitives.tsx';
import type { CountByKey } from '../types/domain.ts';

/**
 * Recovery analytics.
 *
 * TWO RULES GOVERN THIS PAGE.
 *
 * 1. RECOVERED REVENUE IS BACKEND-DERIVED. `amount_recovered` is computed in
 *    SQL, gated on verification_status = 'VERIFIED', and rendered here
 *    verbatim. This page never sums, derives, or approximates it — doing so
 *    would let the UI make a financial claim the evidence does not support.
 *
 * 2. NO FABRICATED HISTORY. The backend exposes aggregate totals and five
 *    distributions; it stores no time series. A trend chart would therefore
 *    have to invent its own data, so none is drawn. Distribution bars and
 *    tables over real aggregates are the honest alternative, and are stated
 *    as such on the page.
 */

const TONE_FOR_KEY = (key: string): string => {
  if (['RECOVERED', 'VERIFIED', 'ALLOWED', 'SUCCESS'].includes(key)) return 'bg-verified';
  if (['AWAITING_APPROVAL', 'UNCONFIRMED', 'EXECUTING', 'PENDING', 'REQUIRES_APPROVAL'].includes(key))
    return 'bg-attention';
  if (['FAILED', 'BLOCKED', 'REJECTED', 'NOT_RECOVERED'].includes(key)) return 'bg-danger';
  if (['OPEN', 'APPROVED'].includes(key)) return 'bg-info';
  return 'bg-neutral';
};

/**
 * A labelled distribution.
 *
 * Rendered as a proportional bar plus an explicit count table: the bar gives
 * shape at a glance, the table gives the exact figures an operator needs to
 * quote. Percentages are computed from counts, which are not money — no
 * financial value is derived here.
 */
function Distribution({
  title,
  description,
  items,
  emptyLabel,
}: {
  title: string;
  description: string;
  items: CountByKey[];
  emptyLabel: string;
}) {
  const total = items.reduce((sum, item) => sum + item.count, 0);

  return (
    <SectionCard title={title} description={description}>
      {items.length === 0 || total === 0 ? (
        <EmptyState title={emptyLabel} />
      ) : (
        <>
          <div className="flex h-2 overflow-hidden rounded-full bg-line/60" role="presentation">
            {items.map((item) => (
              <div
                key={item.key}
                className={TONE_FOR_KEY(item.key)}
                style={{ width: `${(item.count / total) * 100}%` }}
                title={`${humanise(item.key)}: ${item.count}`}
              />
            ))}
          </div>

          <table className="mt-4 w-full text-left">
            <caption className="sr-only">{title}</caption>
            <thead className="sr-only">
              <tr>
                <th scope="col">Category</th>
                <th scope="col">Count</th>
                <th scope="col">Share</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.key} className="border-t border-line/60 first:border-t-0">
                  <td className="py-1.5">
                    <span className="flex items-center gap-2 text-[12.5px] text-ink-muted">
                      <span
                        aria-hidden="true"
                        className={cx('h-2 w-2 shrink-0 rounded-full', TONE_FOR_KEY(item.key))}
                      />
                      {humanise(item.key)}
                    </span>
                  </td>
                  <td className="tabular py-1.5 text-right text-[13px] font-medium text-ink">
                    {item.count.toLocaleString('en-IN')}
                  </td>
                  <td className="tabular w-16 py-1.5 text-right text-[12px] text-ink-subtle">
                    {((item.count / total) * 100).toFixed(1)}%
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </SectionCard>
  );
}

export function Analytics() {
  const [merchantId, setMerchantId] = useState('');

  const query = useQuery({
    queryKey: ['analytics', { merchantId }],
    queryFn: ({ signal }) =>
      api.analytics(merchantId.trim() === '' ? {} : { merchant_id: merchantId.trim() }, signal),
  });

  if (query.isError) {
    return (
      <ErrorState
        title="Could not load recovery analytics"
        message={
          query.error instanceof ApiError
            ? query.error.operatorMessage
            : 'An unexpected error occurred.'
        }
        onRetry={() => void query.refetch()}
      />
    );
  }

  const data = query.data;

  return (
    <div className="space-y-6">
      {/* ---- Merchant scope ---- */}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <label
            htmlFor="analytics-merchant"
            className="block text-[11px] font-medium uppercase tracking-wide text-ink-subtle"
          >
            Merchant
          </label>
          <input
            id="analytics-merchant"
            value={merchantId}
            placeholder="All merchants"
            onChange={(event) => setMerchantId(event.target.value)}
            className="mt-1 w-48 rounded-lg border border-line-strong bg-surface px-3 py-1.5 text-[13px] text-ink placeholder:text-ink-subtle/60"
          />
        </div>
        <Button onClick={() => void query.refetch()} size="sm">
          Refresh
        </Button>
      </div>

      {/* ---- Recovery summary ---- */}
      <section aria-label="Recovery summary" className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {query.isLoading || data === undefined ? (
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
            {/* The backend's VERIFIED-only figure, passed through untouched. */}
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
            <MetricCard
              label="Total Cases"
              value={data.total_cases.toLocaleString('en-IN')}
              sublabel={`${data.total_payments.toLocaleString('en-IN')} payments`}
            />
          </>
        )}
      </section>

      {/* ---- The measurement definition, stated on the page ---- */}
      {data !== undefined && (
        <SectionCard title="How recovery is measured">
          <p className="text-[13px] leading-relaxed text-ink-muted">
            Recovered revenue counts <span className="font-medium text-ink">only</span> provider
            outcomes verified by RecoverAI. An AI recommendation, a policy approval, and an
            execution the provider accepted are each distinct from recovered money and do{' '}
            <span className="font-medium text-ink">not</span> contribute to the figure above.
          </p>
          <dl className="mt-4 grid gap-3 border-t border-line pt-4 sm:grid-cols-3">
            <div>
              <dt className="text-[11px] font-medium uppercase tracking-wide text-ink-subtle">
                Amount at risk
              </dt>
              <dd className="mt-1 text-[12.5px] text-ink-muted">
                Sum of revenue at risk across recovery cases.
              </dd>
            </div>
            <div>
              <dt className="text-[11px] font-medium uppercase tracking-wide text-ink-subtle">
                Verified recovered
              </dt>
              <dd className="mt-1 text-[12.5px] text-ink-muted">
                Sum of action amounts whose verification verdict is VERIFIED.
              </dd>
            </div>
            <div>
              <dt className="text-[11px] font-medium uppercase tracking-wide text-ink-subtle">
                Recovery rate
              </dt>
              <dd className="mt-1 text-[12.5px] text-ink-muted">
                Verified recovered ÷ amount at risk, or 0 when nothing is at risk.
              </dd>
            </div>
          </dl>
        </SectionCard>
      )}

      {/* ---- Distributions over real aggregates ---- */}
      {query.isLoading ? (
        <div className="grid gap-4 lg:grid-cols-2">
          <Skeleton className="h-56 w-full rounded-xl" />
          <Skeleton className="h-56 w-full rounded-xl" />
        </div>
      ) : data === undefined ? null : (
        <>
          <div className="grid gap-4 lg:grid-cols-2">
            <Distribution
              title="Cases by status"
              description="Where cases currently sit in the recovery lifecycle."
              items={data.cases_by_status}
              emptyLabel="No recovery cases yet."
            />
            <Distribution
              title="Cases by recommended action"
              description="What the AI proposed. A recommendation is not authorization."
              items={data.cases_by_action}
              emptyLabel="No recommendations yet."
            />
          </div>

          <div className="grid gap-4 lg:grid-cols-3">
            <Distribution
              title="Policy decisions"
              description="What the deterministic engine permitted."
              items={data.actions_by_policy_status}
              emptyLabel="No policy decisions recorded."
            />
            <Distribution
              title="Execution outcomes"
              description="What the provider said about our requests — not whether money moved."
              items={data.actions_by_execution_status}
              emptyLabel="No executions yet."
            />
            <Distribution
              title="Verification outcomes"
              description="What the evidence proved. Only VERIFIED is recovered revenue."
              items={data.actions_by_verification_status}
              emptyLabel="No verified outcomes yet."
            />
          </div>

          {/*
            Said plainly rather than filled with a fabricated chart: the
            backend stores aggregates, not history.
          */}
          <SectionCard title="Trends over time">
            <EmptyState
              title="Time-series data is not available."
              description="RecoverAI stores aggregate totals rather than a historical series, so no trend can be shown without inventing it. The distributions above reflect the current state of the dataset."
            />
          </SectionCard>
        </>
      )}
    </div>
  );
}
