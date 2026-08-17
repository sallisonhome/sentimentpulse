/**
 * PostsBySourceCard — post volume broken down by source for the selected period.
 *
 * v0.1 (2026-08-17): renders on the dashboard and every PDP as a peer of the
 *   KPI row. Reads DashboardResponse.volume_by_source (already period-filtered
 *   server-side), so it re-fetches automatically whenever the period selector
 *   changes.
 *
 * Design decisions (locked with user 2026-08-17):
 *   • Option A layout: total up top, ranked bars below (one bar per source,
 *     sorted by count descending).
 *   • Bars are proportional to the maximum-active-source count in this period
 *     — the leader gets 100% width so relative volume is easy to eyeball.
 *   • Sources that have zero posts in the period render as a dimmed row with
 *     "0" — silent channels stay visible without stealing focus.
 *   • Source palette matches the chart color sequence from design-foundations
 *     so a source keeps its color across every chart, legend, and card.
 */
import { Card, CardContent, CardHeader, CardTitle } from '../ui/card'
import type { Period, VolumePoint } from '../../types'

const PERIOD_LABELS: Record<Period, string> = {
  today:     'Today',
  weekly:    'Last 7 days',
  monthly:   'Last 30 days',
  quarterly: 'Last 90 days',
  lifetime:  'All time',
}

// ── Source display + palette ──────────────────────────────────────────────
// Ordered to match how sources appear elsewhere in the app (Steam Forum, then
// Reddit + comments, then Bluesky, then DTF, then Steam Reviews).
export type SourceKey =
  | 'steam_forum'
  | 'reddit'
  | 'reddit_comment'
  | 'bluesky'
  | 'dtf'
  | 'steam_review'

interface SourceMeta {
  key:   SourceKey
  label: string
  /** Hex from design-foundations chart color sequence — kept identical to the
   *  Option A mockup so the palette is stable across the app. */
  color: string
}

const SOURCES: readonly SourceMeta[] = [
  { key: 'steam_forum',    label: 'Steam Forum',     color: '#20808D' }, // teal
  { key: 'reddit',         label: 'Reddit',          color: '#A84B2F' }, // terra/rust
  { key: 'reddit_comment', label: 'Reddit comments', color: '#1B474D' }, // dark teal
  { key: 'bluesky',        label: 'Bluesky',         color: '#944454' }, // mauve
  { key: 'dtf',            label: 'DTF',             color: '#FFC553' }, // gold
  { key: 'steam_review',   label: 'Steam Reviews',   color: '#6E522B' }, // brown
] as const

interface PostsBySourceCardProps {
  data:   VolumePoint[]
  period: Period
}

/**
 * Sum per-day VolumePoint rows into a single {source: count} aggregate for
 * the whole selected period. VolumePoint has optional fields (reddit_comment
 * and dtf were added later) — treat missing as 0.
 *
 * Exported for unit tests — not consumed elsewhere.
 */
export function aggregateVolumeBySource(points: VolumePoint[]): Record<SourceKey, number> {
  const out: Record<SourceKey, number> = {
    steam_forum:    0,
    reddit:         0,
    reddit_comment: 0,
    bluesky:        0,
    dtf:            0,
    steam_review:   0,
  }
  for (const p of points) {
    out.steam_forum    += p.steam_forum ?? 0
    out.reddit         += p.reddit ?? 0
    out.reddit_comment += p.reddit_comment ?? 0
    out.bluesky        += p.bluesky ?? 0
    out.dtf            += p.dtf ?? 0
    out.steam_review   += p.steam_review ?? 0
  }
  return out
}

export default function PostsBySourceCard({ data, period }: PostsBySourceCardProps) {
  const counts = aggregateVolumeBySource(data)
  const total  = Object.values(counts).reduce((a, b) => a + b, 0)
  const activeCount = SOURCES.filter(s => counts[s.key] > 0).length

  // Rank rows by descending count so the leader is always on top. Sources with
  // zero posts stay in the list but sort to the bottom.
  const rows = SOURCES
    .map(s => ({ ...s, count: counts[s.key] }))
    .sort((a, b) => b.count - a.count)

  // Bar widths are proportional to the leader (the top row is 100%). Guard
  // against divide-by-zero for the empty-period edge case.
  const maxCount = rows[0]?.count ?? 0
  const widthFor = (c: number) => (maxCount > 0 ? (c / maxCount) * 100 : 0)

  return (
    <Card>
      <CardHeader className="flex flex-row items-baseline justify-between pb-2 space-y-0">
        <CardTitle className="text-sm font-medium text-muted-foreground">
          Posts by Source
        </CardTitle>
        <span className="text-xs text-muted-foreground">
          {PERIOD_LABELS[period]}
        </span>
      </CardHeader>
      <CardContent>
        <div className="flex items-baseline justify-between">
          <p className="text-2xl font-bold tabular-nums">
            {total.toLocaleString()}
          </p>
          <p className="text-xs text-muted-foreground">
            total posts · {activeCount} of {SOURCES.length} sources active
          </p>
        </div>

        <div className="mt-4 flex flex-col gap-2">
          {rows.map(row => {
            const isEmpty = row.count === 0
            return (
              <div
                key={row.key}
                className={
                  'grid items-center gap-3 text-xs ' +
                  (isEmpty ? 'opacity-50' : '')
                }
                style={{ gridTemplateColumns: '110px 1fr 52px' }}
                data-testid={`posts-by-source-row-${row.key}`}
              >
                <span className="font-medium">{row.label}</span>
                <div className="h-2 rounded-full bg-slate-100 dark:bg-slate-800 overflow-hidden">
                  {!isEmpty && (
                    <div
                      className="h-2 rounded-full"
                      style={{
                        width: `${widthFor(row.count)}%`,
                        backgroundColor: row.color,
                      }}
                    />
                  )}
                </div>
                <span className="text-right tabular-nums font-medium text-muted-foreground">
                  {row.count.toLocaleString()}
                </span>
              </div>
            )
          })}
        </div>
      </CardContent>
    </Card>
  )
}
