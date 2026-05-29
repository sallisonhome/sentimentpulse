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

/** Return a human-readable relative time string */
export function relativeTime(isoString: string | null | undefined): string {
  if (!isoString) return 'Never'
  const diff = Date.now() - new Date(isoString).getTime()
  const minutes = Math.floor(diff / 60_000)
  if (minutes < 1)  return 'Just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24)   return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

/** Map a source string to a display label */
export function sourceLabel(source: string): string {
  return {
    steam_review: 'Steam Review',
    steam_forum:  'Steam Forum',
    reddit:       'Reddit',
    bluesky:      'Bluesky',
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
