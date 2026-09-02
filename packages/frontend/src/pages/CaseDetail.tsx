import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import { api, ApiError } from '../api/client.ts';
import { formatAge, formatDateTime, formatMoney, humanise } from '../lib/format.ts';
import {
  APPROVAL_IS_NOT_EXECUTION,
  NO_BLIND_RETRY,
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
  cx,
} from '../components/primitives.tsx';
import type { Approval, AuditEvent, RecoveryActionRecord, RecoveryCase } from '../types/domain.ts';

/**
 * CASE DETAIL — the screen the whole product rests on
 *
 * It renders FIVE SEPARATE STAGES and never merges them:
 *
 *   1. AI Diagnosis    a recommendation, in the INFO tone. Not permission.
 *   2. Policy          permission, decided deterministically. Not an action.
 *   3. Approval        a human decision that satisfies a GATE. Not authorization.
 *   4. Execution       what the provider said. `SUCCESS` renders as
 *                      "Provider accepted the request" — never "Recovered".
 *   5. Verification    what the evidence proved. The ONLY stage that may say
 *                      recovered.
 *
 * The word "Recovered" appears exactly once as an outcome, and only when both
 * the backend case status is RECOVERED and the verification verdict is
 * VERIFIED. `isRecovered()` enforces that.
 */

/** A numbered stage marker in the lifecycle rail. */
function StageMarker({ index, tone }: { index: number; tone: string }) {
  return (
    <div className="flex shrink-0 flex-col items-center" aria-hidden="true">
      <span
        className={cx(
          'flex h-7 w-7 items-center justify-center rounded-full border text-[12px] font-semibold',
          tone,
        )}
      >
        {index}
      </span>
    </div>
  );
}

function Stage({
  index,
  children,
  last = false,
}: {
  index: number;
  children: React.ReactNode;
  last?: boolean;
}) {
  return (
    <div className="flex gap-4">
      <div className="flex flex-col items-center">
        <StageMarker index={index} tone="border-line-strong bg-surface text-ink-muted" />
        {!last && <span aria-hidden="true" className="mt-1 w-px flex-1 bg-line" />}
      </div>
      <div className={cx('min-w-0 flex-1', last ? 'pb-0' : 'pb-5')}>{children}</div>
    </div>
  );
}


function DiagnosisCard({ recoveryCase }: { recoveryCase: RecoveryCase }) {
  return (
    <SectionCard
      eyebrow="Stage 1 · AI recommendation"
      title="AI Diagnosis"
      description="What the model believes went wrong and what it suggests. This is a recommendation, not authorization."
      tone="info"
    >
      <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Field label="Classification">{humanise(recoveryCase.classification)}</Field>
        <Field label="Recommended action">
          <span className="rounded border border-info/20 bg-info-bg px-1.5 py-0.5 text-[12px] font-medium text-info">
            {recoveryCase.recommended_action}
          </span>
        </Field>
        <Field label="Confidence" mono>
          {(recoveryCase.confidence * 100).toFixed(0)}%
        </Field>
        <Field label="Recoverability" mono>
          {(recoveryCase.recoverability_score * 100).toFixed(0)}%
        </Field>
      </dl>

      {recoveryCase.reason !== '' && (
        <p className="mt-4 rounded-lg border border-line bg-canvas px-3.5 py-2.5 text-[13px] leading-relaxed text-ink-muted">
          {recoveryCase.reason}
        </p>
      )}
    </SectionCard>
  );
}


