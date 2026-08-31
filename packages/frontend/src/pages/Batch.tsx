import { useEffect, useRef, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { api, ApiError } from '../api/client.ts';
import { sessionRuns } from '../lib/session-runs.ts';
import type { BatchRun, PaymentStatus } from '../types/domain.ts';
import { Button, Callout, SectionCard } from '../components/primitives.tsx';

/**
 * ============================================================================
 * BATCH RECOVERY
 * ============================================================================
 *
 * THE MOST DANGEROUS SCREEN IN THE PRODUCT. It is the only place an operator
 * can cause real provider requests across a whole population in one click.
 *
 * ---------------------------------------------------------------------------
 * WHY `execute: false` IS SENT EXPLICITLY, ALWAYS
 * ---------------------------------------------------------------------------
 *
 * The backend schema makes `execute` OPTIONAL, and `runBatchRecovery` resolves
 * it as `options.execute ?? true`. An omitted field therefore means EXECUTE.
 * That is a defensible server default — the route is named /runs — but it
 * makes omission the unsafe direction. So this screen never omits the field:
 * a preview sends `execute: false` on the wire, verbatim, every time.
 *
 * ---------------------------------------------------------------------------
 * WHAT PREVIEW ACTUALLY DOES — stated precisely, not reassuringly
 * ---------------------------------------------------------------------------
 *
 * A preview does NOT touch the payment provider. No charge, no reminder, no
 * retry is sent. That is the property that matters most, and a backend
 * integration test asserts the provider call count is zero for a dry run.
 *
 * But a preview is NOT read-only. It runs the real analysis pipeline, which
 * writes recovery cases and audit events to the database. Calling it "a dry
 * run that changes nothing" would be false, so this screen does not. It says
 * what is true: the provider is never contacted, and diagnosis records are
 * created.
 *
 * ---------------------------------------------------------------------------
 * NO AUTOMATIC RETRY
 * ---------------------------------------------------------------------------
 *
 * The API client refuses to retry any non-GET, the QueryClient sets
 * `mutations: { retry: false }`, and this mutation adds no retry of its own.
 * If a run fails ambiguously the operator sees the error and decides — the
 * frontend never re-sends a batch request on its own.
 */

/** Statuses the backend accepts as eligible. Mirrors the backend default. */
const SELECTABLE_STATUSES: PaymentStatus[] = ['failed', 'abandoned'];

const DEFAULT_LIMIT = 25;

export function Batch() {
  const navigate = useNavigate();

  // ---- Request fields: exactly the four in batchRunRequestSchema ----------
  const [merchantId, setMerchantId] = useState('');
  const [statuses, setStatuses] = useState<PaymentStatus[]>(['failed', 'abandoned']);
  const [limit, setLimit] = useState(DEFAULT_LIMIT);

  /*
   * Execute mode is a two-step gate, and the operator must perform both steps
   * deliberately: arm the mode, then confirm in the dialog. Neither is ever
   * pre-set, and both reset after a run.
   */
  const [executeArmed, setExecuteArmed] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const mutation = useMutation({
    // No `retry` key. The client refuses to retry a POST regardless; this is
    // the second lock on the same door.
    mutationFn: ({ execute }: { execute: boolean }) =>
      api.runBatch({
        ...(merchantId.trim() === '' ? {} : { merchant_id: merchantId.trim() }),
        statuses,
        limit,
        // ALWAYS explicit. Never omitted, in either mode.
        execute,
      }),
    onSuccess: (run: BatchRun, variables) => {
      sessionRuns.setBatch(run, variables.execute);
      setExecuteArmed(false);
      setConfirmOpen(false);
      navigate('/batch/results');
    },
    onError: () => {
      // The run is NOT assumed to have failed harmlessly: an ambiguous error
      // may still have executed. The dialog closes, the error is shown, and
      // nothing is re-sent.
      setConfirmOpen(false);
    },
  });

  const running = mutation.isPending;

  const toggleStatus = (status: PaymentStatus) => {
    setStatuses((current) =>
      current.includes(status) ? current.filter((s) => s !== status) : [...current, status],
    );
  };

  // The backend requires a non-empty statuses array; blocking here gives a
  // better message than a 400 would.
  const statusesValid = statuses.length > 0;

  return (
    <div className="space-y-5">
      {/* ---- What a run is, before any control is offered ---- */}
      <Callout tone="info" title="A batch run puts the whole pipeline over a population">
        Every payment is diagnosed, evaluated against policy, and — in execute mode — acted on and
        verified. RecoverAI makes no batch-level decision of its own: the policy engine authorizes
        each action individually, exactly as it does for a single case.
      </Callout>

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_340px]">
        {/* ---- Population ---- */}
        <SectionCard
          title="Population"
          description="Which payments this run considers. These are the only filters the API accepts."
        >
          <div className="space-y-4 pt-1">
            <div>
              <label
                htmlFor="batch-merchant"
                className="block text-[11px] font-medium uppercase tracking-wide text-ink-subtle"
              >
                Merchant
              </label>
              <input
                id="batch-merchant"
                value={merchantId}
                disabled={running}
                placeholder="All merchants"
                onChange={(event) => setMerchantId(event.target.value)}
                className="mt-1 w-full max-w-xs rounded-lg border border-line-strong bg-surface px-3 py-1.5 text-[13px] text-ink placeholder:text-ink-subtle/60 disabled:opacity-50"
              />
              <p className="mt-1 text-[12px] text-ink-subtle">
                Leave blank to consider every merchant.
              </p>
            </div>

            <fieldset disabled={running} className="disabled:opacity-50">
              <legend className="block text-[11px] font-medium uppercase tracking-wide text-ink-subtle">
                Eligible statuses
              </legend>
              <div className="mt-2 flex flex-wrap gap-4">
                {SELECTABLE_STATUSES.map((status) => (
                  <label key={status} className="flex items-center gap-2 text-[13px] text-ink">
                    <input
                      type="checkbox"
                      checked={statuses.includes(status)}
                      onChange={() => toggleStatus(status)}
                      className="h-3.5 w-3.5 rounded border-line-strong"
                    />
                    {status}
                  </label>
                ))}
              </div>
              {!statusesValid && (
                <p className="mt-1.5 text-[12px] text-danger">
                  Select at least one status. The API rejects an empty list.
                </p>
              )}
            </fieldset>

            <div>
              <label
                htmlFor="batch-limit"
                className="block text-[11px] font-medium uppercase tracking-wide text-ink-subtle"
              >
                Limit
              </label>
              <input
                id="batch-limit"
                type="number"
                min={1}
                max={1000}
                value={limit}
                disabled={running}
                onChange={(event) => setLimit(Number(event.target.value))}
                className="tabular mt-1 w-28 rounded-lg border border-line-strong bg-surface px-3 py-1.5 text-[13px] text-ink disabled:opacity-50"
              />
              <p className="mt-1 text-[12px] text-ink-subtle">
                Maximum payments considered. The API caps this at 1,000.
              </p>
            </div>
          </div>
        </SectionCard>

        {/* ---- Mode and actions ---- */}
        <div className="space-y-4">
          <SectionCard title="Mode">
            <div className="space-y-3 pt-1">
              <div className="rounded-lg border border-line bg-canvas px-3.5 py-3">
                <p className="text-[13px] font-semibold text-ink">Preview — the default</p>
                <p className="mt-1 text-[12.5px] leading-relaxed text-ink-muted">
                  Sends <code className="tabular">execute: false</code>. The payment provider is
                  never contacted, so no charge, reminder, or retry is sent.
                </p>
                {/*
                  Deliberately NOT "changes nothing". A preview runs the real
                  analysis, which writes recovery cases and audit events.
                */}
                <p className="mt-2 text-[12.5px] leading-relaxed text-ink-muted">
                  A preview is not read-only: diagnosing a payment creates a recovery case and
                  audit entries. What it never does is act on the provider.
                </p>
              </div>

              <div className="rounded-lg border border-attention/30 bg-attention-bg px-3.5 py-3">
                <p className="text-[13px] font-semibold text-attention">Execute — real actions</p>
                <p className="mt-1 text-[12.5px] leading-relaxed text-attention/90">
                  Sends <code className="tabular">execute: true</code>. Authorized actions are sent
                  to the payment provider and then verified. Requires arming and confirmation.
                </p>
              </div>
            </div>
          </SectionCard>

          <div className="space-y-2.5">
            <Button
              variant="primary"
              disabled={running || !statusesValid}
              onClick={() => mutation.mutate({ execute: false })}
            >
              {running && !executeArmed ? 'Running preview…' : 'Preview Recovery Run'}
            </Button>

            {/*
              Arming is a separate, explicit act. The checkbox starts false on
              every mount and resets after each run, so an execute run can
              never be one stray click away.
            */}
            <label className="flex items-start gap-2 rounded-lg border border-line px-3 py-2.5 text-[12.5px] text-ink">
              <input
                type="checkbox"
                checked={executeArmed}
                disabled={running}
                onChange={(event) => setExecuteArmed(event.target.checked)}
                className="mt-0.5 h-3.5 w-3.5 rounded border-line-strong"
              />
              <span>I intend to execute real recovery actions against the payment provider.</span>
            </label>

            <Button
              variant="danger"
              disabled={!executeArmed || running || !statusesValid}
              onClick={() => setConfirmOpen(true)}
            >
              Execute Recovery Run
            </Button>

            {running && (
              <p role="status" className="text-[12.5px] text-ink-muted">
                Request in flight. RecoverAI processes payments sequentially, so a large run takes
                time. Do not close this tab — the backend does not store the result.
              </p>
            )}
          </div>
        </div>
      </div>

      {/* ---- Errors: shown, never swallowed, never auto-retried ---- */}
      {mutation.isError && (
        <div role="alert">
          <Callout tone="danger" title="The batch run failed">
            {mutation.error instanceof ApiError
              ? mutation.error.operatorMessage
              : 'The request could not be completed.'}{' '}
            No outcome is assumed. RecoverAI has not retried this request and will not do so
            automatically — check the audit log before running again.
          </Callout>
        </div>
      )}

      {/* ---- Confirmation: the last gate before a real execution ---- */}
      {confirmOpen && (
        <ConfirmExecute
          statuses={statuses}
          limit={limit}
          merchantId={merchantId.trim()}
          pending={running}
          onCancel={() => setConfirmOpen(false)}
          onConfirm={() => mutation.mutate({ execute: true })}
        />
      )}
    </div>
  );
}

