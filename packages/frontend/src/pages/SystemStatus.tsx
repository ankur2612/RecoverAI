import { useQuery } from '@tanstack/react-query';
import { api, ApiError } from '../api/client.ts';
import { formatDateTime, humanise } from '../lib/format.ts';
import {
  Button,
  Callout,
  ErrorState,
  SectionCard,
  Skeleton,
  StatusBadge,
} from '../components/primitives.tsx';
import type { StatusPresentation } from '../lib/status.ts';

/**
 * System status.
 *
 * SECRETS NEVER REACH THIS SCREEN, by construction rather than by filtering.
 * `GET /api/health` returns `redactedConfig()`, which reduces every credential
 * to a BOOLEAN PRESENCE FLAG server-side — there is no key, token, or database
 * URL in the payload to leak. This page renders those flags as
 * "Configured / Not configured" and never attempts to show a value.
 *
 * It also refuses to overstate what a flag means: a present credential proves
 * a deployment is *configured*, not that the provider is reachable. Nothing
 * here claims a third party is operational on the strength of a config flag.
 */

function flagPresentation(present: boolean, labels?: { on: string; off: string }): StatusPresentation {
  return present
    ? { label: labels?.on ?? 'Configured', tone: 'verified', icon: '✓' }
    : { label: labels?.off ?? 'Not configured', tone: 'neutral', icon: '○' };
}

/** One status row: label, badge, and an explanatory note. */
function StatusRow({
  label,
  presentation,
  detail,
}: {
  label: string;
  presentation: StatusPresentation;
  detail?: string;
}) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-line py-3 last:border-b-0">
      <div className="min-w-0">
        <p className="text-[13px] font-medium text-ink">{label}</p>
        {detail !== undefined && (
          <p className="mt-0.5 text-[12px] leading-relaxed text-ink-subtle">{detail}</p>
        )}
      </div>
      <div className="shrink-0">
        <StatusBadge presentation={presentation} />
      </div>
    </div>
  );
}

