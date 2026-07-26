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

  // Ref to the chart's outer card so the JPEG download can capture the
  // full card layout (title + chart + event list) instead of just the
  // recharts SVG.
  const cardRef = useRef<HTMLDivElement>(null)
  const [downloading, setDownloading] = useState(false)

  // Hover state for the event marker tooltip. Recharts' ReferenceLine
  // doesn't emit hover events natively, so we render invisible SVG
  // hitboxes over each marker and track which one is hovered here.
  const [hoveredEventId, setHoveredEventId] = useState<number | null>(null)

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
        <Button
          variant="outline"
          size="sm"
          onClick={handleDownload}
          disabled={downloading}
          className="shrink-0 gap-1.5"
        >
          <Download className="h-3.5 w-3.5" />
          {downloading ? 'Preparing…' : 'Download JPEG'}
        </Button>
      </CardHeader>
      <CardContent>
        {/* Chart is taller (420 vs prior 240) and always full-card-width so
            event labels next to their vertical markers have room to sit
            without overlapping neighboring lines. Extra top margin (44px)
            reserves space for the wrapped event-name labels rendered above
            each marker; extra bottom margin (8px) keeps date ticks readable. */}
        <ResponsiveContainer width="100%" height={420}>
          <LineChart data={formatted} margin={{ top: 44, right: 24, left: 4, bottom: 8 }}>
            <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
            <XAxis
              dataKey="date_label"
              tick={{ fontSize: 11 }}
              tickLine={false}
              axisLine={false}
            />
            <YAxis
              tickFormatter={formatMentions}
              tick={{ fontSize: 11 }}
              tickLine={false}
              axisLine={false}
              allowDecimals={false}
              label={{ value: 'Mentions', angle: -90, position: 'insideLeft', fontSize: 11, fill: 'hsl(var(--muted-foreground))' }}
            />
            <Tooltip content={<CompetitorTooltip games={data.games} />} />
            <Legend
              wrapperStyle={{ fontSize: 11, cursor: 'pointer' }}
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
                    chip = (
                      <span className="ml-1 text-muted-foreground" title={`0 posts in prior window → ${g.current_total} now`}>
                        (new)
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
              const isHovered = hoveredEventId === ev.id
              // Stagger label vertical position by index (offset 0 / 14 /
              // 28 px) so labels on nearby dates don't collide. dy is
              // relative to the top of the plot area (position='top').
              const dy = -(4 + (i % 3) * 14)
              // Truncate very long names for the on-chart label; the
              // event list beneath the chart shows the full text.
              const displayName = ev.name.length > 28 ? ev.name.slice(0, 27) + '…' : ev.name
              return (
                <ReferenceLine
                  key={`ev-${ev.id}`}
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
                    fontSize: 11,
                    fontWeight: isHovered ? 600 : 500,
                    dy,
                  }}
                  onMouseEnter={() => setHoveredEventId(ev.id)}
                  onMouseLeave={() => setHoveredEventId(null)}
                />
              )
            })}
          </LineChart>
        </ResponsiveContainer>
        <p className="mt-2 text-[11px] text-muted-foreground">
          Click a competitor's name in the legend to open its full dashboard.
          {(data.events?.length ?? 0) > 0 && (
            <> · Dashed vertical markers are user-added timeline events (add or edit in Settings).</>
          )}
        </p>

        {/* Event list beneath the chart — gives users a clean way to read
            each marker's date, description, and which game it belongs to,
            without depending on hover interactions with the small dot on
            the chart itself. */}
        {(data.events?.length ?? 0) > 0 && (
          <div className="mt-3 border-t border-border/60 pt-2">
            <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              Events in this window
            </p>
            <ul className="grid grid-cols-1 gap-x-4 gap-y-0.5 text-[11px] sm:grid-cols-2">
              {data.events!.map(ev => {
                const gameIdx = data.games.findIndex(g => g.game_id === ev.game_id)
                const color = LINE_COLORS[Math.max(gameIdx, 0) % LINE_COLORS.length]
                const g = data.games[gameIdx]
                return (
                  <li key={ev.id} className="flex items-baseline gap-1.5">
                    <span aria-hidden style={{ color }}>●</span>
                    <span className="tabular-nums text-muted-foreground">{ev.event_date}</span>
                    <span className="truncate" title={`${g?.name ?? ''} — ${ev.name}`}>
                      {ev.name}
                      {g && <span className="text-muted-foreground"> — {g.name}</span>}
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
