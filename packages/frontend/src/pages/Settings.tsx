import { useQuery } from '@tanstack/react-query';
import { api, ApiError } from '../api/client.ts';
import { formatMoney } from '../lib/format.ts';
import {
  Callout,
  cx,
  ErrorState,
  SectionCard,
  Skeleton,
} from '../components/primitives.tsx';

/**
 * Settings — INFORMATIONAL ONLY.
 *
 * There is no write endpoint for configuration, so there are no inputs and no
 * Save button. A disabled form or a button that silently does nothing would
 * imply a capability the system does not have; showing the values plainly and
 * saying where they come from is the honest alternative.
 *
 * Every value below is read from `GET /api/health`'s redactedConfig(), which
 * contains thresholds and flags — never a credential.
 */

/** One configuration row with its meaning and effect. */
function ConfigRow({
  label,
  value,
  description,
}: {
  label: string;
  value: string;
  description: string;
}) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 border-b border-line py-3 last:border-b-0">
      <div className="min-w-[240px] flex-1">
        <p className="text-[13px] font-medium text-ink">{label}</p>
        <p className="mt-0.5 text-[12px] leading-relaxed text-ink-subtle">{description}</p>
      </div>
      <p className="tabular shrink-0 text-[14px] font-semibold text-ink">{value}</p>
    </div>
  );
}

function formatDuration(seconds: number): string {
  if (seconds % 3600 === 0) return `${seconds / 3600}h`;
  if (seconds % 60 === 0) return `${seconds / 60}m`;
  return `${seconds}s`;
}

export function Settings() {
  const query = useQuery({
    queryKey: ['health'],
    queryFn: ({ signal }) => api.health(signal),
  });

  if (query.isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-16 w-full rounded-xl" />
        <Skeleton className="h-72 w-full rounded-xl" />
        <Skeleton className="h-56 w-full rounded-xl" />
      </div>
    );
  }

  if (query.isError) {
    return (
      <ErrorState
        title="Could not load configuration"
        message={
          query.error instanceof ApiError
            ? query.error.operatorMessage
            : 'The backend is not responding.'
        }
        onRetry={() => void query.refetch()}
      />
    );
  }

  const { config } = query.data!;
  const { policy } = config;
  const healthy = query.data!.status === 'ok';

  return (
    <div className="space-y-5">
      {config.demoMode === true && (
        <div className="rounded-xl border border-verified/30 bg-verified/[0.07] p-4">
          <div className="flex items-center gap-2">
            <span aria-hidden="true" className="h-2 w-2 rounded-full bg-verified" />
            <p className="text-[13px] font-semibold text-ink">Demo Mode active</p>
          </div>
          <p className="mt-1.5 text-[12.5px] leading-relaxed text-ink-muted">
            This demo uses simulated payment data. No real payments, customers, Razorpay
            accounts, or money transfers are involved.
          </p>
        </div>
      )}

      <SectionCard title="System status">
        <div className="flex items-center gap-2 py-1">
          <span
            aria-hidden="true"
            className={cx('h-2 w-2 rounded-full', healthy ? 'bg-verified' : 'bg-attention')}
          />
          <p className="text-[13px] font-medium text-ink">
            {healthy ? 'Operational' : 'Degraded'}
          </p>
        </div>
        <p className="pb-1 text-[12.5px] text-ink-muted">
          {healthy
            ? 'All RecoverAI services are running normally.'
            : 'Some services are not responding normally.'}
        </p>
      </SectionCard>

      <SectionCard
        title="Recovery policy"
        description="The limits every recovery action is checked against."
      >
        <ConfigRow
          label="Maximum retry attempts"
          value={String(policy.maxRetryAttempts)}
          description="Maximum automatic retry attempts allowed per payment."
        />
        <ConfigRow
          label="Automated amount limit"
          value={formatMoney(policy.maxAutomatedAmount)}
          description="Above this amount, recovery needs human approval."
        />
        <ConfigRow
          label="High-value approval threshold"
          value={formatMoney(policy.highValueThreshold)}
          description="At or above this amount, a human must approve first."
        />
        <ConfigRow
          label="Minimum AI confidence"
          value={`${(policy.minRecoveryConfidence * 100).toFixed(0)}%`}
          description="Recommendations below this are never run automatically."
        />
        <ConfigRow
          label="Retry cooldown"
          value={formatDuration(policy.retryCooldownSeconds)}
          description="Minimum wait between retries of the same payment."
        />
        <ConfigRow
          label="Recovery window"
          value={`${policy.recoveryWindowHours}h`}
          description="How long after a payment recovery may still be attempted."
        />
      </SectionCard>

      {/*
        Providers, stated as capability rather than implementation. The section
        keeps the product's core claim — the AI recommends and never authorizes
        — which is the one thing a reader of this page must not miss.
      */}
      <SectionCard title="Providers">
        <ConfigRow
          label="AI provider"
          value="Active"
          description="Recovery Engine. It recommends only — it can never authorize or execute."
        />
        <ConfigRow
          label="Payment processing"
          value={config.demoMode === true ? 'Demo environment' : 'Active'}
          description="Carries out approved recovery actions."
        />
      </SectionCard>

      <Callout tone="info" title="Read-only configuration">
        These values are set when the service starts and cannot be changed from this page.
      </Callout>
    </div>
  );
}