export function SystemStatus() {
  const query = useQuery({
    queryKey: ['health'],
    queryFn: ({ signal }) => api.health(signal),
    refetchInterval: 30_000,
  });

  if (query.isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-28 w-full rounded-xl" />
        <Skeleton className="h-56 w-full rounded-xl" />
        <Skeleton className="h-56 w-full rounded-xl" />
      </div>
    );
  }

  if (query.isError) {
    return (
      <ErrorState
        title="Cannot reach the RecoverAI API"
        message={
          query.error instanceof ApiError
            ? query.error.operatorMessage
            : 'The backend is not responding. Check that it is running.'
        }
        onRetry={() => void query.refetch()}
      />
    );
  }

  const health = query.data!;
  const { config } = health;

  const serviceOk = health.status === 'ok';

  return (
    <div className="space-y-5">
      <div className="rounded-xl border border-line bg-surface px-5 py-4 shadow-[0_1px_2px_rgba(16,24,40,0.04)]">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-wider text-ink-subtle">
              Overall
            </p>
            <p className="mt-1 flex items-center gap-2 text-[18px] font-semibold tracking-tight text-ink">
              <span
                aria-hidden="true"
                className={`h-2 w-2 rounded-full ${serviceOk ? 'bg-verified' : 'bg-attention'}`}
              />
              {serviceOk ? 'Operational' : 'Degraded'}
            </p>
            <p className="mt-1 text-[12.5px] text-ink-subtle">
              Checked {formatDateTime(health.timestamp)}
            </p>
          </div>
          <Button size="sm" onClick={() => void query.refetch()}>
            Re-check
          </Button>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <SectionCard title="Service" description="The RecoverAI backend process.">
          <StatusRow
            label="API"
            presentation={
              serviceOk
                ? { label: 'Operational', tone: 'verified', icon: '✓' }
                : { label: 'Degraded', tone: 'attention', icon: '!' }
            }
            detail={`${health.service} · version ${health.version}`}
          />
          <StatusRow
            label="Environment"
            presentation={{
              label: humanise(config.nodeEnv),
              tone: config.nodeEnv === 'production' ? 'info' : 'neutral',
              icon: config.nodeEnv === 'production' ? '◆' : '◇',
            }}
            detail={`Listening on port ${config.port} · log level ${config.logLevel}`}
          />
        </SectionCard>

        <SectionCard title="Database" description="PostgreSQL connectivity.">
          <StatusRow
            label="Reachability"
            presentation={
              health.database.reachable
                ? { label: 'Reachable', tone: 'verified', icon: '✓' }
                : { label: 'Unreachable', tone: 'danger', icon: '✕' }
            }
            detail={
              health.database.reachable
                ? 'A test query succeeded.'
                : 'The backend could not query the database.'
            }
          />
          <StatusRow
            label="Connection configured"
            presentation={flagPresentation(config.databaseConfigured)}
            /* A flag, deliberately — the URL itself never leaves the server. */
            detail="Presence flag only. The connection string is never sent to the browser."
          />
          {!health.database.reachable && health.database.error !== undefined && (
            <div className="mt-3">
              <Callout tone="danger" title="Database error">
                {health.database.error}
              </Callout>
            </div>
          )}
        </SectionCard>
      </div>

      <SectionCard
        title="Security posture"
        description="How this deployment is protected. Values are never shown — only whether they are set."
      >
        <StatusRow
          label="API authentication"
          presentation={
            config.auth.enabled
              ? { label: 'Enabled', tone: 'verified', icon: '✓' }
              : { label: 'Disabled', tone: 'attention', icon: '!' }
          }
          detail={
            config.auth.enabled
              ? 'Every route except /api/health requires a token.'
              : 'Every route is publicly reachable. Expected locally; a production deployment must enable it.'
          }
        />
        <StatusRow
          label="API token"
          presentation={flagPresentation(config.auth.credentialPresent, {
            on: 'Configured',
            off: 'Not set',
          })}
          detail="Presence flag only. The token itself is never returned by the API."
        />
        <StatusRow
          label="Rate limiting"
          presentation={
            config.rateLimit.enabled
              ? { label: 'Enabled', tone: 'verified', icon: '✓' }
              : { label: 'Disabled', tone: 'attention', icon: '!' }
          }
          detail={
            config.rateLimit.enabled
              ? `${config.rateLimit.max} requests per ${Math.round(config.rateLimit.windowMs / 1000)}s per client. In-process only.`
              : 'Requests are not throttled.'
          }
        />
      </SectionCard>

      {/*
        Stated before the provider list: an operator reading a dashboard full of
        executions and verified outcomes has no other way to know they are
        simulated. Either provider being mocked is enough, so the text names
        which one rather than implying both.
      */}
      {config.simulated && (
        <Callout tone="attention" title="Simulation mode — one or more providers are simulated">
          {config.payments.provider === 'mock' && (
            <>
              Recovery actions are simulated: nothing shown as executed or verified reached a
              payment provider, and no money has moved.{' '}
            </>
          )}
          {config.ai.provider === 'mock' && (
            <>Diagnoses come from a deterministic rule-based provider, not a model.</>
          )}
        </Callout>
      )}

      <SectionCard
        title="Providers"
        description="Which integrations this deployment is configured to use."
      >
        <StatusRow
          label="AI provider"
          presentation={{
            label: config.ai.provider === 'mock' ? 'Mock (deterministic)' : config.ai.provider,
            tone: config.ai.provider === 'mock' ? 'neutral' : 'info',
            icon: config.ai.provider === 'mock' ? '○' : '◆',
          }}
          detail={
            config.ai.model === undefined
              ? 'No model is reported for this provider.'
              : `Model ${config.ai.model}`
          }
        />
        <StatusRow
          label="AI credential"
          presentation={flagPresentation(config.ai.credentialPresent)}
          /*
            Deliberately does NOT say the provider is operational: a present
            key proves configuration, not reachability.
          */
          detail="Presence flag only. Configured does not mean the provider has been contacted."
        />
        <StatusRow
          label="Payment provider"
          presentation={{
            label:
              config.payments.provider === 'mock'
                ? 'Mock (simulated)'
                : config.payments.provider,
            tone: config.payments.provider === 'mock' ? 'neutral' : 'info',
            icon: config.payments.provider === 'mock' ? '○' : '◆',
          }}
          detail="Which integration performs recovery actions."
        />
        <StatusRow
          label="Payment mode"
          presentation={{
            label: config.payments.mode === 'test' ? 'TEST MODE' : String(config.payments.mode),
            tone: 'verified',
            icon: '✓',
          }}
          detail="RecoverAI refuses to start with live payment credentials."
        />
        <StatusRow
          label="Payment credential"
          presentation={flagPresentation(config.payments.credentialPresent)}
          detail="Presence flag only. The key and secret never reach the browser."
        />
      </SectionCard>

      <p className="text-[12px] leading-relaxed text-ink-subtle">
        Every credential above is reported by the backend as a boolean presence flag. No key,
        token, secret, or connection string is included in the health response, so none can be
        displayed here.
      </p>
    </div>
  );
}
