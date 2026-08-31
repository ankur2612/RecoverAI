import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api, ApiError } from '../api/client.ts';
import { formatDateTime, humanise } from '../lib/format.ts';
import {
  Button,
  EmptyState,
  ErrorState,
  SectionCard,
  TableSkeleton,
  cx,
} from '../components/primitives.tsx';

/**
 * The audit log.
 *
 * This is the product's accountability record: who decided what, when, and on
 * what basis. It is READ ONLY — the table is append-only in the database and
 * exposed through a read endpoint, so nothing here can alter history.
 *
 * SAFE METADATA RENDERING. `metadata` is free-form JSON written by RecoverAI's
 * own services (decision codes, ids, scrubbed messages). It is nonetheless
 * treated as untrusted for DISPLAY purposes: values are rendered as text, and
 * any key whose name suggests a credential is omitted rather than shown. That
 * is belt-and-braces over the backend's own scrubbing, not a substitute for it.
 */

/** Event types the backend actually emits. Kept in sync with AUDIT_EVENT_TYPES. */
const EVENT_TYPES = [
  'ALL',
  'PAYMENT_INGESTED',
  'RISK_ASSESSED',
  'AI_DIAGNOSIS',
  'DIAGNOSIS_FAILED',
  'RECOVERY_CASE_CREATED',
  'POLICY_EVALUATED',
  'EXECUTION_REQUESTED',
  'EXECUTION_SUCCEEDED',
  'EXECUTION_FAILED',
  'EXECUTION_UNKNOWN',
  'EXECUTION_REFUSED',
  'EXECUTION_SKIPPED_DUPLICATE',
  'OUTCOME_VERIFICATION_STARTED',
  'OUTCOME_VERIFIED',
  'OUTCOME_NOT_RECOVERED',
  'OUTCOME_UNCONFIRMED',
  'APPROVAL_GRANTED',
  'APPROVAL_REJECTED',
] as const;

const PAGE_SIZE = 25;

/** Key names that must never be rendered, whatever a writer put in them. */
const CREDENTIAL_KEYS =
  /token|secret|password|api[_-]?key|authorization|credential|database_url|dsn/i;

/**
 * Flatten metadata into displayable key/value pairs.
 *
 * Objects are stringified rather than rendered recursively: an audit row is a
 * scannable summary, and a nested tree would swamp the table. Credential-shaped
 * keys are dropped entirely.
 */
function safeMetadata(metadata: Record<string, unknown>): { key: string; value: string }[] {
  return Object.entries(metadata)
    .filter(([key]) => !CREDENTIAL_KEYS.test(key))
    .map(([key, value]) => ({
      key,
      value:
        value === null
          ? '—'
          : typeof value === 'object'
            ? JSON.stringify(value).slice(0, 120)
            : String(value).slice(0, 120),
    }));
}

/** Colour-coded by outcome family, always paired with the text label. */
function eventTone(eventType: string): string {
  if (/VERIFIED$|SUCCEEDED$|GRANTED$/.test(eventType)) return 'text-verified';
  if (/FAILED$|REJECTED$|REFUSED$|NOT_RECOVERED$/.test(eventType)) return 'text-danger';
  if (/UNKNOWN$|UNCONFIRMED$|REQUESTED$|STARTED$/.test(eventType)) return 'text-attention';
  return 'text-ink-muted';
}

