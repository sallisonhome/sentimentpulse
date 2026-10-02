import { type ClassValue, clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'

/** shadcn/ui class-merging helper */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/** Format a float as a signed percentage string: +3.5% or -1.2% */
export function formatDelta(delta: number | null | undefined): string {
  if (delta == null) return 'N/A'
  return `${delta >= 0 ? '+' : ''}${(delta * 100).toFixed(1)}%`
}

/** Truncate a string with ellipsis */
export function truncate(str: string | null | undefined, maxLen: number): string {
  if (!str) return ''
  return str.length <= maxLen ? str : `${str.slice(0, maxLen)}…`
}

/** Return a human-readable relative time string.
 *  Past times read "5m ago"; future times (e.g. the next scheduled ingest)
 *  read "in 21h" instead of collapsing to "Just now" (2026-10-02). */
export function relativeTime(isoString: string | null | undefined): string {
  if (!isoString) return 'Never'
  const t = new Date(isoString).getTime()
  if (Number.isNaN(t)) return 'Never'
  const diff = Date.now() - t
  const future = diff < 0
  const minutes = Math.floor(Math.abs(diff) / 60_000)
  if (minutes < 1)  return future ? 'in <1m' : 'Just now'
  const fmt = (n: number, unit: string) => (future ? `in ${n}${unit}` : `${n}${unit} ago`)
  if (minutes < 60) return fmt(minutes, 'm')
  const hours = Math.floor(minutes / 60)
  if (hours < 24)   return fmt(hours, 'h')
  const days = Math.floor(hours / 24)
  return fmt(days, 'd')
}

/** Map a source string to a display label */
export function sourceLabel(source: string): string {
  return {
    steam_review:  'Steam Review',
    steam_forum:   'Steam Forum',
    reddit:        'Reddit',
    // v0016.2 (2026-08-12): Reddit comments as a separate axis. Shows up
    // in Volume by Source as 'Reddit Comments' so it's obvious this is
    // comment-level engagement inheriting a parent-thread's topic match.
    reddit_comment: 'Reddit Comments',
    youtube_comment: 'YouTube Comments',
    bluesky:       'Bluesky',
    // DTF.ru — Russian-language gaming forum. Added 2026-07-27.
    dtf:           'DTF',
  }[source] ?? source
}

/** Convert a Period to a lookback in days (null = no limit / lifetime) */
export function periodToDays(period: string): number | null {
  switch (period) {
    case 'weekly':    return 7
    case 'monthly':   return 30
    case 'quarterly': return 90
    default:          return null  // lifetime
  }
}
