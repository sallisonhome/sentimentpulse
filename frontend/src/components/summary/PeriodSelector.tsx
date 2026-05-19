import { useMemo } from 'react'
import { cn } from '../../lib/utils'
import type { MonthlySummary } from '../../types'

interface PeriodSelectorProps {
  months: MonthlySummary[]
  selectedKey: string           // e.g. "2024-4"
  onChange: (key: string) => void
}

/**
 * Two-tier period selector.
 *
 *   Year tabs       [ 2026 (4) ] [ 2025 (12) ] [ 2024 (8) ]
 *   Month strip     Apr  Mar  Feb  Jan
 *                    •    ••    ·    ·     ← post-density indicator
 *
 * Design rationale:
 *   - 24+ months wrapping to two rows produces a wall of labels with no scannable
 *     hierarchy. Grouping by year reduces visual load to ~3 chunks the eye
 *     parses immediately.
 *   - Each month shows a small density indicator (· · • ••) reflecting post
 *     volume relative to the dataset's max. Density signals which months hold
 *     real signal — empty months are visually muted (60% opacity).
 *   - Selection uses the existing primary accent only; no new colors introduced.
 *   - Density is opacity-encoded, not color-encoded — meets WCAG color-
 *     independence (every month is also labeled).
 *
 * Key format: `${period_year}-${period_month}` for predictable identity.
 */
export function monthKey(year: number, month: number): string {
  return `${year}-${month}`
}

const MONTH_NAMES_SHORT = [
  '', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
]

// Map a post count to a 0-3 density bucket relative to the max in the dataset.
// 0 = no posts, 3 = top quartile.
function bucketFor(count: number, max: number): 0 | 1 | 2 | 3 {
  if (count <= 0 || max <= 0) return 0
  const r = count / max
  if (r >= 0.66) return 3
  if (r >= 0.33) return 2
  return 1
}

function DensityDots({ bucket }: { bucket: 0 | 1 | 2 | 3 }) {
  if (bucket === 0) {
    return (
      <span
        aria-hidden="true"
        className="mt-0.5 block h-1 w-3 rounded-full bg-current opacity-15"
      />
    )
  }
  // 1-3 filled "dots" rendered as small bars for compactness.
  const bars = 3
  return (
    <span
      aria-hidden="true"
      className="mt-0.5 flex items-center justify-center gap-0.5"
    >
      {Array.from({ length: bars }).map((_, i) => (
        <span
          key={i}
          className={cn(
            'h-1 w-1 rounded-full bg-current',
            i < bucket ? 'opacity-90' : 'opacity-20',
          )}
        />
      ))}
    </span>
  )
}

export default function PeriodSelector({
  months,
  selectedKey,
  onChange,
}: PeriodSelectorProps) {
  // Group months by year — newest year first; within each year, newest month first.
  const { years, monthsByYear, maxPostsInDataset } = useMemo(() => {
    const grouped = new Map<number, MonthlySummary[]>()
    let max = 0
    for (const m of months) {
      const y = m.period_year
      if (!grouped.has(y)) grouped.set(y, [])
      grouped.get(y)!.push(m)
      if ((m.total_posts ?? 0) > max) max = m.total_posts ?? 0
    }
    // Sort years descending
    const sortedYears = Array.from(grouped.keys()).sort((a, b) => b - a)
    // Sort months descending within each year
    for (const y of sortedYears) {
      grouped.get(y)!.sort((a, b) => b.period_month - a.period_month)
    }
    return { years: sortedYears, monthsByYear: grouped, maxPostsInDataset: max }
  }, [months])

  // Derive active year from selectedKey ("YYYY-M") — falls back to newest year.
  const activeYear = useMemo(() => {
    const parsed = parseInt(selectedKey.split('-')[0] ?? '', 10)
    if (Number.isFinite(parsed) && years.includes(parsed)) return parsed
    return years[0] ?? new Date().getFullYear()
  }, [selectedKey, years])

  if (!months.length) return null

  const activeYearMonths = monthsByYear.get(activeYear) ?? []

  return (
    <div
      role="group"
      aria-label="Select reporting period"
      className="flex flex-col gap-2"
    >
      {/* Year tabs — only render if there's more than one year of data */}
      {years.length > 1 && (
        <div
          role="tablist"
          aria-label="Year"
          className="inline-flex items-center gap-1 rounded-md bg-muted/60 p-1 self-start"
        >
          {years.map(y => {
            const count = monthsByYear.get(y)?.length ?? 0
            const isActive = y === activeYear
            return (
              <button
                key={y}
                type="button"
                role="tab"
                aria-selected={isActive}
                onClick={() => {
                  // Jumping years: select the newest month in that year
                  const first = monthsByYear.get(y)?.[0]
                  if (first) onChange(monthKey(first.period_year, first.period_month))
                }}
                className={cn(
                  'inline-flex items-center gap-1.5 rounded-sm px-2.5 py-1 text-sm font-medium',
                  'transition-colors focus-visible:outline-none',
                  'focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
                  'focus-visible:ring-offset-background',
                  isActive
                    ? 'bg-background text-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground hover:bg-background/40',
                )}
              >
                <span className="tabular-nums">{y}</span>
                <span
                  className={cn(
                    'tabular-nums text-xs',
                    isActive ? 'text-muted-foreground' : 'opacity-60',
                  )}
                >
                  {count}
                </span>
              </button>
            )
          })}
        </div>
      )}

      {/* Month strip — months within the active year */}
      <div
        role="tablist"
        aria-label="Month"
        className={cn(
          'inline-flex flex-wrap items-stretch gap-1 rounded-md bg-muted/60 p-1',
          // Slim horizontal scrolling when month count is large on narrow viewports
          'max-w-full overflow-x-auto',
        )}
      >
        {activeYearMonths.map(m => {
          const key = monthKey(m.period_year, m.period_month)
          const isActive = key === selectedKey
          const posts = m.total_posts ?? 0
          const bucket = bucketFor(posts, maxPostsInDataset)
          const monthName = MONTH_NAMES_SHORT[m.period_month] ?? '?'

          return (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={isActive}
              aria-label={`${m.month_label} (${posts} post${posts === 1 ? '' : 's'})`}
              title={`${m.month_label} · ${posts} post${posts === 1 ? '' : 's'}`}
              onClick={() => onChange(key)}
              className={cn(
                'group relative inline-flex min-w-[3.25rem] flex-col items-center',
                'rounded-sm px-2.5 py-1.5 text-sm font-medium',
                'transition-all focus-visible:outline-none',
                'focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
                'focus-visible:ring-offset-background',
                isActive
                  ? 'bg-primary text-primary-foreground shadow-sm'
                  : bucket === 0
                  ? 'text-muted-foreground/60 hover:bg-background/60 hover:text-foreground'
                  : 'text-muted-foreground hover:bg-background hover:text-foreground',
              )}
            >
              <span className="leading-none">{monthName}</span>
              <DensityDots bucket={bucket} />
            </button>
          )
        })}
      </div>
    </div>
  )
}
