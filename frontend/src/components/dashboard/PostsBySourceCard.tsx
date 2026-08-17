/**
 * PostsBySourceCard — post volume broken down by source for the selected period.
 *
 * v0.1 (2026-08-17): renders on the dashboard and every PDP as a peer of the
 *   KPI row. Reads DashboardResponse.volume_by_source (already period-filtered
 *   server-side), so it re-fetches automatically whenever the period selector
 *   changes.
 *
 * v0.2 (2026-08-17): the headline total now matches the "Total Posts" KPI by
 *   using the per-day `total` field (which the backend computes as the sum
 *   of the five post-level source columns after folding reddit_comment into
 *   the reddit column). The v0.2 message about "additional Reddit comments
 *   not counted in the total" was **wrong** — reddit_comment IS included in
 *   the Reddit bar (submissions + comments). Corrected in v0.3 below.
 *
 * v0.3 (2026-08-17): period-over-period deltas.
 *   • Backend now returns `prior_period_volume_by_source` alongside
 *     `volume_by_source`. Null for period=today (single in-progress day)
 *     and period=lifetime (no comparable prior window), and null when the
 *     prior window has too little ingestion coverage. In every case where
 *     it IS present, the card shows a delta chip next to the headline
 *     total AND next to each source bar with:
 *       – absolute change (e.g. "+412" / "−128")
 *       – signed % change  (e.g. "+15.9%" / "−32.1%")
 *     Color: teal for positive, mauve for negative (design-foundations
 *     chart palette), muted for zero/no-baseline.
 *   • Reddit comments callout REPHRASED: now reads "Of the Reddit total,
 *     N were comments" — factually correct (comments are already inside
 *     the Reddit bar) and no longer implies "additional" volume.
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
export type SourceKey =
  | 'steam_forum'
  | 'reddit'
  | 'bluesky'
  | 'dtf'
  | 'steam_review'

interface SourceMeta {
  key:   SourceKey
  label: string
  color: string
}

const SOURCES: readonly SourceMeta[] = [
  { key: 'steam_forum',    label: 'Steam Forum',     color: '#20808D' }, // teal
  { key: 'reddit',         label: 'Reddit',          color: '#A84B2F' }, // terra/rust
  { key: 'bluesky',        label: 'Bluesky',         color: '#944454' }, // mauve
  { key: 'dtf',            label: 'DTF',             color: '#FFC553' }, // gold
  { key: 'steam_review',   label: 'Steam Reviews',   color: '#6E522B' }, // brown
] as const

// ── Delta chip colors (from design-foundations chart color sequence) ─────
// We use the same teal/mauve pair as the divergent-data sequence in
// design-foundations so a "positive change" here reads the same as a
// positive change anywhere else in the app.
const DELTA_POS_COLOR = '#20808D'  // teal
const DELTA_NEG_COLOR = '#944454'  // mauve

interface PostsBySourceCardProps {
  data:      VolumePoint[]
  /** v0.3 (2026-08-17): prior-period series for delta annotations.
   *  Null when the comparison is not meaningful (period=today or
   *  period=lifetime) or when the backend's coverage guard fired. */
  priorData: VolumePoint[] | null
  period:    Period
}

/**
 * Sum per-day VolumePoint rows into a single aggregate for the whole selected
 * period. VolumePoint has optional fields (reddit_comment and dtf were added
 * later) — treat missing as 0.
 *
 * v0.3 (2026-08-17): the backend folds reddit_comment INTO the reddit field
 * and computes VolumePoint.total as sum of the five source columns (which
 * therefore includes comments via being inside reddit). We reflect that
 * here: `bySource.reddit` is submissions + comments, `redditComments` is
 * the comments subset for the callout row, and `total` is authoritative
 * because it matches the Total Posts KPI exactly.
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

/**
 * Compute a signed pct-change from prev → curr. Returns null when the
 * comparison is undefined (prev is 0 or missing) so the caller can render
 * a "new" / "no baseline" state instead of "+Infinity%" or "+9,999%".
 *
 * Exported for unit tests.
 */
export function pctChange(curr: number, prev: number): number | null {
  if (prev <= 0) return null
  return ((curr - prev) / prev) * 100
}

// ── Delta chip rendering ─────────────────────────────────────────────────
//
// Shape (small, muted, right-aligned):
//   +412 (+15.9%)   ← teal when positive
//   −128 (−32.1%)   ← mauve when negative
//     0             ← muted (unchanged)
//   new             ← muted italic (had zero prior activity)
//
// Absolute is shown FIRST because for low-volume sources the % is jumpy
// (going from 2 → 6 posts is +200% but only 4 posts); the absolute count
// keeps the relative-noise honest.

