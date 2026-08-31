import { useState, type FormEvent, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError, tokenStore } from '../api/client.ts';
import { Button, Callout } from './primitives.tsx';

/**
 * Authentication gate.
 *
 * The backend uses ONE SHARED TOKEN. There are no user accounts, so this
 * screen deliberately does not present a username field or a "profile" — that
 * would imply an accountability the system does not provide.
 *
 * TOKEN STORAGE TRADEOFF, stated plainly rather than buried:
 * the token lives in sessionStorage. Any token reachable by browser
 * JavaScript is exposed by an XSS; sessionStorage dies with the tab, which
 * shortens the window but does not close it. This is an internal
 * operator-console posture, not a production auth model.
 */

/**
 * Whether authentication is required at all.
 *
 * The backend may run with AUTH_ENABLED=false locally. /api/health is public,
 * so it reports the posture without a credential — meaning the UI can skip
 * the token prompt entirely when the API is open.
 */
function useAuthPosture() {
  return useQuery({
    queryKey: ['auth-posture'],
    queryFn: async ({ signal }) => {
      const health = await api.health(signal);
      return {
        authRequired: health.config.auth.enabled,
        reachable: true,
      };
    },
    retry: 1,
    staleTime: 30_000,
  });
}

function TokenForm({ onAuthenticated }: { onAuthenticated: () => void }) {
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const token = value.trim();
    if (token === '') {
      setError('Enter the API token to continue.');
      return;
    }

    setChecking(true);
    setError(null);
    tokenStore.set(token);

    try {
      // Validate against a protected route: /api/health is public and would
      // succeed with any token, proving nothing.
      await api.listCases({ limit: 1 });
      onAuthenticated();
    } catch (caught) {
      tokenStore.clear();
      setError(
        caught instanceof ApiError
          ? caught.operatorMessage
          : 'Could not verify the token. Check that the backend is running.',
      );
    } finally {
      setChecking(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-canvas px-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex items-center gap-2.5">
          <span
            aria-hidden="true"
            className="flex h-9 w-9 items-center justify-center rounded-xl bg-ink text-[15px] font-bold text-white"
          >
            R
          </span>
          <div>
            <p className="text-[17px] font-semibold tracking-tight text-ink">RecoverAI</p>
            <p className="text-[12.5px] text-ink-muted">Recovery operations console</p>
          </div>
        </div>

        <form
          onSubmit={submit}
          className="rounded-xl border border-line bg-surface p-5 shadow-[0_1px_2px_rgba(16,24,40,0.04)]"
        >
          <label htmlFor="api-token" className="block text-[13px] font-medium text-ink">
            API token
          </label>
          <p className="mt-1 text-[12.5px] leading-relaxed text-ink-muted">
            RecoverAI uses a single shared token. There are no individual accounts, so
            actions are recorded against an authenticated operator rather than a person.
          </p>

          <input
            id="api-token"
            type="password"
            autoComplete="off"
            value={value}
            onChange={(event) => setValue(event.target.value)}
            placeholder="Paste API_AUTH_TOKEN"
            aria-describedby={error === null ? undefined : 'token-error'}
            aria-invalid={error !== null}
            className="mt-3 w-full rounded-lg border border-line-strong bg-canvas px-3 py-2 text-[13px] text-ink placeholder:text-ink-subtle/70"
          />

          {error !== null && (
            <p id="token-error" role="alert" className="mt-2 text-[12.5px] text-danger">
              {error}
            </p>
          )}

          <div className="mt-4">
            <Button type="submit" variant="primary" disabled={checking}>
              {checking ? 'Verifying…' : 'Continue'}
            </Button>
          </div>

          <p className="mt-4 border-t border-line pt-3 text-[11.5px] leading-relaxed text-ink-subtle">
            Stored in this tab only and cleared when it closes. The token is never placed in a
            URL or a log.
          </p>
        </form>
      </div>
    </div>
  );
}

export function AuthGate({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const posture = useAuthPosture();
  const [hasToken, setHasToken] = useState(() => tokenStore.get() !== null);

  if (posture.isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-canvas">
        <p className="text-[13px] text-ink-muted">Connecting to RecoverAI…</p>
      </div>
    );
  }

  if (posture.isError) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-canvas px-4">
        <div className="w-full max-w-md">
          <Callout tone="danger" title="Cannot reach the RecoverAI API">
            The backend is not responding. Start it with <code>npm run dev</code> in
            packages/backend, then reload this page.
          </Callout>
        </div>
      </div>
    );
  }

  // Auth disabled server-side: prompting for a token would be theatre.
  if (posture.data?.authRequired === false) return <>{children}</>;

  if (!hasToken) {
    return (
      <TokenForm
        onAuthenticated={() => {
          setHasToken(true);
          void queryClient.invalidateQueries();
        }}
      />
    );
  }

  return <>{children}</>;
}
