import type { ReactNode } from 'react';
import { TONE_CLASSES, type StatusPresentation, type Tone } from '../lib/status.ts';

/**
 * Shared visual primitives.
 *
 * Every screen composes from these, so spacing, radius, border and type
 * decisions are made once here rather than drifting across pages.
 */

export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}

// ---------------------------------------------------------------------------
// StatusBadge
// ---------------------------------------------------------------------------

/**
 * A status pill.
 *
 * ACCESSIBILITY RULE: colour is never the only carrier of meaning. Every badge
 * renders an icon and a text label, so the state survives greyscale, colour
 * blindness, and a screen reader.
 */
export function StatusBadge({
  presentation,
  size = 'md',
  title,
}: {
  presentation: StatusPresentation;
  size?: 'sm' | 'md';
  title?: string;
}) {
  return (
    <span
      className={cx(
        'inline-flex items-center gap-1.5 rounded-full border font-medium whitespace-nowrap',
        size === 'sm' ? 'px-2 py-0.5 text-[11px]' : 'px-2.5 py-1 text-xs',
        TONE_CLASSES[presentation.tone],
      )}
      title={title ?? presentation.description}
    >
      <span aria-hidden="true" className="text-[0.85em] leading-none">
        {presentation.icon}
      </span>
      {presentation.label}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Cards
// ---------------------------------------------------------------------------

export function SectionCard({
  title,
  description,
  eyebrow,
  tone,
  actions,
  children,
  className,
}: {
  title?: string;
  description?: string;
  /** Small label above the title — used to name a lifecycle stage. */
  eyebrow?: string;
  tone?: Tone;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      className={cx(
        'rounded-xl border border-line bg-surface',
        'shadow-[0_1px_2px_rgba(16,24,40,0.04)]',
        className,
      )}
    >
      {(title !== undefined || actions !== undefined) && (
        <header className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
          <div className="min-w-0">
            {eyebrow !== undefined && (
              <p
                className={cx(
                  'text-[11px] font-semibold uppercase tracking-wider',
                  tone === undefined ? 'text-ink-subtle' : `text-${tone}`,
                )}
              >
                {eyebrow}
              </p>
            )}
            {title !== undefined && (
              <h2 className="mt-0.5 text-[15px] font-semibold text-ink">{title}</h2>
            )}
            {description !== undefined && (
              <p className="mt-1 text-[13px] leading-relaxed text-ink-muted">{description}</p>
            )}
          </div>
          {actions !== undefined && <div className="shrink-0">{actions}</div>}
        </header>
      )}
      <div className="px-5 py-4">{children}</div>
    </section>
  );
}

/**
 * A headline figure.
 *
 * `emphasis` is reserved for verified recovered revenue — the number an
 * operator most needs to trust. Nothing else in the product uses it.
 */
export function MetricCard({
  label,
  value,
  sublabel,
  tone = 'neutral',
  emphasis = false,
}: {
  label: string;
  value: string;
  sublabel?: string;
  tone?: Tone;
  emphasis?: boolean;
}) {
  return (
    <div
      className={cx(
        'rounded-xl border bg-surface px-5 py-4',
        'shadow-[0_1px_2px_rgba(16,24,40,0.04)]',
        emphasis ? 'border-verified/30 bg-verified-bg/40' : 'border-line',
      )}
    >
      <p className="text-[12px] font-medium uppercase tracking-wide text-ink-subtle">{label}</p>
      <p
        className={cx(
          'tabular mt-2 font-semibold tracking-tight',
          emphasis ? 'text-[28px] text-verified' : 'text-[26px] text-ink',
        )}
      >
        {value}
      </p>
      {sublabel !== undefined && (
        <p className={cx('mt-1 text-[12px]', tone === 'neutral' ? 'text-ink-subtle' : `text-${tone}`)}>
          {sublabel}
        </p>
      )}
    </div>
  );
}

/** A labelled value inside a card. */
export function Field({
  label,
  children,
  mono = false,
}: {
  label: string;
  children: ReactNode;
  mono?: boolean;
}) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] font-medium uppercase tracking-wide text-ink-subtle">{label}</dt>
      <dd className={cx('mt-1 text-[13px] text-ink break-words', mono && 'tabular font-medium')}>
        {children}
      </dd>
    </div>
  );
}

