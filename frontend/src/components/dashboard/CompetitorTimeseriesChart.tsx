import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ReferenceLine,
  type TooltipProps,
} from 'recharts'
import { format, parseISO } from 'date-fns'
import { useRef, useState, type ReactNode } from 'react'
import { toJpeg } from 'html-to-image'
import { Download } from 'lucide-react'
import { useNavigate, useLocation } from 'react-router-dom'
// (useLocation still imported so the pathname check below stays authoritative;
//  the actual game switch is state-driven via setSelectedGameId which now
//  syncs to the ?game=<id> URL query param — see contexts/AppContext.tsx)
import { Button } from '../ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '../ui/card'
import { useAppContext } from '../../contexts/AppContext'
import { useCompetitorTimeseries } from '../../hooks/useCompetitors'
import type { Period } from '../../types'
// v0020 (2026-08-19): PLS annotations for the parent Saber title.
// Same hook + category-color palette that powers Net Sentiment Trend's
// PLS overlay — chart rendering only differs in what data axis and
// legend surface the markers sit against.
import {
  usePlsMilestones,
  metaFor as plsMetaFor,
  type PlsAnnotation,
} from '../../hooks/usePlsMilestones'

// v0020: persist the PLS toggle so it survives page reloads.  Separate
// key from Net Sentiment's toggle so users can independently enable/
// disable PLS on each chart.
const PLS_TOGGLE_KEY = 'sp.chart.competitor.showPlsMilestones'
function loadPlsToggle(): boolean {
  try {
    const v = localStorage.getItem(PLS_TOGGLE_KEY)
    return v === null ? true : v === '1'
  } catch { return true }
}
function savePlsToggle(on: boolean): void {
  try { localStorage.setItem(PLS_TOGGLE_KEY, on ? '1' : '0') } catch { /* no-op */ }
}

interface CompetitorTimeseriesChartProps {
  parentId: number
  period: Period
}

// Same palette family used by VolumeBySourceChart's SOURCE_COLORS — blue,
// purple, orange, bluesky-blue — extended with green/teal/red so up to
// 5 lines (parent + 4 competitors) are always visually distinct.
const LINE_COLORS = ['#3b82f6', '#f97316', '#a855f7', '#22c55e', '#ef4444']

