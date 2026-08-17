/**
 * PostsBySourceCard — post volume broken down by source for the selected period.
 *
 * v0.1 (2026-08-17): renders on the dashboard and every PDP as a peer of the
 *   KPI row. Reads DashboardResponse.volume_by_source (already period-filtered
 *   server-side), so it re-fetches automatically whenever the period selector
 *   changes.
 *
 * v0.2 (2026-08-17): the headline total now matches the "Total Posts" KPI.
 *   The backend counts POSTS in that KPI — Reddit comments are ingested for
 *   context but are NOT counted as first-class posts. In v0.1 we summed all
 *   six source columns, which double-counted comments and produced a card
 *   total that exceeded the "Total Posts" KPI (3,270 vs 5,392 for Hellraiser
 *   90d, a 2,122-post overstatement). The fix:
 *     • Headline total = sum of the per-day `total` field (which already
 *       excludes reddit_comment). This equals the Total Posts KPI exactly.
 *     • Post sources render as a ranked bar list as before.
 *     • Reddit comments render as a separate secondary line below the main
 *       list — present for context, visually differentiated so it can't be
 *       misread as an additive line item.
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
// v0.2 (2026-08-17): reddit_comment is intentionally excluded from SourceKey
// because it is not a post-level source in the backend's accounting — it's
// context that lives alongside Reddit posts. We surface the count separately
// below the main list.
export type SourceKey =
  | 'steam_forum'
  | 'reddit'
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
  { key: 'bluesky',        label: 'Bluesky',         color: '#944454' }, // mauve
  { key: 'dtf',            label: 'DTF',             color: '#FFC553' }, // gold
  { key: 'steam_review',   label: 'Steam Reviews',   color: '#6E522B' }, // brown
] as const

interface PostsBySourceCardProps {
  data:   VolumePoint[]
  period: Period
}

/**
 * Sum per-day VolumePoint rows into a single aggregate for the whole selected
 * period. VolumePoint has optional fields (reddit_comment and dtf were added
 * later) — treat missing as 0.
 *
 * v0.2 (2026-08-17): returns three separate outputs:
 *   • `bySource`  — counts by post-level source (used for the ranked bars)
 *   • `total`     — sum of per-day VolumePoint.total, which excludes comments
 *                    and MATCHES the sentiment_today.total KPI exactly
 *   • `redditComments` — exposed separately for the context row below the list
 *
 * Exported for unit tests — not consumed elsewhere.
 */
export interface VolumeAggregate {
  bySource:       Record<SourceKey, number>
  total:          number
  redditComments: number
}
export function aggregateVolumeBySource(points: VolumePoint[]): VolumeAggregate {
  const bySource: Record<SourceKey, number> = {
    steam_forum:  0,
    reddit:       0,
    bluesky:      0,
    dtf:          0,
    steam_review: 0,
  }
  let total          = 0
  let redditComments = 0
  for (const p of points) {
    bySource.steam_forum  += p.steam_forum ?? 0
    bySource.reddit       += p.reddit ?? 0
    bySource.bluesky      += p.bluesky ?? 0
    bySource.dtf          += p.dtf ?? 0
    bySource.steam_review += p.steam_review ?? 0
    total          += p.total ?? 0
    redditComments += p.reddit_comment ?? 0
  }
  return { bySource, total, redditComments }
}

export default function PostsBySourceCard({ data, period }: PostsBySourceCardProps) {
  const { bySource, total, redditComments } = aggregateVolumeBySource(data)
  const activeCount = SOURCES.filter(s => bySource[s.key] > 0).length

  // Rank rows by descending count so the leader is always on top. Sources with
  // zero posts stay in the list but sort to the bottom.
  const rows = SOURCES
    .map(s => ({ ...s, count: bySource[s.key] }))
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

        {/* v0.2 (2026-08-17): Reddit comments live outside the main list and
            outside the headline total, because the backend does not count
            comments as first-class posts. Rendering them as a peer to Reddit,
            Bluesky, etc. caused the card total to overstate Total Posts by
            the exact comment count. Muted styling + explicit “additional”
            framing keeps the context visible without inviting the wrong sum. */}
        {redditComments > 0 && (
          <div
            className="mt-3 border-t border-border/40 pt-3 flex items-center justify-between text-xs text-muted-foreground"
            data-testid="posts-by-source-reddit-comments"
          >
            <span>
              <span className="font-medium text-foreground/80">
                {redditComments.toLocaleString()}
              </span>{' '}
              additional Reddit comments on tracked threads
            </span>
            <span className="text-[10px] uppercase tracking-wide opacity-70">
              context, not counted in total
            </span>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
