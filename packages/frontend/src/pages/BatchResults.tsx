import { useState } from 'react';
import { Link } from 'react-router-dom';
import { formatDateTime, formatMoney } from '../lib/format.ts';
import { SESSION_ONLY_NOTICE, useSessionRuns } from '../lib/session-runs.ts';
import { batchItemPresentation } from '../lib/run-status.ts';
import {
  Button,
  Callout,
  EmptyState,
  MetricCard,
  SectionCard,
  StatusBadge,
} from '../components/primitives.tsx';

/**
 * ============================================================================
 * BATCH RESULTS
 * ============================================================================
 *
 * THERE IS NO BATCH HISTORY, AND THIS SCREEN DOES NOT PRETEND OTHERWISE.
 *
 * No migration creates a runs table, and the /api/recovery/runs handler writes
 * no run row — it computes a summary and returns it. So the only batch result
 * that exists anywhere is the one in the HTTP response the operator just
 * received, held in memory by `sessionRuns` for this tab.
 *
 * This screen therefore:
 *   - renders ONLY fields the API actually returned
 *   - labels the result "Current session result", never "Recent runs"
 *   - shows an honest empty state after a reload, rather than a fabricated
 *     previous run
 *   - does not write to localStorage to fake persistence
 *
 * The durable record of what a run DID is the audit log, which is backed by an
 * append-only table. This page links there rather than inventing a history of
 * its own.
 *
 * ---------------------------------------------------------------------------
 * MONEY
 * ---------------------------------------------------------------------------
 *
 * `amount_at_risk` and `amount_recovered` are the BACKEND's own totals, in
 * minor units. They are passed to formatMoney exactly once and never summed,
 * re-derived, or reconciled here. `amount_recovered` is non-zero only for
 * items the backend marked RECOVERED, which requires a VERIFIED verdict.
 */

/*
 * A run may return up to the API's 1,000-item ceiling, and each row is ~15 DOM
 * nodes. Rendering all of them at once is measurably heavy (~15k nodes) for a
 * table an operator typically scans the top of, so rows are revealed in
 * batches. Everything the run reported stays reachable — nothing is dropped,
 * and the counts above the table are always the API's own totals.
 */
const ROWS_PER_PAGE = 100;