function formatMentions(v: number): string {
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`
  if (v >= 1_000) return `${(v / 1_000).toFixed(1)}K`
  return `${v}`
}

export default function CompetitorTimeseriesChart({ parentId, period }: CompetitorTimeseriesChartProps) {
  const navigate = useNavigate()
  const location = useLocation()
  const { setSelectedGameId } = useAppContext()
  const { data, isLoading } = useCompetitorTimeseries(parentId, period)

  // v0020 (2026-08-19): PLS annotations from SignalPulse for the parent
  // Saber title. We look up the parent's steam_app_id from the response
  // (added in v0020 backend). The hook itself returns an empty array
  // when there's no matching SignalPulse product, so the toggle is
  // silently hidden below for non-Saber parents.
  //
  // Hooks must be called unconditionally (React rules of hooks) even
  // though the chart may bail out below with `return null`, so this
  // sits above the early-return.
  const parentSteamAppId = data?.games.find(g => g.is_parent)?.steam_app_id ?? null
  const { data: plsRaw } = usePlsMilestones(parentSteamAppId)
  const [showPls, setShowPls] = useState<boolean>(loadPlsToggle)

  // Ref to the chart's outer card so the JPEG download can capture the
  // full card layout (title + chart + event list) instead of just the
  // recharts SVG.
  const cardRef = useRef<HTMLDivElement>(null)
  const [downloading, setDownloading] = useState(false)

  // Hover state for the event marker tooltip. Recharts' ReferenceLine
  // doesn't emit hover events natively, so we render invisible SVG
  // hitboxes over each marker and track which one is hovered here.
  const [hoveredEventId, setHoveredEventId] = useState<string | null>(null)

  // Hidden entirely when the parent has no competitors — `games` contains
  // only the parent in that case. Also render nothing while loading so we
  // never flash an empty chart shell above/below neighboring cards.
  if (isLoading || !data || data.games.length <= 1) return null

  async function handleDownload() {
    if (!cardRef.current || !data) return
    try {
      setDownloading(true)
      // Use the resolved --background CSS var so the exported image has
      // an opaque backdrop matching the current theme (light or dark)
      // instead of transparent-black which reads as garbled on both.
      const bg = getComputedStyle(document.body).getPropertyValue('--background').trim() || '#ffffff'
      const dataUrl = await toJpeg(cardRef.current, {
        cacheBust: true,
        pixelRatio: 2,               // 2x for sharper text on retina
        quality: 0.95,
        backgroundColor: bg.startsWith('#') ? bg : `hsl(${bg})`,
      })
      // Filename includes the parent title and period so downloads accumulate
      // in a scannable way in the user's Downloads folder.
      const parent = data.games.find(g => g.is_parent)
      const parentSlug = (parent?.name ?? `game-${parentId}`)
        .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
      const dateStr = format(new Date(), 'yyyy-MM-dd')
      const a = document.createElement('a')
      a.href = dataUrl
      a.download = `${parentSlug}_post-volume_${period}_${dateStr}.jpg`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
    } catch (e) {
      console.error('Chart download failed', e)
    } finally {
      setDownloading(false)
    }
  }

  // Flatten `counts` (an object keyed by game_id) into top-level keys so
  // recharts' <Line dataKey="21" /> can find the numeric value at
  // `formatted[i]["21"]`. Prior version left `counts` nested, so every
  // line rendered as an empty polyline.
  const formatted = data.timeseries.map(point => ({
    day: point.day,
    date_label: format(parseISO(point.day), 'MMM d'),
    ...point.counts,
  }))

  // v0020: Build the visible-ISO-date set for PLS filtering.  Same
  // pattern as NetSentimentChart — intersect on YYYY-MM-DD, NEVER on
  // display strings like "Aug 17", because those have no year and would
  // let 2022-08-17 PLS milestones bleed into a 90-day 2026 window.
  const visibleIsoDates = new Set(data.timeseries.map(p => String(p.day)))

  // Filter PLS annotations to only those inside the visible window,
  // then decorate them with the category color/label + the parent
  // game's game_id so the event-list rendering below can reuse the same
  // legend palette (as a secondary reference) if we later add per-
  // competitor PLS overlays. For v0020, PLS is parent-only.
  const parentGameId = data.games.find(g => g.is_parent)?.game_id ?? null
  const plsInWindow: PlsAnnotation[] = !showPls || !plsRaw
    ? []
    : plsRaw.filter(m => visibleIsoDates.has(m.event_date))
  const hasPlsData = (plsRaw?.length ?? 0) > 0

  function handleLegendClick(gameId: number, isParent: boolean) {
    // Clicking the parent's own name is a no-op — we're already on its
    // dashboard. Clicking a competitor sets the game via AppContext,
    // which in turn updates the ?game=<id> URL query param (browser
    // back/forward now correctly returns to the previously‑selected
    // game). No manual navigate('/') needed — URL sync handles it.
    //
    // Persist the current parent to sessionStorage so the child dashboard
    // can render the "← Back to <parent>" breadcrumb even after a hard
    // refresh from a bookmarked child URL that doesn't include the
    // parent context.
    if (isParent) return
    try {
      sessionStorage.setItem(
        `sp_parent_of_${gameId}`,
        JSON.stringify({ parent_id: parentId, ts: Date.now() }),
      )
    } catch { /* sessionStorage may be disabled; breadcrumb still works from API. */ }
    setSelectedGameId(gameId)
    // If we're not on the Dashboard route (e.g., viewed the chart from
    // Summary or Posts routes), navigate there. On '/' this is a no-op.
    if (location.pathname !== '/') {
      navigate('/')
    }
  }

  return (
    <Card ref={cardRef} className="w-full">
      <CardHeader className="flex flex-row items-start justify-between gap-4 space-y-0">
        <div>
          <CardTitle className="text-base">Post Volume by Title</CardTitle>
          <p className="text-xs text-muted-foreground">
            Daily post volume comparison across parent title and competitors
          </p>
        </div>
        <div className="flex items-center gap-3 shrink-0">
          {/* v0020: PLS milestones toggle — only shown when the parent
              Saber title actually has PLS data in SignalPulse. Matches
              the NetSentimentChart toggle pattern for consistency. */}
          {hasPlsData && (
            <label
              className="flex items-center gap-2 cursor-pointer select-none text-xs text-muted-foreground"
              data-testid="competitor-pls-milestones-toggle"
            >
              <input
                type="checkbox"
                className="h-3.5 w-3.5 cursor-pointer"
                checked={showPls}
                onChange={e => {
                  setShowPls(e.target.checked)
                  savePlsToggle(e.target.checked)
                }}
              />
              <span>PLS milestones</span>
            </label>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={handleDownload}
            disabled={downloading}
            className="gap-1.5"
          >
            <Download className="h-3.5 w-3.5" />
            {downloading ? 'Preparing…' : 'Download JPEG'}
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {/* Chart is taller (420 vs prior 240) and always full-card-width so
            event labels next to their vertical markers have room to sit
            without overlapping neighboring lines. Extra top margin (44px)
            reserves space for the wrapped event-name labels rendered above
            each marker; extra bottom margin (8px) keeps date ticks readable. */}
        {/* Height bumped from 420 to 520 and top margin from 44 to 88 on
            2026-07-27 to accommodate significantly larger event labels
            (11px → 20px = ~180%) and staggered rows without truncating.
            The tallest label rows now sit ~72px above y-max instead of ~32px. */}
        <ResponsiveContainer width="100%" height={520}>
          <LineChart data={formatted} margin={{ top: 88, right: 32, left: 12, bottom: 12 }}>
            <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
            <XAxis
              dataKey="date_label"
              tick={{ fontSize: 16 }}
              tickLine={false}
              axisLine={false}
            />
            <YAxis
              tickFormatter={formatMentions}
              tick={{ fontSize: 16 }}
              tickLine={false}
              axisLine={false}
              allowDecimals={false}
              label={{ value: 'Mentions', angle: -90, position: 'insideLeft', fontSize: 16, fill: 'hsl(var(--muted-foreground))' }}
            />
            <Tooltip content={<CompetitorTooltip games={data.games} />} />
            <Legend
              wrapperStyle={{ fontSize: 18, cursor: 'pointer', paddingTop: 12 }}
              formatter={(_value, entry) => {
                const gameId = Number((entry as { dataKey?: string }).dataKey)
                const g = data.games.find(x => x.game_id === gameId)
                if (!g) return null
                // Period-over-period chip (2026-07-26). Only shown when
                // the backend supplied a pct_change value — which happens
                // for 7d / 30d / 90d views only. On 'today' and 'All'
                // there's no comparable prior window so no chip appears.
                // pct_change === null (with a non-null current_total)
                // means "prev window was 0 posts" — we render 'new' in
                // muted text so the user knows the title had no prior
                // baseline rather than misreading a missing chip as "no change".
                const pct = g.pct_change
                let chip: ReactNode = null
                if (g.current_total != null) {
                  if (pct == null) {
                    // Two cases both resolve to null pct_change:
                    //   1. prev_total is 0 — title genuinely new in this window
                    //   2. Backend zeroed prev_totals across ALL games because
                    //      the prior window didn't have enough coverage days
                    //      (typically 90d view before we've backfilled >180d).
                    //      Detect (2) heuristically: if prev_total==0 for
                    //      EVERY game while current_total is non-zero for
                    //      several, prior data is missing group-wide.
                    const groupSuppressed = (data.games ?? [])
                      .every(x => (x.prev_total ?? 0) === 0)
                    const chipText = groupSuppressed ? '(no baseline)' : '(new)'
                    const chipTitle = groupSuppressed
                      ? 'Not enough prior-window data to compute a % change for this view.'
                      : `0 posts in prior window → ${g.current_total} now`
                    chip = (
                      <span className="ml-1 text-muted-foreground" title={chipTitle}>
                        {chipText}
                      </span>
                    )
                  } else {
                    const up = pct > 0
                    const flat = pct === 0
                    const arrow = flat ? '–' : up ? '▲' : '▼'
                    const cls = flat
                      ? 'text-muted-foreground'
                      : up ? 'text-emerald-500' : 'text-rose-500'
                    const sign = flat ? '' : up ? '+' : ''
                    chip = (
                      <span
                        className={`ml-1 ${cls}`}
                        title={`Current: ${g.current_total} posts • Previous: ${g.prev_total} posts`}
                      >
                        {arrow} {sign}{pct}%
                      </span>
                    )
                  }
                }
                return (
                  <span
                    onClick={() => handleLegendClick(g.game_id, g.is_parent)}
                    className={g.is_parent ? '' : 'hover:underline'}
                  >
                    {g.name}{g.is_parent ? ' (this title)' : ''}{chip}
                  </span>
                )
              }}
            />
            {data.games.map((g, i) => (
              <Line
                key={g.game_id}
                type="monotone"
                dataKey={String(g.game_id)}
                name={g.name}
                stroke={LINE_COLORS[i % LINE_COLORS.length]}
                strokeWidth={g.is_parent ? 2.5 : 1.75}
                dot={false}
                activeDot={{ r: 4 }}
              />
            ))}
            {/* Timeline event markers — vertical dashed lines colored to
                match the game each event belongs to, with the event name
                rendered above the marker so it's legible without hover.
                Only events whose event_date falls inside the current
                period window are in data.events (the backend filters). */}
            {(data.events ?? []).map((ev, i) => {
              const gameIdx = data.games.findIndex(g => g.game_id === ev.game_id)
              if (gameIdx < 0) return null
              const color = LINE_COLORS[gameIdx % LINE_COLORS.length]
              const dateLabel = format(parseISO(ev.event_date), 'MMM d')
              const evKey = `user-${ev.id}`
              const isHovered = hoveredEventId === evKey
              // Stagger label vertical position by index (offset 0 / 14 /
              // 28 px) so labels on nearby dates don't collide. dy is
              // relative to the top of the plot area (position='top').
              // 2026-07-27: bumped stagger from 14 -> 26 to give the
              // 20px event labels enough vertical breathing room.
              // With 3 rows at (4, 30, 56) px above the marker, the top
              // row sits at ~72px — which is exactly why we increased
              // top margin from 44 -> 88 above.
              const dy = -(4 + (i % 3) * 26)
              // Truncate very long names for the on-chart label; the
              // event list beneath the chart shows the full text.
              // 2026-07-27: shortened cap from 28 to 22 chars since the
              // 20px font means each char is roughly 60% wider on screen.
              const displayName = ev.name.length > 22 ? ev.name.slice(0, 21) + '…' : ev.name
              return (
                <ReferenceLine
                  key={evKey}
                  x={dateLabel}
                  stroke={color}
                  strokeDasharray="4 3"
                  strokeWidth={isHovered ? 2.5 : 1.5}
                  strokeOpacity={isHovered ? 1 : 0.75}
                  ifOverflow="visible"
                  isFront
                  label={{
                    value: displayName,
                    position: 'top',
                    fill: color,
                    // 2026-07-27: bumped from 11 to 20 (~180%) so event
                    // labels are readable in a full-width Post Volume
                    // chart without zooming. Chart height and top margin
                    // were also enlarged to give these labels room.
                    fontSize: 20,
                    fontWeight: isHovered ? 700 : 600,
                    dy,
                  }}
                  onMouseEnter={() => setHoveredEventId(evKey)}
                  onMouseLeave={() => setHoveredEventId(null)}
                />
              )
            })}
            {/* v0020: PLS milestone markers for the parent Saber title.
                Dashed pattern is "6 4" to visually distinguish from the
                user-timeline "4 3" pattern at a glance without demanding
                a legend. Category color from PLS_CATEGORY_META keeps the
                signal encoded in the marker itself (Core=teal, Video=
                rust, Press=mauve, Demo=gold, Sale=olive, other=brown).

                Stagger index continues from where user events left off
                so a dense day doesn't stack a PLS label right on top of
                a user event label at the same dy row. */}
            {plsInWindow.map((m, i) => {
              const meta = plsMetaFor(m.category)
              const dateLabel = format(parseISO(m.event_date), 'MMM d')
              const evKey = m.id  // already 'pls-<id>' from usePlsMilestones
              const isHovered = hoveredEventId === evKey
              // Continue the stagger sequence past the user-events so
              // labels don't collide on shared dates.
              const dy = -(4 + ((data.events?.length ?? 0) + i) % 3 * 26)
              const suffix = m.is_planned ? ' (planned)' : ''
              const rawLabel = m.name + suffix
              const displayName = rawLabel.length > 22
                ? rawLabel.slice(0, 21) + '…'
                : rawLabel
              return (
                <ReferenceLine
                  key={evKey}
                  x={dateLabel}
                  stroke={meta.color}
                  strokeDasharray="6 4"
                  strokeWidth={isHovered ? 2.5 : 1.5}
                  strokeOpacity={isHovered ? 1 : 0.75}
                  ifOverflow="visible"
                  isFront
                  label={{
                    value: displayName,
                    position: 'top',
                    fill: meta.color,
                    fontSize: 20,
                    fontWeight: isHovered ? 700 : 600,
                    dy,
                  }}
                  onMouseEnter={() => setHoveredEventId(evKey)}
                  onMouseLeave={() => setHoveredEventId(null)}
                />
              )
            })}
          </LineChart>
        </ResponsiveContainer>
        <p className="mt-3 text-sm text-muted-foreground">
          Click a competitor's name in the legend to open its full dashboard.
          {(data.events?.length ?? 0) > 0 && (
            <> · Dashed vertical markers (4-3) are user-added timeline events (add or edit in Settings).</>
          )}
          {plsInWindow.length > 0 && (
            <> · Longer-dash markers (6-4) are Saber PLS milestones from SignalPulse, colored by category.</>
          )}
        </p>

        {/* Event list beneath the chart — gives users a clean way to read
            each marker's date, description, and which game it belongs to,
            without depending on hover interactions with the small dot on
            the chart itself.

            v0020: PLS milestones are appended to the same list, sorted
            chronologically with user events.  Row color follows the
            marker: user events use the competing-game line color, PLS
            uses its category color from PLS_CATEGORY_META.  Category
            label appears next to the PLS name so "Core" vs "Sale" is
            legible in the list without matching swatches to the header. */}
        {((data.events?.length ?? 0) > 0 || plsInWindow.length > 0) && (
          <div className="mt-4 border-t border-border/60 pt-3">
            <p className="mb-2 text-sm font-medium uppercase tracking-wide text-muted-foreground">
              Events in this window
            </p>
            <ul className="grid grid-cols-1 gap-x-4 gap-y-1 text-sm sm:grid-cols-2">
              {[
                // Unified list of user events + PLS milestones, sorted
                // by event_date so a Steam Sale on Aug 15 shows next to
                // a user 'Feature launch' event on Aug 15.
                ...(data.events ?? []).map(ev => ({
                  kind: 'user' as const,
                  key:  `user-${ev.id}`,
                  event_date: ev.event_date,
                  name: ev.name,
                  game_id: ev.game_id,
                })),
                ...plsInWindow.map(m => ({
                  kind: 'pls' as const,
                  key:  m.id,
                  event_date: m.event_date,
                  name: m.name + (m.is_planned ? ' (planned)' : ''),
                  category: m.category,
                  game_id: parentGameId ?? undefined,
                })),
              ]
                .sort((a, b) => a.event_date.localeCompare(b.event_date))
                .map(row => {
                  if (row.kind === 'user') {
                    const gameIdx = data.games.findIndex(g => g.game_id === row.game_id)
                    const color = LINE_COLORS[Math.max(gameIdx, 0) % LINE_COLORS.length]
                    const g = data.games[gameIdx]
                    return (
                      <li key={row.key} className="flex items-baseline gap-1.5">
                        <span aria-hidden style={{ color }}>●</span>
                        <span className="tabular-nums text-muted-foreground">{row.event_date}</span>
                        <span className="truncate" title={`${g?.name ?? ''} — ${row.name}`}>
                          {row.name}
                          {g && <span className="text-muted-foreground"> — {g.name}</span>}
                        </span>
                      </li>
                    )
                  }
                  // PLS row
                  const meta = plsMetaFor(row.category!)
                  return (
                    <li key={row.key} className="flex items-baseline gap-1.5">
                      <span aria-hidden style={{ color: meta.color }}>●</span>
                      <span className="tabular-nums text-muted-foreground">{row.event_date}</span>
                      <span className="truncate" title={`PLS — ${meta.label} — ${row.name}`}>
                        {row.name}
                        <span className="text-muted-foreground"> — PLS · {meta.label}</span>
                      </span>
                    </li>
                  )
                })}
            </ul>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

function CompetitorTooltip({
  active,
  payload,
  label,
  games,
}: TooltipProps<number, string> & { games: { game_id: number; name: string; is_parent: boolean }[] }) {
  if (!active || !payload?.length) return null
  return (
    <div className="rounded-md border bg-popover p-3 text-xs shadow-md space-y-1">
      <p className="font-semibold">{label}</p>
      {payload.map(p => {
        const gameId = Number(p.dataKey)
        const g = games.find(x => x.game_id === gameId)
        return (
          <p key={p.dataKey} style={{ color: p.color }}>
            {g?.name ?? p.dataKey}: {((p.value as number) ?? 0).toLocaleString()}
          </p>
        )
      })}
    </div>
  )
}
