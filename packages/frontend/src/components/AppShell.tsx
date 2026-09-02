import { useEffect, useState, type ReactNode } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client.ts';
import { cx } from './primitives.tsx';

/**
 * The application shell: persistent sidebar, topbar, and content region.
 *
 * Navigation lists every planned screen. Routes not yet built are marked
 * `pending` and render as disabled rather than being hidden — an operator can
 * see the shape of the product, and a dead link is worse than an honest
 * "coming soon".
 */

interface NavItem {
  label: string;
  to: string;
  icon: string;
  pending?: boolean;
}

const PRIMARY_NAV: NavItem[] = [
  { label: 'Overview', to: '/', icon: '◫' },
  { label: 'Recovery Cases', to: '/cases', icon: '◧' },
  { label: 'Approvals', to: '/approvals', icon: '⏸' },
  { label: 'Batch Recovery', to: '/batch', icon: '⇉' },
  { label: 'Batch Results', to: '/batch/results', icon: '▤' },
  { label: 'Payments', to: '/payments', icon: '₹' },
  { label: 'Analytics', to: '/analytics', icon: '◔' },
  { label: 'Audit Log', to: '/audit', icon: '☰' },
  { label: 'Sweeper', to: '/sweeper', icon: '↻' },
];

const SECONDARY_NAV: NavItem[] = [
  { label: 'Settings', to: '/settings', icon: '⚙' },
  { label: 'System Status', to: '/status', icon: '◈' },
];

/** Page titles and descriptions, keyed by route. */
export const PAGE_META: Record<string, { title: string; description: string }> = {
  '/': {
    title: 'Recovery Overview',
    description: 'Monitor payment recovery performance and outstanding actions.',
  },
  '/cases': {
    title: 'Recovery Cases',
    description: 'Review diagnosed payment failures and their recovery state.',
  },
  '/payments': {
    title: 'Payments',
    description: 'Every ingested payment event and its current status.',
  },
  '/analytics': {
    title: 'Recovery Analytics',
    description: 'Aggregate recovery performance. Only verified outcomes count as recovered.',
  },
  '/audit': {
    title: 'Audit Log',
    description: 'Every decision RecoverAI recorded, newest first.',
  },
  '/approvals': {
    title: 'Approvals',
    description: 'Human decisions required before eligible recovery actions can proceed.',
  },
  '/batch': {
    title: 'Batch Recovery',
    description: 'Run the recovery pipeline over a population. Preview does not contact the provider.',
  },
  '/batch/results': {
    title: 'Batch Results',
    description: 'The result of the run started in this browser tab. The backend stores no run history.',
  },
  '/sweeper': {
    title: 'Sweeper',
    description: 'Resolve actions stranded by a crash, by observation. Never by retry.',
  },
  '/status': {
    title: 'System Status',
    description: 'Service health, database reachability, and configuration posture.',
  },
  '/settings': {
    title: 'Settings',
    description: 'Read-only operational configuration applied at startup.',
  },
};

function NavSection({ items, onNavigate }: { items: NavItem[]; onNavigate: () => void }) {
  return (
    <ul className="space-y-0.5">
      {items.map((item) => (
        <li key={item.to}>
          {item.pending === true ? (
            <span
              aria-disabled="true"
              title="Not built yet"
              className="flex cursor-not-allowed items-center gap-2.5 rounded-lg px-3 py-2 text-[13px] text-ink-subtle/60"
            >
              <span aria-hidden="true" className="w-4 text-center">
                {item.icon}
              </span>
              {item.label}
              <span className="ml-auto text-[10px] uppercase tracking-wide">soon</span>
            </span>
          ) : (
            <NavLink
              to={item.to}
              end={item.to === '/'}
              onClick={onNavigate}
              className={({ isActive }) =>
                cx(
                  'flex items-center gap-2.5 rounded-lg px-3 py-2 text-[13px] transition',
                  isActive
                    ? 'bg-ink/[0.06] font-medium text-ink'
                    : 'text-ink-muted hover:bg-ink/[0.03] hover:text-ink',
                )
              }
            >
              <span aria-hidden="true" className="w-4 text-center">
                {item.icon}
              </span>
              {item.label}
            </NavLink>
          )}
        </li>
      ))}
    </ul>
  );
}