/**
 * The execute confirmation.
 *
 * It restates the ACTUAL consequences rather than asking a vague "are you
 * sure": which population, what will be contacted, and what the system will
 * not do afterwards. A confirmation that does not tell the operator what they
 * are authorizing is worse than none, because it manufactures consent.
 */
function ConfirmExecute({
  statuses,
  limit,
  merchantId,
  pending,
  onCancel,
  onConfirm,
}: {
  statuses: PaymentStatus[];
  limit: number;
  merchantId: string;
  pending: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  /*
   * The element that opened the dialog. Focus returns here on close, so a
   * keyboard operator is not dumped back at the top of the document with no
   * idea where the dialog they just dismissed used to be.
   */
  const triggerRef = useRef<Element | null>(null);

  useEffect(() => {
    triggerRef.current = document.activeElement;

    /*
     * Focus lands on CANCEL, not confirm. Both are reachable in one key press,
     * but the one under the cursor when the dialog opens must be the harmless
     * one — an operator who opens this and hits Enter reflexively must not
     * thereby authorize provider requests across a whole population.
     */
    const cancel = dialogRef.current?.querySelector<HTMLElement>('[data-autofocus]');
    cancel?.focus();

    return () => {
      const trigger = triggerRef.current;
      if (trigger instanceof HTMLElement && document.contains(trigger)) trigger.focus();
    };
  }, []);

  /*
   * Focus trap + Escape. Implemented directly rather than pulling in a focus-
   * trap library: this is the only dialog in the product, and a dependency
   * would be more code to audit than the fifteen lines it replaces.
   */
  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      // Escape is a CANCEL, never a confirm. It is also allowed while a run is
      // in flight: closing the dialog does not abort the request, and pinning
      // the operator inside a modal they cannot dismiss helps nobody.
      event.stopPropagation();
      onCancel();
      return;
    }

    if (event.key !== 'Tab') return;

    const focusable = dialogRef.current?.querySelectorAll<HTMLElement>(
      'button:not([disabled]), [href], input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])',
    );
    if (focusable === undefined || focusable.length === 0) return;

    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;
    const active = document.activeElement;

    // Wrap at both ends, so Tab and Shift+Tab cycle within the dialog rather
    // than escaping to the page behind it.
    if (event.shiftKey && (active === first || !dialogRef.current?.contains(active))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 px-4">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-execute-title"
        aria-describedby="confirm-execute-description"
        onKeyDown={onKeyDown}
        className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-xl border border-line bg-surface p-5 shadow-xl"
      >
        <h2 id="confirm-execute-title" className="text-[16px] font-semibold text-ink">
          Execute real recovery actions?
        </h2>

        <p
          id="confirm-execute-description"
          className="mt-2 text-[13px] leading-relaxed text-ink-muted"
        >
          This sends <code className="tabular">execute: true</code>. Every payment the policy
          engine authorizes will have a recovery action sent to the payment provider, and the
          outcome will then be verified.
        </p>

        <dl className="mt-4 space-y-1.5 rounded-lg border border-line bg-canvas px-3.5 py-3 text-[12.5px]">
          <div className="flex justify-between gap-4">
            <dt className="text-ink-subtle">Merchant</dt>
            <dd className="tabular text-ink">{merchantId === '' ? 'All merchants' : merchantId}</dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-ink-subtle">Statuses</dt>
            <dd className="text-ink">{statuses.join(', ')}</dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-ink-subtle">Up to</dt>
            <dd className="tabular text-ink">{limit.toLocaleString('en-IN')} payments</dd>
          </div>
        </dl>

        <ul className="mt-4 space-y-1.5 text-[12.5px] leading-relaxed text-ink-muted">
          <li>
            <span aria-hidden="true">·</span> Policy is re-evaluated per payment. An action it does
            not authorize is not executed, whatever this dialog says.
          </li>
          <li>
            <span aria-hidden="true">·</span> Payments that already have a completed action are
            skipped, so re-running does not act twice.
          </li>
          <li>
            <span aria-hidden="true">·</span> If a request fails ambiguously, RecoverAI records it
            as unconfirmed and does not retry it.
          </li>
        </ul>

        <div className="mt-5 flex justify-end gap-2.5">
          <Button onClick={onCancel} disabled={pending} autoFocus>
            Cancel
          </Button>
          <Button variant="danger" onClick={onConfirm} disabled={pending}>
            {pending ? 'Executing…' : 'Yes, execute now'}
          </Button>
        </div>
      </div>
    </div>
  );
}
