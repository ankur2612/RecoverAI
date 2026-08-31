import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api, ApiError } from '../api/client.ts';
import { formatDateTime } from '../lib/format.ts';
import { SESSION_ONLY_NOTICE, sessionRuns, useSessionRuns } from '../lib/session-runs.ts';
import { SWEEPER_RESOLVES_BY_OBSERVATION, sweepOutcomePresentation } from '../lib/run-status.ts';
import { NO_BLIND_RETRY } from '../lib/status.ts';
import {
  Button,
  Callout,
  EmptyState,
  SectionCard,
  StatusBadge,
} from '../components/primitives.tsx';
import type { SweepRun } from '../types/domain.ts';

/**
 * ============================================================================
 * THE SWEEPER — CRASH RECOVERY
 * ============================================================================
 *
 * THE ONE RULE: THE SWEEPER NEVER EXECUTES ANYTHING.
 *
 * A crash can leave a recovery action in PENDING (key claimed, provider not
 * called) or EXECUTING (request in flight, provider MAY have acted). EXECUTING
 * is the dangerous one: re-sending it could charge a customer twice for a
 * single recovery attempt.
 *
 * So the backend sweeper resolves by OBSERVATION. It calls getPaymentStatus —
 * a read — and lets what the provider reports decide the recorded execution
 * status. It has no import path to the executor and never calls
 * executeAction; backend architecture tests enforce both at the import level.
 *
 * This screen must not undermine that. It therefore offers exactly ONE
 * control: run a sweep, with the two parameters the API accepts. There is no
 * force-retry, no re-execute, no "resolve as success", and no per-item action
 * of any kind — because no such capability exists, and a control implying one
 * would be a lie about what the button does.
 *
 * An action the provider cannot account for stays UNCONFIRMED. That is the
 * correct outcome, not a failure to be worked around.
 *
 * ---------------------------------------------------------------------------
 * SESSION-ONLY RESULTS
 * ---------------------------------------------------------------------------
 *
 * As with batch runs, no sweeps table exists and the handler writes no run
 * row. The summary lives in memory for this tab only; the durable record of
 * what a sweep resolved is the audit log.
 */

/** Backend default, restated so the field is never blank. */
const DEFAULT_MIN_AGE_SECONDS = 120;
const DEFAULT_LIMIT = 100;