function PolicyCard({ action }: { action: RecoveryActionRecord | null }) {
  const presentation = policyPresentation(action?.policy_status ?? null);

  return (
    <SectionCard
      eyebrow="Stage 2 · Authorization"
      title="Policy Decision"
      description="Decided by the deterministic policy engine, independently of AI confidence."
      actions={<StatusBadge presentation={presentation} />}
    >
      {action === null ? (
        <p className="text-[13px] text-ink-muted">
          No action has been attempted, so no policy verdict has been recorded. Policy is
          evaluated against current state at execution time — never cached from analysis.
        </p>
      ) : (
        <>
          <dl className="grid gap-4 sm:grid-cols-3">
            <Field label="Decision">{presentation.label}</Field>
            <Field label="Policy version" mono>
              {action.policy_version ?? '—'}
            </Field>
            <Field label="Action authorized">{action.action_type}</Field>
          </dl>
          <p className="mt-4 text-[12.5px] leading-relaxed text-ink-subtle">
            A high-confidence AI recommendation does not imply authorization. Policy is
            re-evaluated against current payment state immediately before any execution.
          </p>
        </>
      )}
    </SectionCard>
  );
}


function ApprovalCard({
  recoveryCase,
  approval,
}: {
  recoveryCase: RecoveryCase;
  approval: Approval | null;
}) {
  const awaiting = recoveryCase.status === 'AWAITING_APPROVAL';

  return (
    <SectionCard
      eyebrow="Stage 3 · Human decision"
      title="Approval"
      description="A person satisfying a policy approval gate. It never authorizes an action by itself."
      actions={
        approval !== null ? (
          <StatusBadge
            presentation={
              approval.decision === 'APPROVED'
                ? { label: 'Approved', tone: 'info', icon: '👤' }
                : { label: 'Rejected', tone: 'danger', icon: '✕' }
            }
          />
        ) : awaiting ? (
          <StatusBadge presentation={{ label: 'Awaiting approval', tone: 'attention', icon: '⏸' }} />
        ) : (
          <StatusBadge presentation={{ label: 'Not required', tone: 'neutral', icon: '—' }} />
        )
      }
    >
      {approval !== null ? (
        <>
          <dl className="grid gap-4 sm:grid-cols-3">
            <Field label="Decision">{approval.decision}</Field>
            <Field label="Actor">{approval.actor}</Field>
            <Field label="Decided">{formatDateTime(approval.created_at)}</Field>
          </dl>
          {approval.reason !== null && (
            <p className="mt-4 rounded-lg border border-line bg-canvas px-3.5 py-2.5 text-[13px] text-ink-muted">
              “{approval.reason}”
            </p>
          )}
          {approval.decision === 'APPROVED' ? (
            <div className="mt-4">
              <Callout tone="info" title="Human approved — execution still subject to policy">
                {APPROVAL_IS_NOT_EXECUTION}
              </Callout>
            </div>
          ) : (
            <div className="mt-4">
              <Callout tone="danger" title="Rejected">
                This case will not be executed. A decision cannot be reversed — re-analysing the
                payment creates a fresh case.
              </Callout>
            </div>
          )}
        </>
      ) : awaiting ? (
        <Callout tone="attention" title="Human approval required">
          Policy gated this action pending a human decision. {APPROVAL_IS_NOT_EXECUTION}
        </Callout>
      ) : (
        <p className="text-[13px] text-ink-muted">
          Policy did not require a human decision for this case.
        </p>
      )}
    </SectionCard>
  );
}


function ExecutionCard({ action }: { action: RecoveryActionRecord | null }) {
  const presentation = executionPresentation(action?.execution_status ?? null);

  return (
    <SectionCard
      eyebrow="Stage 4 · Provider request"
      title="Execution"
      description="What the provider said about our request. This is not proof that money moved."
      actions={action !== null ? <StatusBadge presentation={presentation} /> : undefined}
    >
      {action === null ? (
        <p className="text-[13px] text-ink-muted">No execution has been attempted.</p>
      ) : (
        <>
          <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Field label="Status">{presentation.label}</Field>
            <Field label="Action">{action.action_type}</Field>
            <Field label="Provider">{action.provider ?? '—'}</Field>
            <Field label="Executed">
              {action.executed_at === null ? '—' : formatDateTime(action.executed_at)}
            </Field>
          </dl>

          {/*
            The load-bearing sentence. `SUCCESS` here means the provider took
            the request — nothing more.
          */}
          {action.execution_status === 'SUCCESS' && (
            <p className="mt-4 text-[12.5px] leading-relaxed text-ink-subtle">
              The provider accepted the request. Whether revenue was recovered is established by
              verification below, not by this status.
            </p>
          )}

          {action.execution_status === 'SKIPPED_DUPLICATE' && (
            <p className="mt-4 text-[12.5px] leading-relaxed text-ink-subtle">
              An equivalent action already existed for this case, so the provider was not called
              again. This is idempotency working, not a failure.
            </p>
          )}

          {action.error_message !== null && (
            <p className="mt-4 rounded-lg border border-line bg-canvas px-3.5 py-2.5 text-[12.5px] text-ink-muted">
              {action.error_message}
            </p>
          )}
        </>
      )}
    </SectionCard>
  );
}