// ---------------------------------------------------------------------------
// States
// ---------------------------------------------------------------------------

export function Skeleton({ className }: { className?: string }) {
  return (
    <div
      className={cx('animate-pulse rounded bg-line/70', className)}
      aria-hidden="true"
    />
  );
}

export function TableSkeleton({ rows = 6, columns = 6 }: { rows?: number; columns?: number }) {
  return (
    <div role="status" aria-label="Loading" className="space-y-2 p-1">
      {Array.from({ length: rows }).map((_, rowIndex) => (
        <div key={rowIndex} className="flex gap-4">
          {Array.from({ length: columns }).map((__, colIndex) => (
            <Skeleton
              key={colIndex}
              className={cx('h-9 flex-1', colIndex === 0 && 'max-w-[180px]')}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-14 text-center">
      <div
        aria-hidden="true"
        className="mb-3 flex h-10 w-10 items-center justify-center rounded-full border border-line bg-canvas text-ink-subtle"
      >
        ○
      </div>
      <p className="text-[14px] font-medium text-ink">{title}</p>
      {description !== undefined && (
        <p className="mt-1 max-w-sm text-[13px] leading-relaxed text-ink-muted">{description}</p>
      )}
      {action !== undefined && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function ErrorState({
  title = 'Something went wrong',
  message,
  onRetry,
}: {
  title?: string;
  message: string;
  onRetry?: () => void;
}) {
  return (
    <div role="alert" className="flex flex-col items-center justify-center px-6 py-12 text-center">
      <div
        aria-hidden="true"
        className="mb-3 flex h-10 w-10 items-center justify-center rounded-full border border-danger/25 bg-danger-bg text-danger"
      >
        !
      </div>
      <p className="text-[14px] font-medium text-ink">{title}</p>
      <p className="mt-1 max-w-md text-[13px] leading-relaxed text-ink-muted">{message}</p>
      {onRetry !== undefined && (
        <button
          type="button"
          onClick={onRetry}
          className="mt-4 rounded-lg border border-line-strong bg-surface px-3 py-1.5 text-[13px] font-medium text-ink transition hover:bg-canvas"
        >
          Try again
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Callout — used for the safety messages that must never be missed
// ---------------------------------------------------------------------------

export function Callout({
  tone,
  title,
  children,
}: {
  tone: Tone;
  title: string;
  children?: ReactNode;
}) {
  return (
    <div className={cx('rounded-lg border px-4 py-3', TONE_CLASSES[tone])}>
      <p className="text-[13px] font-semibold">{title}</p>
      {children !== undefined && (
        <p className="mt-1 text-[12.5px] leading-relaxed opacity-90">{children}</p>
      )}
    </div>
  );
}

export function Button({
  children,
  onClick,
  variant = 'secondary',
  type = 'button',
  disabled = false,
  size = 'md',
  autoFocus = false,
}: {
  children: ReactNode;
  onClick?: () => void;
  variant?: 'primary' | 'secondary' | 'danger';
  type?: 'button' | 'submit';
  disabled?: boolean;
  size?: 'sm' | 'md';
  /** Marks this button as the one a dialog should focus when it opens. */
  autoFocus?: boolean;
}) {
  const variants: Record<string, string> = {
    primary: 'bg-ink text-white hover:bg-ink/90 border-ink',
    secondary: 'bg-surface text-ink hover:bg-canvas border-line-strong',
    danger: 'bg-danger text-white hover:bg-danger/90 border-danger',
  };
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      {...(autoFocus ? { 'data-autofocus': true } : {})}
      className={cx(
        'inline-flex items-center justify-center gap-1.5 rounded-lg border font-medium transition',
        size === 'sm' ? 'px-2.5 py-1 text-[12px]' : 'px-3.5 py-1.5 text-[13px]',
        variants[variant],
        disabled && 'cursor-not-allowed opacity-50',
      )}
    >
      {children}
    </button>
  );
}