/** Live health indicator. Read-only; polls slowly so it is never noisy. */
function HealthIndicator() {
  const { data, isError } = useQuery({
    queryKey: ['health'],
    queryFn: ({ signal }) => api.health(signal),
    refetchInterval: 60_000,
    retry: 1,
  });

  const state = isError
    ? { label: 'Unreachable', tone: 'bg-danger', text: 'text-danger' }
    : data === undefined
      ? { label: 'Checking', tone: 'bg-neutral', text: 'text-ink-subtle' }
      : data.status === 'ok'
        ? { label: 'Operational', tone: 'bg-verified', text: 'text-ink-muted' }
        : { label: 'Degraded', tone: 'bg-attention', text: 'text-attention' };

  return (
    <span className={cx('inline-flex items-center gap-1.5 text-[12px]', state.text)}>
      <span aria-hidden="true" className={cx('h-1.5 w-1.5 rounded-full', state.tone)} />
      <span className="hidden sm:inline">{state.label}</span>
      <span className="sr-only">System status: {state.label}</span>
    </span>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const location = useLocation();
  const meta = PAGE_META[location.pathname] ?? {
    title: 'Recovery Case',
    description: 'The full recovery lifecycle for one diagnosed payment.',
  };

  // Close the drawer on navigation, so a mobile tap does not leave it covering
  // the page it just opened.
  useEffect(() => {
    setDrawerOpen(false);
  }, [location.pathname]);

  useEffect(() => {
    if (!drawerOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setDrawerOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [drawerOpen]);

  const sidebar = (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 px-5 py-5">
        <span
          aria-hidden="true"
          className="flex h-7 w-7 items-center justify-center rounded-lg bg-ink text-[13px] font-bold text-white"
        >
          R
        </span>
        <span className="text-[15px] font-semibold tracking-tight text-ink">RecoverAI</span>
      </div>

      <nav aria-label="Main" className="flex-1 overflow-y-auto px-3">
        <NavSection items={PRIMARY_NAV} onNavigate={() => setDrawerOpen(false)} />
      </nav>

      <div className="border-t border-line px-3 py-3">
        <NavSection items={SECONDARY_NAV} onNavigate={() => setDrawerOpen(false)} />
      </div>
    </div>
  );

  return (
    <div className="min-h-screen bg-canvas">
      {/* Desktop sidebar */}
      <aside className="fixed inset-y-0 left-0 hidden w-60 border-r border-line bg-surface lg:block">
        {sidebar}
      </aside>

      {/* Mobile drawer */}
      {drawerOpen && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <button
            type="button"
            aria-label="Close navigation"
            onClick={() => setDrawerOpen(false)}
            className="absolute inset-0 bg-ink/25 backdrop-blur-[1px]"
          />
          <div className="absolute inset-y-0 left-0 w-64 border-r border-line bg-surface shadow-xl">
            {sidebar}
          </div>
        </div>
      )}

      <div className="lg:pl-60">
        <header className="sticky top-0 z-30 border-b border-line bg-canvas/85 backdrop-blur">
          <div className="flex items-center gap-3 px-4 py-3.5 sm:px-6 lg:px-8">
            <button
              type="button"
              onClick={() => setDrawerOpen(true)}
              aria-label="Open navigation"
              aria-expanded={drawerOpen}
              className="rounded-lg border border-line-strong px-2 py-1 text-ink-muted lg:hidden"
            >
              <span aria-hidden="true">☰</span>
            </button>

            <div className="min-w-0 flex-1">
              <h1 className="truncate text-[15px] font-semibold tracking-tight text-ink">
                {meta.title}
              </h1>
              <p className="hidden truncate text-[12.5px] text-ink-muted sm:block">
                {meta.description}
              </p>
            </div>

            <div className="flex shrink-0 items-center gap-3">
              <HealthIndicator />
              <span className="hidden h-4 w-px bg-line md:block" />
              {/*
                Shared-token auth has no per-user identity. Saying "Authenticated
                operator" is honest; inventing a name or avatar would not be.
              */}
              <span className="hidden items-center gap-2 text-[12.5px] text-ink-muted md:inline-flex">
                <span
                  aria-hidden="true"
                  className="flex h-6 w-6 items-center justify-center rounded-full bg-ink/[0.06] text-[11px]"
                >
                  ◍
                </span>
                Authenticated operator
              </span>
            </div>
          </div>
        </header>

        <main className="px-4 py-6 sm:px-6 lg:px-8">
          <div className="mx-auto max-w-[1400px]">{children}</div>
        </main>
      </div>
    </div>
  );
}
