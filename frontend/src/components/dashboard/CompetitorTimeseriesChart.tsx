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
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
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
  const { setSelectedGameId } = useAppContext()
  const { data, isLoading } = useCompetitorTimeseries(parentId, period)

  // Hidden entirely when the parent has no competitors — `games` contains
  // only the parent in that case. Also render nothing while loading so we
  // never flash an empty chart shell above/below neighboring cards.
  if (isLoading || !data || data.games.length <= 1) return null

  // Hover state for the event marker tooltip. Recharts' ReferenceLine
  // doesn't emit hover events natively, so we render invisible SVG
  // hitboxes over each marker and track which one is hovered here.
  const [hoveredEventId, setHoveredEventId] = useState<number | null>(null)

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
    // dashboard. Clicking a competitor switches the selected game and
    // returns to the Dashboard route (this app has no per-game URL
    // pattern; game selection is state-driven via AppContext).
    //
    // Persist the current parent to sessionStorage so the child dashboard
    // can render the "← Back to <parent>" breadcrumb even after a hard
    // refresh, and so back-nav within-app returns to the parent's
    // dashboard instead of falling back to /settings via the browser
    // history stack.
    if (isParent) return
    try {
      sessionStorage.setItem(
        `sp_parent_of_${gameId}`,
        JSON.stringify({ parent_id: parentId, ts: Date.now() }),
      )
    } catch { /* sessionStorage may be disabled; breadcrumb still works from API. */ }
    setSelectedGameId(gameId)
    navigate('/')
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Post Volume by Title</CardTitle>
        <p className="text-xs text-muted-foreground">
          Daily post volume comparison across parent title and competitors
        </p>
      </CardHeader>
      <CardContent>
        <ResponsiveContainer width="100%" height={240}>
          <LineChart data={formatted} margin={{ top: 4, right: 16, left: -8, bottom: 0 }}>
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
                return (
                  <span
                    onClick={() => handleLegendClick(g.game_id, g.is_parent)}
                    className={g.is_parent ? '' : 'hover:underline'}
                  >
                    {g.name}{g.is_parent ? ' (this title)' : ''}
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
                match the game each event belongs to. Only events whose
                event_date falls inside the current period window are in
                data.events (the backend filters). */}
            {(data.events ?? []).map(ev => {
              const gameIdx = data.games.findIndex(g => g.game_id === ev.game_id)
              if (gameIdx < 0) return null
              const color = LINE_COLORS[gameIdx % LINE_COLORS.length]
              // ReferenceLine x= must match the LineChart's dataKey for x,
              // which is date_label formatted as 'MMM d'. Convert the
              // ISO event_date the same way so the marker lines up.
              const dateLabel = format(parseISO(ev.event_date), 'MMM d')
              const isHovered = hoveredEventId === ev.id
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
                    value: '●',
                    position: 'top',
                    fill: color,
                    fontSize: isHovered ? 12 : 9,
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