function VerificationCard({ action }: { action: RecoveryActionRecord | null }) {
  const status = action?.verification_status ?? null;
  const presentation = verificationPresentation(status);

  return (
    <SectionCard
      eyebrow="Stage 5 · Evidence"
      title="Verification"
      description="What provider evidence proves. Only a VERIFIED verdict counts as recovered revenue."
      actions={<StatusBadge presentation={presentation} />}
    >
      {action === null ? (
        <p className="text-[13px] text-ink-muted">Verification has not run for this case.</p>
      ) : (
        <>
          <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Field label="Verification status">{presentation.label}</Field>
            <Field label="Observed provider state">
              {action.observed_payment_status ?? '—'}
            </Field>
            <Field label="Verified at">
              {action.verified_at === null ? '—' : formatDateTime(action.verified_at)}
            </Field>
            <Field label="Attempts" mono>
              {action.verification_attempts}
            </Field>
          </dl>

          {action.verification_reason !== null && (
            <p className="mt-4 rounded-lg border border-line bg-canvas px-3.5 py-2.5 text-[13px] leading-relaxed text-ink-muted">
              {action.verification_reason}
            </p>
          )}

          {status === 'VERIFIED' && (
            <div className="mt-4">
              <Callout tone="verified" title="Recovery verified">
                Provider evidence confirms {formatMoney(action.amount)} was recovered.
              </Callout>
            </div>
          )}

          {/*
            THE SAFETY CASE. No retry control is rendered here — the backend
            exposes no safe operation for an ambiguous outcome, and offering
            one would invite a double charge.
          */}
          {status === 'UNCONFIRMED' && (
            <div className="mt-4">
              <Callout tone="attention" title="Outcome unconfirmed">
                {NO_BLIND_RETRY}
              </Callout>
            </div>
          )}

          {status === 'NOT_RECOVERED' && (
            <div className="mt-4">
              <Callout tone="danger" title="Not recovered">
                Provider evidence establishes that the revenue was not recovered.
              </Callout>
            </div>
          )}
        </>
      )}
    </SectionCard>
  );
}


function AuditTimeline({ events }: { events: AuditEvent[] }) {
  if (events.length === 0) {
    return <EmptyState title="No audit activity available." />;
  }

  const ordered = [...events].sort(
    (a, b) => Date.parse(b.created_at) - Date.parse(a.created_at),
  );

  return (
    <ol className="space-y-0">
      {ordered.map((event, index) => (
        <li key={event.id} className="flex gap-3">
          <div className="flex flex-col items-center">
            <span
              aria-hidden="true"
              className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-line-strong"
            />
            {index < ordered.length - 1 && (
              <span aria-hidden="true" className="w-px flex-1 bg-line" />
            )}
          </div>
          <div className="min-w-0 flex-1 pb-4">
            <div className="flex flex-wrap items-baseline gap-x-2">
              <p className="text-[13px] font-medium text-ink">{humanise(event.event_type)}</p>
              {event.decision !== null && (
                <span className="rounded border border-line bg-canvas px-1.5 py-0.5 text-[11px] text-ink-muted">
                  {event.decision}
                </span>
              )}
            </div>
            <p className="mt-0.5 text-[12px] text-ink-subtle">
              {event.actor} · {formatDateTime(event.created_at)}
            </p>
          </div>
        </li>
      ))}
    </ol>
  );
}