export function BatchResults() {
  const { batch, batchExecuted, batchReceivedAt } = useSessionRuns();
  const [visibleRows, setVisibleRows] = useState(ROWS_PER_PAGE);

  if (batch === null) {
    return (
      <div className="space-y-5">
        <Callout tone="info" title="Batch runs are not stored by the backend">
          RecoverAI computes a run summary and returns it in the response. It does not write a run
          record, so there is no history to load — not on this page, and not anywhere else. What a
          run <em>did</em> is recorded permanently in the audit log.
        </Callout>

        <SectionCard>
          <EmptyState
            title="No batch result is available in this session."
            description="Start a run from Batch Recovery and its result will appear here. Reloading this page discards it, because the backend has no copy to fetch."
            action={
              <Link
                to="/batch"
                className="inline-flex items-center rounded-lg border border-ink bg-ink px-3.5 py-1.5 text-[13px] font-medium text-white transition hover:bg-ink/90"
              >
                Go to Batch Recovery
              </Link>
            }
          />
        </SectionCard>
      </div>
    );
  }

  const durationMs = Date.parse(batch.finished_at) - Date.parse(batch.started_at);

  return (
    <div className="space-y-5">
      {/* ---- The session-only statement, before any figure ---- */}
      <Callout tone="attention" title="Current session result — not stored by the backend">
        {SESSION_ONLY_NOTICE}
      </Callout>

      {/* ---- Which mode produced this ---- */}
      <div className="rounded-xl border border-line bg-surface px-5 py-4 shadow-[0_1px_2px_rgba(16,24,40,0.04)]">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-ink-subtle">
              Run mode
            </p>
            <p className="mt-1 flex items-center gap-2 text-[18px] font-semibold tracking-tight text-ink">
              <StatusBadge
                presentation={
                  batchExecuted
                    ? {
                        label: 'Executed',
                        tone: 'attention',
                        icon: '↑',
                        description: 'Authorized actions were sent to the payment provider.',
                      }
                    : {
                        label: 'Preview',
                        tone: 'info',
                        icon: '◇',
                        description: 'execute: false — the payment provider was never contacted.',
                      }
                }
              />
            </p>
            <p className="mt-1.5 text-[12.5px] leading-relaxed text-ink-subtle">
              {batchExecuted
                ? 'Recovery actions were sent to the provider for every payment policy authorized.'
                : 'The provider was never contacted. Diagnosis records and audit entries were still written.'}
            </p>
          </div>
          <dl className="space-y-1 text-right text-[12px]">
            <div>
              <dt className="inline text-ink-subtle">Run </dt>
              <dd className="tabular inline text-ink" title={batch.run_id}>
                {batch.run_id.slice(0, 16)}…
              </dd>
            </div>
            <div>
              <dt className="inline text-ink-subtle">Started </dt>
              <dd className="inline text-ink">{formatDateTime(batch.started_at)}</dd>
            </div>
            <div>
              <dt className="inline text-ink-subtle">Duration </dt>
              <dd className="tabular inline text-ink">
                {Number.isFinite(durationMs) ? `${(durationMs / 1000).toFixed(1)}s` : '—'}
              </dd>
            </div>
            {batchReceivedAt !== null && (
              <div>
                <dt className="inline text-ink-subtle">Received </dt>
                <dd className="inline text-ink">{formatDateTime(batchReceivedAt)}</dd>
              </div>
            )}
          </dl>
        </div>
      </div>

      {/* ---- Money: the backend's own totals, formatted once ---- */}
      <div className="grid gap-4 sm:grid-cols-2">
        <MetricCard
          label="Amount at risk"
          value={formatMoney(batch.amount_at_risk)}
          sublabel="Sum of case-level revenue at risk across this run."
        />
        <MetricCard
          label="Verified recovered"
          value={formatMoney(batch.amount_recovered)}
          sublabel="Counts only items with a VERIFIED verdict. Provider acceptance alone is excluded."
          emphasis
        />
      </div>

      {/* ---- Counts, exactly as returned ---- */}
      <SectionCard
        title="Counts"
        description="Every figure below is returned by the API. None is derived in the browser."
      >
        <dl className="grid grid-cols-2 gap-x-6 gap-y-3 pt-1 sm:grid-cols-3 lg:grid-cols-4">
          <Count label="Total eligible" value={batch.total_eligible} />
          <Count label="Analyzed" value={batch.analyzed} />
          <Count label="Authorized" value={batch.authorized} />
          <Count label="Not authorized" value={batch.rejected} />
          <Count label="Executed" value={batch.executed} />
          <Count label="Verified" value={batch.verified} />
          <Count label="Recovered" value={batch.recovered} />
          <Count label="Skipped duplicate" value={batch.skipped_duplicate} />
          <Count label="Errors" value={batch.failed} />
        </dl>
      </SectionCard>

      {/* ---- Per-payment items ---- */}
      <SectionCard
        title={`Payments (${batch.items.length.toLocaleString('en-IN')})`}
        description="One row per payment the run considered, with the verdict each stage produced."
      >
        {batch.items.length === 0 ? (
          <EmptyState
            title="This run considered no payments."
            description="No payment matched the selected merchant, statuses, and limit."
          />
        ) : (
          <div className="-mx-5 overflow-x-auto">
            <table className="w-full min-w-[880px] text-left">
              <caption className="sr-only">
                Batch run items. Each row shows one payment and the outcome of each pipeline stage.
              </caption>
              <thead>
                <tr className="border-b border-line text-[11px] uppercase tracking-wide text-ink-subtle">
                  <th scope="col" className="px-5 py-2.5 font-medium">Payment</th>
                  <th scope="col" className="px-5 py-2.5 font-medium">Outcome</th>
                  <th scope="col" className="px-5 py-2.5 font-medium">Action</th>
                  <th scope="col" className="px-5 py-2.5 font-medium">Policy</th>
                  <th scope="col" className="px-5 py-2.5 font-medium">Verification</th>
                  <th scope="col" className="px-5 py-2.5 text-right font-medium">At risk</th>
                  <th scope="col" className="px-5 py-2.5 text-right font-medium">Recovered</th>
                  <th scope="col" className="px-5 py-2.5 font-medium">Detail</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {batch.items.slice(0, visibleRows).map((item) => (
                  <tr key={item.payment_id} className="align-top transition hover:bg-canvas">
                    <td className="px-5 py-3 text-[12.5px]">
                      <Link
                        to={`/payments/${item.payment_id}`}
                        className="tabular text-ink hover:text-info hover:underline"
                      >
                        {item.payment_id}
                      </Link>
                    </td>
                    <td className="px-5 py-3">
                      {/*
                        Rendered through batchItemPresentation, which is the
                        single place permitted to emit the word "Recovered" and
                        does so only for the backend's RECOVERED status.
                      */}
                      <StatusBadge presentation={batchItemPresentation(item.status)} />
                    </td>
                    <td className="px-5 py-3 text-[12.5px] text-ink-muted">
                      {item.action ?? '—'}
                    </td>
                    <td className="px-5 py-3 text-[12.5px] text-ink-muted">
                      {item.policy_decision ?? '—'}
                    </td>
                    <td className="px-5 py-3 text-[12.5px] text-ink-muted">
                      {item.verification_status ?? '—'}
                    </td>
                    <td className="tabular px-5 py-3 text-right text-[12.5px] text-ink">
                      {formatMoney(item.amount_at_risk)}
                    </td>
                    <td className="tabular px-5 py-3 text-right text-[12.5px]">
                      {item.amount_recovered === 0 ? (
                        <span className="text-ink-subtle">—</span>
                      ) : (
                        <span className="font-medium text-verified">
                          {formatMoney(item.amount_recovered)}
                        </span>
                      )}
                    </td>
                    <td className="px-5 py-3 text-[12px] leading-relaxed text-ink-muted">
                      <span className="block max-w-[280px]">{item.message}</span>
                      {item.refusal_reason !== null && (
                        <span className="mt-0.5 block text-danger">{item.refusal_reason}</span>
                      )}
                      {item.case_id !== null && (
                        <Link
                          to={`/cases/${item.case_id}`}
                          className="mt-1 inline-block text-[12px] text-info hover:underline"
                        >
                          View case
                        </Link>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {batch.items.length > visibleRows && (
          <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-line pt-3">
            <p className="tabular text-[12.5px] text-ink-subtle">
              Showing {visibleRows.toLocaleString('en-IN')} of{' '}
              {batch.items.length.toLocaleString('en-IN')} rows
            </p>
            <Button size="sm" onClick={() => setVisibleRows((n) => n + ROWS_PER_PAGE)}>
              Show more
            </Button>
          </div>
        )}
      </SectionCard>

      <p className="text-[12px] leading-relaxed text-ink-subtle">
        This summary is not persisted.{' '}
        <Link to="/audit" className="text-info hover:underline">
          The audit log
        </Link>{' '}
        holds the permanent record of every decision this run made, and the cases it created remain
        available under Recovery Cases.
      </p>
    </div>
  );
}

function Count({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <dt className="text-[11px] font-medium uppercase tracking-wide text-ink-subtle">{label}</dt>
      <dd className="tabular mt-0.5 text-[18px] font-semibold text-ink">
        {value.toLocaleString('en-IN')}
      </dd>
    </div>
  );
}