export function Sweeper() {
  const { sweep, sweepReceivedAt } = useSessionRuns();

  const [minAgeSeconds, setMinAgeSeconds] = useState(DEFAULT_MIN_AGE_SECONDS);
  const [limit, setLimit] = useState(DEFAULT_LIMIT);

  const mutation = useMutation({
    // No `retry`. A sweep is a POST; the client refuses to retry it and the
    // QueryClient disables mutation retries globally.
    mutationFn: () => api.runSweep({ min_age_seconds: minAgeSeconds, limit }),
    onSuccess: (run: SweepRun) => {
      sessionRuns.setSweep(run);
    },
  });

  const running = mutation.isPending;

  return (
    <div className="space-y-5">
      {/* ---- The safety statement, above every control ---- */}
      <Callout tone="info" title="No blind retry">
        {SWEEPER_RESOLVES_BY_OBSERVATION}
      </Callout>

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_340px]">
        {/* ---- What the sweeper is for ---- */}
        <SectionCard
          title="What a sweep does"
          description="Crash recovery for actions left in a non-terminal state."
        >
          <div className="space-y-3 pt-1 text-[12.5px] leading-relaxed text-ink-muted">
            <p>
              If RecoverAI stops mid-execution, an action can be left in{' '}
              <span className="tabular font-medium text-ink">PENDING</span> — the idempotency key
              was claimed but the provider was never called — or{' '}
              <span className="tabular font-medium text-ink">EXECUTING</span>, where a request was
              in flight and the provider may or may not have acted.
            </p>
            <p>
              The sweeper asks the payment provider what state the payment is actually in and
              records that. A reported success becomes SUCCESS, a reported failure becomes FAILED,
              and anything else stays UNCONFIRMED. The existing verification service then decides
              separately whether revenue was recovered — the sweeper never makes that call.
            </p>
            <p className="rounded-lg border border-line bg-canvas px-3.5 py-2.5 text-ink">
              {NO_BLIND_RETRY}
            </p>
          </div>
        </SectionCard>

        {/* ---- Parameters and the single control ---- */}
        <div className="space-y-4">
          <SectionCard
            title="Parameters"
            description="The only two fields the sweep API accepts."
          >
            <div className="space-y-4 pt-1">
              <div>
                <label
                  htmlFor="sweep-min-age"
                  className="block text-[11px] font-medium uppercase tracking-wide text-ink-subtle"
                >
                  Minimum age (seconds)
                </label>
                <input
                  id="sweep-min-age"
                  type="number"
                  min={0}
                  max={86400}
                  value={minAgeSeconds}
                  disabled={running}
                  onChange={(event) => setMinAgeSeconds(Number(event.target.value))}
                  className="tabular mt-1 w-32 rounded-lg border border-line-strong bg-surface px-3 py-1.5 text-[13px] text-ink disabled:opacity-50"
                />
                <p className="mt-1 text-[12px] leading-relaxed text-ink-subtle">
                  A younger action may belong to an execution that is legitimately still in flight.
                  Sweeping it would race a healthy executor.
                </p>
              </div>

              <div>
                <label
                  htmlFor="sweep-limit"
                  className="block text-[11px] font-medium uppercase tracking-wide text-ink-subtle"
                >
                  Limit
                </label>
                <input
                  id="sweep-limit"
                  type="number"
                  min={1}
                  max={1000}
                  value={limit}
                  disabled={running}
                  onChange={(event) => setLimit(Number(event.target.value))}
                  className="tabular mt-1 w-28 rounded-lg border border-line-strong bg-surface px-3 py-1.5 text-[13px] text-ink disabled:opacity-50"
                />
                <p className="mt-1 text-[12px] text-ink-subtle">
                  Maximum stranded actions swept in one pass. The API caps this at 1,000.
                </p>
              </div>
            </div>
          </SectionCard>

          {/*
            ONE control. There is deliberately no force-retry, re-execute, or
            per-item override anywhere on this screen — the backend exposes no
            such capability, and a button implying one would misrepresent it.
          */}
          <div className="space-y-2.5">
            <Button variant="primary" disabled={running} onClick={() => mutation.mutate()}>
              {running ? 'Sweeping…' : 'Run Sweep'}
            </Button>
            {running && (
              <p role="status" className="text-[12.5px] text-ink-muted">
                Asking the provider about each stranded action. Nothing is being re-sent.
              </p>
            )}
          </div>
        </div>
      </div>

      {mutation.isError && (
        <div role="alert">
          <Callout tone="danger" title="The sweep failed">
            {mutation.error instanceof ApiError
              ? mutation.error.operatorMessage
              : 'The request could not be completed.'}{' '}
            No action was resolved on the basis of this failure, and nothing was retried.
          </Callout>
        </div>
      )}

      {/* ---- Results ---- */}
      {sweep === null ? (
        <SectionCard>
          <EmptyState
            title="No sweep result is available in this session."
            description="Run a sweep and its result will appear here. The backend does not store sweep history, so reloading this page discards it."
          />
        </SectionCard>
      ) : (
        <SweepResult run={sweep} receivedAt={sweepReceivedAt} />
      )}
    </div>
  );
}