export function CaseDetail() {
  const { caseId } = useParams<{ caseId: string }>();

  const query = useQuery({
    queryKey: ['case', caseId],
    queryFn: ({ signal }) => api.getCase(caseId!, signal),
    enabled: caseId !== undefined,
  });

  if (query.isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-20 w-full rounded-xl" />
        <Skeleton className="h-40 w-full rounded-xl" />
        <Skeleton className="h-40 w-full rounded-xl" />
      </div>
    );
  }

  if (query.isError) {
    const apiError = query.error instanceof ApiError ? query.error : null;
    return (
      <ErrorState
        title={apiError?.status === 404 ? 'Recovery case not found' : 'Could not load this case'}
        message={apiError?.operatorMessage ?? 'An unexpected error occurred.'}
        onRetry={() => void query.refetch()}
      />
    );
  }

  const detail = query.data!;
  const { case: recoveryCase, payment, actions, approval, audit } = detail;
  const action = latestAction(actions);
  const recovered = isRecovered(recoveryCase.status, actions);

  return (
    <div className="space-y-5">
      <Link to="/cases" className="inline-block text-[13px] text-ink-muted hover:text-ink">
        ← Back to cases
      </Link>

      <div className="rounded-xl border border-line bg-surface px-5 py-4 shadow-[0_1px_2px_rgba(16,24,40,0.04)]">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-ink-subtle">
              Recovery case
            </p>
            <p className="tabular mt-1 text-[20px] font-semibold tracking-tight text-ink">
              {recoveryCase.payment_id}
            </p>
            <p className="mt-1 text-[12.5px] text-ink-subtle">
              Case {recoveryCase.id} · updated {formatAge(recoveryCase.updated_at)}
            </p>
          </div>

          <div className="flex flex-col items-start gap-2 sm:items-end">
            <StatusBadge presentation={casePresentation(recoveryCase.status)} />
            <p className="tabular text-[22px] font-semibold text-ink">
              {formatMoney(recoveryCase.revenue_at_risk)}
            </p>
            <p className="text-[12px] text-ink-subtle">
              {recovered ? 'Verified recovered' : 'At risk'}
            </p>
          </div>
        </div>

        {payment !== null && (
          <dl className="mt-4 grid gap-4 border-t border-line pt-4 sm:grid-cols-3 lg:grid-cols-5">
            <Field label="Payment status">{humanise(payment.status)}</Field>
            <Field label="Currency">{payment.currency}</Field>
            <Field label="Attempts" mono>
              {payment.attempt_count}
            </Field>
            <Field label="Failure reason">
              {payment.failure_reason === null ? '—' : humanise(payment.failure_reason)}
            </Field>
            <Field label="Created">{formatDateTime(payment.created_at)}</Field>
          </dl>
        )}
      </div>

      <div>
        <h2 className="mb-3 text-[13px] font-semibold uppercase tracking-wide text-ink-subtle">
          Recovery lifecycle
        </h2>
        <div>
          <Stage index={1}>
            <DiagnosisCard recoveryCase={recoveryCase} />
          </Stage>
          <Stage index={2}>
            <PolicyCard action={action} />
          </Stage>
          <Stage index={3}>
            <ApprovalCard recoveryCase={recoveryCase} approval={approval} />
          </Stage>
          <Stage index={4}>
            <ExecutionCard action={action} />
          </Stage>
          <Stage index={5} last>
            <VerificationCard action={action} />
          </Stage>
        </div>
      </div>

      {recovered && (
        <Callout tone="verified" title="Recovered">
          This case is recorded as recovered because provider evidence verified the outcome —
          not because an action was executed.
        </Callout>
      )}

      <SectionCard
        title="Audit trail"
        description="Every decision recorded for this payment, newest first."
      >
        <AuditTimeline events={audit} />
      </SectionCard>
    </div>
  );
}
