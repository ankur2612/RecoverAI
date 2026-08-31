/**
 * Formatting helpers.
 *
 * MONEY IS INTEGER MINOR UNITS EVERYWHERE IT TRAVELS. Division happens once,
 * here, at the moment of display — never in a calculation, never before a
 * comparison, and never on a value that is stored or sent back.
 */

/** Format minor units (paise) as rupees. Display only. */
export function formatMoney(minorUnits: number, currency = 'INR'): string {
  const major = minorUnits / 100;
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency,
    maximumFractionDigits: 2,
  }).format(major);
}

/**
 * Compact money for hero metrics: ₹29.99L rather than ₹29,98,800.00.
 *
 * Uses Indian lakh/crore units, since the product is INR-first. Falls back to
 * the full figure below a lakh, where compaction would lose more than it saves.
 */
export function formatMoneyCompact(minorUnits: number, currency = 'INR'): string {
  const major = minorUnits / 100;
  const symbol = currency === 'INR' ? '₹' : '';

  if (currency !== 'INR') return formatMoney(minorUnits, currency);
  if (Math.abs(major) >= 10_000_000) return `${symbol}${(major / 10_000_000).toFixed(2)}Cr`;
  if (Math.abs(major) >= 100_000) return `${symbol}${(major / 100_000).toFixed(2)}L`;
  return formatMoney(minorUnits, currency);
}

/** A rate in [0,1] as a percentage. */
export function formatPercent(rate: number, decimals = 1): string {
  return `${(rate * 100).toFixed(decimals)}%`;
}

export function formatDateTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('en-IN', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
}

/** Relative age, for "how long has this been waiting". */
export function formatAge(iso: string, now: Date = new Date()): string {
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return '—';

  const seconds = Math.max(0, Math.floor((now.getTime() - then.getTime()) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return days < 30 ? `${days}d ago` : formatDateTime(iso);
}

/** Turn SCREAMING_SNAKE into readable text without losing the original code. */
export function humanise(code: string): string {
  return code
    .toLowerCase()
    .split('_')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}