export function Audit() {
  const [eventType, setEventType] = useState<string>('ALL');
  const [paymentId, setPaymentId] = useState('');
  const [caseId, setCaseId] = useState('');
  const [actor, setActor] = useState('');
  const [offset, setOffset] = useState(0);

  const query = useQuery({
    queryKey: ['audit', { eventType, paymentId, caseId, actor, offset }],
    queryFn: ({ signal }) =>
      api.listAudit(
        {
          ...(eventType === 'ALL' ? {} : { event_type: eventType }),
          ...(paymentId.trim() === '' ? {} : { payment_id: paymentId.trim() }),
          ...(caseId.trim() === '' ? {} : { case_id: caseId.trim() }),
          ...(actor.trim() === '' ? {} : { actor: actor.trim() }),
          limit: PAGE_SIZE,
          offset,
        },
        signal,
      ),
  });

  const events = query.data?.events ?? [];

  // The API's own count, never the page length. Null while unknown.
  const total: number | null =
    query.isLoading || query.isError ? null : (query.data?.pagination?.total ?? null);

  const resetFilters = () => {
    setEventType('ALL');
    setPaymentId('');
    setCaseId('');
    setActor('');
    setOffset(0);
  };

  const hasFilters =
    eventType !== 'ALL' || paymentId !== '' || caseId !== '' || actor !== '';

  return (
    <div className="space-y-4">
      {/* ---- Filters: exactly the four the backend supports ---- */}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <label
              htmlFor="audit-event"
              className="block text-[11px] font-medium uppercase tracking-wide text-ink-subtle"
            >
              Event
            </label>
            <select
              id="audit-event"
              value={eventType}
              onChange={(event) => {
                setEventType(event.target.value);
                setOffset(0);
              }}
              className="mt-1 rounded-lg border border-line-strong bg-surface px-3 py-1.5 text-[13px] text-ink"
            >
              {EVENT_TYPES.map((type) => (
                <option key={type} value={type}>
                  {type === 'ALL' ? 'All events' : humanise(type)}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label
              htmlFor="audit-payment"
              className="block text-[11px] font-medium uppercase tracking-wide text-ink-subtle"
            >
              Payment
            </label>
            <input
              id="audit-payment"
              value={paymentId}
              placeholder="pay_00001"
              onChange={(event) => {
                setPaymentId(event.target.value);
                setOffset(0);
              }}
              className="mt-1 w-36 rounded-lg border border-line-strong bg-surface px-3 py-1.5 text-[13px] text-ink placeholder:text-ink-subtle/60"
            />
          </div>

          <div>
            <label
              htmlFor="audit-actor"
              className="block text-[11px] font-medium uppercase tracking-wide text-ink-subtle"
            >
              Actor
            </label>
            <input
              id="audit-actor"
              value={actor}
              placeholder="recoverai-executor"
              onChange={(event) => {
                setActor(event.target.value);
                setOffset(0);
              }}
              className="mt-1 w-44 rounded-lg border border-line-strong bg-surface px-3 py-1.5 text-[13px] text-ink placeholder:text-ink-subtle/60"
            />
          </div>

          {hasFilters && (
            <Button size="sm" onClick={resetFilters}>
              Clear
            </Button>
          )}
        </div>

        <div className="flex items-center gap-3">
          <p className="tabular text-[12.5px] text-ink-subtle" aria-live="polite">
            {query.isLoading
              ? 'Loading…'
              : total === null
                ? 'Count unavailable'
                : `${total.toLocaleString('en-IN')} event${total === 1 ? '' : 's'}`}
          </p>
          <Button onClick={() => void query.refetch()} size="sm">
            Refresh
          </Button>
        </div>
      </div>

      <SectionCard>
        {query.isLoading ? (
          <TableSkeleton rows={10} columns={5} />
        ) : query.isError ? (
          <ErrorState
            title="Could not load the audit log"
            message={
              query.error instanceof ApiError
                ? query.error.operatorMessage
                : 'An unexpected error occurred.'
            }
            onRetry={() => void query.refetch()}
          />
        ) : events.length === 0 ? (
          <EmptyState
            title="No audit activity available."
            description={
              hasFilters
                ? 'No events match these filters. Try clearing them.'
                : 'Events are recorded as RecoverAI diagnoses, authorizes, executes and verifies.'
            }
          />
        ) : (
          <>
            <div className="-mx-5 overflow-x-auto">
              <table className="w-full min-w-[900px] text-left">
                <caption className="sr-only">
                  Audit events, newest first. Every decision RecoverAI recorded.
                </caption>
                <thead>
                  <tr className="border-b border-line text-[11px] uppercase tracking-wide text-ink-subtle">
                    <th scope="col" className="px-5 py-2.5 font-medium">Time</th>
                    <th scope="col" className="px-5 py-2.5 font-medium">Event</th>
                    <th scope="col" className="px-5 py-2.5 font-medium">Actor</th>
                    <th scope="col" className="px-5 py-2.5 font-medium">Payment</th>
                    <th scope="col" className="px-5 py-2.5 font-medium">Case</th>
                    <th scope="col" className="px-5 py-2.5 font-medium">Result</th>
                    <th scope="col" className="px-5 py-2.5 font-medium">Details</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {events.map((event) => {
                    const metadata = safeMetadata(event.metadata);
                    return (
                      <tr key={event.id} className="align-top transition hover:bg-canvas">
                        <td className="whitespace-nowrap px-5 py-3 text-[12.5px] text-ink-subtle">
                          {formatDateTime(event.created_at)}
                        </td>
                        <td className="px-5 py-3">
                          <span
                            className={cx('text-[13px] font-medium', eventTone(event.event_type))}
                          >
                            {humanise(event.event_type)}
                          </span>
                        </td>
                        <td className="px-5 py-3 text-[12.5px] text-ink-muted">{event.actor}</td>
                        <td className="px-5 py-3 text-[12.5px]">
                          {event.payment_id === null ? (
                            <span className="text-ink-subtle">—</span>
                          ) : (
                            <Link
                              to={`/payments/${event.payment_id}`}
                              className="tabular text-ink hover:text-info hover:underline"
                            >
                              {event.payment_id}
                            </Link>
                          )}
                        </td>
                        <td className="px-5 py-3 text-[12.5px]">
                          {event.case_id === null ? (
                            <span className="text-ink-subtle">—</span>
                          ) : (
                            <Link
                              to={`/cases/${event.case_id}`}
                              className="tabular text-ink hover:text-info hover:underline"
                              title={event.case_id}
                            >
                              {event.case_id.slice(0, 12)}…
                            </Link>
                          )}
                        </td>
                        <td className="px-5 py-3 text-[12.5px] text-ink-muted">
                          {event.decision ?? '—'}
                        </td>
                        <td className="px-5 py-3">
                          {metadata.length === 0 ? (
                            <span className="text-[12.5px] text-ink-subtle">—</span>
                          ) : (
                            <dl className="flex flex-wrap gap-x-3 gap-y-1">
                              {metadata.slice(0, 4).map((entry) => (
                                <div key={entry.key} className="flex gap-1 text-[11.5px]">
                                  <dt className="text-ink-subtle">{entry.key}:</dt>
                                  <dd className="max-w-[180px] truncate text-ink-muted">
                                    {entry.value}
                                  </dd>
                                </div>
                              ))}
                            </dl>
                          )}
                        </td>
                      </tr>
                    );
                  })}
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