interface DeltaChipProps {
  curr: number
  prev: number | null   // null means prior window unavailable
}
function DeltaChip({ curr, prev }: DeltaChipProps) {
  // No prior series at all (today / lifetime / coverage-guarded) →
  // render nothing so the row stays tidy.
  if (prev === null) return null

  const abs = curr - prev
  const pct = pctChange(curr, prev)

  // Prior was zero, current is > 0 → mark as "new" activity rather than
  // computing an infinite percentage.
  if (prev === 0 && curr > 0) {
    return (
      <span className="text-[10px] italic text-muted-foreground" data-testid="delta-new">
        new
      </span>
    )
  }
  // Both zero → unchanged; muted "0".
  if (prev === 0 && curr === 0) {
    return (
      <span className="text-[10px] text-muted-foreground/70" data-testid="delta-zero">0</span>
    )
  }

  const color =
    abs > 0 ? DELTA_POS_COLOR :
    abs < 0 ? DELTA_NEG_COLOR :
    undefined
  const sign = abs > 0 ? '+' : abs < 0 ? '−' : ''
  const absStr = `${sign}${Math.abs(abs).toLocaleString()}`
  const pctStr = pct != null
    ? ` (${abs > 0 ? '+' : abs < 0 ? '−' : ''}${Math.abs(pct).toFixed(1)}%)`
    : ''

  return (
    <span
      className="text-[10px] tabular-nums font-medium"
      style={{ color }}
      data-testid="delta-chip"
    >
      {absStr}
      <span className="text-muted-foreground font-normal">{pctStr}</span>
    </span>
  )
}

export default function PostsBySourceCard({ data, priorData, period }: PostsBySourceCardProps) {
  const curr = aggregateVolumeBySource(data)
  const prior = priorData ? aggregateVolumeBySource(priorData) : null
  const activeCount = SOURCES.filter(s => curr.bySource[s.key] > 0).length

  // Rank rows by descending count so the leader is always on top. Sources with
  // zero posts stay in the list but sort to the bottom.
  const rows = SOURCES
    .map(s => ({ ...s, count: curr.bySource[s.key], prev: prior?.bySource[s.key] ?? null }))
    .sort((a, b) => b.count - a.count)

  // Bar widths are proportional to the leader (the top row is 100%). Guard
  // against divide-by-zero for the empty-period edge case.
  const maxCount = rows[0]?.count ?? 0
  const widthFor = (c: number) => (maxCount > 0 ? (c / maxCount) * 100 : 0)

  // Show a small "vs prior period" line under the total, matching the
  // period the user has selected. Only rendered when priorData is present.
  const priorLabel = period === 'weekly'    ? 'vs prior 7 days'
                   : period === 'monthly'   ? 'vs prior 30 days'
                   : period === 'quarterly' ? 'vs prior 90 days'
                   : null

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
        <div className="flex items-baseline justify-between gap-3">
          <div className="flex items-baseline gap-2">
            <p className="text-2xl font-bold tabular-nums">
              {curr.total.toLocaleString()}
            </p>
            {prior && (
              <span data-testid="headline-delta">
                <DeltaChip curr={curr.total} prev={prior.total} />
              </span>
            )}
          </div>
          <div className="text-right">
            <p className="text-xs text-muted-foreground">
              total posts · {activeCount} of {SOURCES.length} sources active
            </p>
            {priorLabel && prior && (
              <p className="text-[10px] text-muted-foreground/70 mt-0.5">
                {priorLabel}
              </p>
            )}
          </div>
        </div>

        <div className="mt-4 flex flex-col gap-2">
          {rows.map(row => {
            const isEmpty = row.count === 0 && (row.prev ?? 0) === 0
            return (
              <div
                key={row.key}
                className={
                  'grid items-center gap-3 text-xs ' +
                  (isEmpty ? 'opacity-50' : '')
                }
                // v0.3: added a fourth column for the per-source delta chip.
                // Column widths tuned so labels don't wrap at 720px viewport.
                style={{ gridTemplateColumns: '110px 1fr 52px 92px' }}
                data-testid={`posts-by-source-row-${row.key}`}
              >
                <span className="font-medium">{row.label}</span>
                <div className="h-2 rounded-full bg-slate-100 dark:bg-slate-800 overflow-hidden">
                  {row.count > 0 && (
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
                <span className="text-right">
                  <DeltaChip curr={row.count} prev={row.prev} />
                </span>
              </div>
            )
          })}
        </div>

        {/* v0.3 (2026-08-17): CORRECTED phrasing. Comments are ALREADY
            inside the Reddit total (the backend folds reddit_comment into
            the reddit column and includes it in VolumePoint.total). The
            v0.2 text "additional Reddit comments" implied a separate
            additive bucket, which was misleading. New copy makes the
            subset-relationship explicit. */}
        {curr.redditComments > 0 && (
          <div
            className="mt-3 border-t border-border/40 pt-3 flex items-center justify-between text-xs text-muted-foreground"
            data-testid="posts-by-source-reddit-comments"
          >
            <span>
              Of the Reddit total,{' '}
              <span className="font-medium text-foreground/80">
                {curr.redditComments.toLocaleString()}
              </span>{' '}
              were comments on tracked threads
            </span>
            <span className="text-[10px] uppercase tracking-wide opacity-70">
              already in the Reddit bar
            </span>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
