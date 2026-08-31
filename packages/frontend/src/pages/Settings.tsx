import { useQuery } from '@tanstack/react-query';
import { api, ApiError } from '../api/client.ts';
import { formatMoney } from '../lib/format.ts';
import {
  Callout,
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
  const { policy, rateLimit, dataset } = config;

  return (
    <div className="space-y-5">
      {/* ---- The read-only statement, first thing on the page ---- */}
      <Callout tone="info" title="Read-only configuration">
        These values are set through environment variables and applied at startup. RecoverAI
        exposes no API for changing them, so this page displays them and nothing more.
      </Callout>

      {/* ---- Recovery policy ---- */}
      <SectionCard
        title="Recovery policy"
        description="The deterministic thresholds the policy engine authorizes against. The AI cannot widen any of them."
      >
        <ConfigRow
          label="Maximum retry attempts"
          value={String(policy.maxRetryAttempts)}
          description="Hard ceiling on automated retries per payment. Exceeding it blocks the action outright."
        />
        <ConfigRow
          label="Automated amount limit"
          value={formatMoney(policy.maxAutomatedAmount)}
          description="Above this, an action is gated on human approval rather than executed automatically."
        />
        <ConfigRow
          label="High-value threshold"
          value={formatMoney(policy.highValueThreshold)}
          description="At or above this amount a human must approve before anything executes."
        />
        <ConfigRow
          label="Minimum confidence"
          value={`${(policy.minRecoveryConfidence * 100).toFixed(0)}%`}
          description="AI confidence below this is never auto-executed."
        />
        <ConfigRow
          label="Retry cooldown"
          value={formatDuration(policy.retryCooldownSeconds)}
          description="Minimum interval between successive retries of the same payment."
        />
        <ConfigRow
          label="Recovery window"
          value={`${policy.recoveryWindowHours}h`}
          description="Checkout recovery is only valid within this window of the payment being created."
        />
        <ConfigRow
          label="Reminders per payment"
          value={String(policy.maxRemindersPerPayment)}
          description="Cap on reminder messages sent for one payment before approval is required."
        />
      </SectionCard>

      {/* ---- Operational limits ---- */}
      <SectionCard
        title="Operational limits"
        description="HTTP-level protections. These bound abuse; they never authorize an action."
      >
        <ConfigRow
          label="Rate limiting"
          value={rateLimit.enabled ? 'Enabled' : 'Disabled'}
          description="Bounds how many requests one client may make. A brute-force guard, not authorization."
        />
        <ConfigRow
          label="Request limit"
          value={`${rateLimit.max} / ${Math.round(rateLimit.windowMs / 1000)}s`}
          description="Per client IP. In-process only — N replicas permit N times this limit."
        />
        <ConfigRow
          label="API authentication"
          value={config.auth.enabled ? 'Enabled' : 'Disabled'}
          description="Controls who may call the API. It never decides which recovery actions are permitted."
        />
      </SectionCard>

      {/* ---- Providers ---- */}
      <SectionCard
        title="Providers"
        description="Configured integrations. Credential values are never returned by the API."
      >
        <ConfigRow
          label="AI provider"
          value={config.ai.provider}
          description={
            config.ai.model === undefined
              ? 'Produces the diagnosis. It recommends only — it can never authorize or execute.'
              : `Model ${config.ai.model}. It recommends only — it can never authorize or execute.`
          }
        />
        <ConfigRow
          label="Payment provider"
          value={`${config.payments.provider} (${config.payments.mode})`}
          description="Performs recovery actions. RecoverAI refuses to start with live credentials."
        />
      </SectionCard>

      {/* ---- Dataset ---- */}
      <SectionCard
        title="Synthetic dataset"
        description="Generation parameters for the reproducible development dataset."
      >
        <ConfigRow
          label="Seed"
          value={String(dataset.seed)}
          description="The same seed produces a byte-identical dataset on every run."
        />
        <ConfigRow
          label="Record count"
          value={dataset.recordCount.toLocaleString('en-IN')}
          description="Payments generated per run."
        />
        <ConfigRow
          label="Evaluation split"
          value={`${(dataset.evalSplit * 100).toFixed(0)}%`}
          description="Fraction held out for scoring model quality against ground truth."
        />
      </SectionCard>

      <p className="text-[12px] leading-relaxed text-ink-subtle">
        Changing any of these requires updating the environment and restarting the service.
        Policy values are deliberately configuration rather than code so they can be tuned
        without changing the engine that enforces them.
      </p>
    </div>
  );
}