function SweepResult({ run, receivedAt }: { run: SweepRun; receivedAt: string | null }) {
  return (
    <div className="space-y-5">
      <Callout tone="attention" title="Current session result — not stored by the backend">
        {SESSION_ONLY_NOTICE}
      </Callout>

      <SectionCard
        title="Sweep summary"
        description="Every count is returned by the API. None is derived in the browser."
      >
        <div className="flex flex-wrap items-baseline justify-between gap-4 pb-3">
          <dl className="grid flex-1 grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3 lg:grid-cols-6">
            <Count label="Found" value={run.found} />
            <Count label="Provider succeeded" value={run.resolved_success} />
            <Count label="Provider failed" value={run.resolved_failed} />
            <Count label="Still unconfirmed" value={run.still_unconfirmed} />
            <Count label="Already resolved" value={run.already_resolved} />
            <Count label="Errors" value={run.failed} />
          </dl>
        </div>
        <p className="border-t border-line pt-3 text-[12px] text-ink-subtle">
          Swept {formatDateTime(run.started_at)}
          {receivedAt !== null && <> · received {formatDateTime(receivedAt)}</>}
        </p>
      </SectionCard>

      <SectionCard
        title={`Stranded actions (${run.items.length.toLocaleString('en-IN')})`}
        description="What the provider reported for each action, and the status now recorded."
      >
        {run.items.length === 0 ? (
          <EmptyState
            title="No stranded actions were found."
            description="Nothing was left in PENDING or EXECUTING beyond the minimum age. This is the healthy result."
          />
        ) : (
          <div className="-mx-5 overflow-x-auto">
            <table className="w-full min-w-[860px] text-left">
              <caption className="sr-only">
                Stranded actions this sweep examined, with the provider observation and the
                resulting status.
              </caption>
              <thead>
                <tr className="border-b border-line text-[11px] uppercase tracking-wide text-ink-subtle">
                  <th scope="col" className="px-5 py-2.5 font-medium">Payment</th>
                  <th scope="col" className="px-5 py-2.5 font-medium">Stranded in</th>
                  <th scope="col" className="px-5 py-2.5 font-medium">Provider observed</th>
                  <th scope="col" className="px-5 py-2.5 font-medium">Outcome</th>
                  <th scope="col" className="px-5 py-2.5 font-medium">Execution now</th>
                  <th scope="col" className="px-5 py-2.5 font-medium">Verification</th>
                  <th scope="col" className="px-5 py-2.5 font-medium">Detail</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {run.items.map((item) => (
                  <tr key={item.action_id} className="align-top transition hover:bg-canvas">
                    <td className="px-5 py-3 text-[12.5px]">
                      <Link
                        to={`/payments/${item.payment_id}`}
                        className="tabular text-ink hover:text-info hover:underline"
                      >
                        {item.payment_id}
                      </Link>
                    </td>
                    <td className="tabular px-5 py-3 text-[12.5px] text-ink-muted">
                      {item.stranded_in}
                    </td>
                    <td className="tabular px-5 py-3 text-[12.5px] text-ink-muted">
                      {item.observed_state ?? '—'}
                    </td>
                    <td className="px-5 py-3">
                      <StatusBadge presentation={sweepOutcomePresentation(item.outcome)} />
                    </td>
                    <td className="tabular px-5 py-3 text-[12.5px] text-ink-muted">
                      {item.execution_status ?? '—'}
                    </td>
                    <td className="tabular px-5 py-3 text-[12.5px] text-ink-muted">
                      {item.verification_status ?? '—'}
                    </td>
                    <td className="px-5 py-3 text-[12px] leading-relaxed text-ink-muted">
                      <span className="block max-w-[260px]">{item.message}</span>
                      <Link
                        to={`/cases/${item.case_id}`}
                        className="mt-1 inline-block text-[12px] text-info hover:underline"
                      >
                        View case
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </SectionCard>

      <p className="text-[12px] leading-relaxed text-ink-subtle">
        Actions left unconfirmed are not a backlog to force through. They are actions whose real
        outcome the provider could not confirm, and RecoverAI leaves them that way rather than
        risking a duplicate charge.{' '}
        <Link to="/audit" className="text-info hover:underline">
          The audit log
        </Link>{' '}
        records every resolution this sweep made.
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
