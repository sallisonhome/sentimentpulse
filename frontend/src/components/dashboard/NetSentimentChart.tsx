import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ReferenceLine,
  type TooltipProps,
} from 'recharts'
import { format, parseISO } from 'date-fns'
import { Card, CardContent, CardHeader, CardTitle } from '../ui/card'
import type { NetSentimentPoint } from '../../types'
import { useAppContext } from '../../contexts/AppContext'
import { useTimelineEvents } from '../../hooks/useTimelineEvents'

interface NetSentimentChartProps {
  data: NetSentimentPoint[]
}

export default function NetSentimentChart({ data }: NetSentimentChartProps) {
  const { selectedGameId } = useAppContext()
  // Timeline events for the currently-selected game. The
  // useTimelineEvents hook is safe to call for ANY game (it returns an
  // empty array when the game has no events or when the game is
  // standalone). No conditional useQuery invocation here — always the
  // same hook order for React.
  const { data: events } = useTimelineEvents(selectedGameId)

  const formatted = data.map(d => ({
    ...d,
    date_label: format(parseISO(d.summary_date), 'MMM d'),
    net_pct: parseFloat((d.net_sentiment * 100).toFixed(1)),
  }))

  // Filter events to the currently-visible date range so we don't render
  // markers that fall off the chart edges. The trend data already
  // reflects the selected period (7d/30d/90d/all), so we intersect
  // against its first/last date_label — exact string match is fine
  // because we format both sides with the same 'MMM d' formatter.
  const visibleDateLabels = new Set(formatted.map(f => f.date_label))
  const inWindowEvents = (events ?? [])
    .map(ev => ({ ...ev, date_label: format(parseISO(ev.event_date), 'MMM d') }))
    .filter(ev => visibleDateLabels.has(ev.date_label))

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Net Sentiment Trend</CardTitle>
      </CardHeader>
      <CardContent>
        <ResponsiveContainer width="100%" height={220}>
          <LineChart data={formatted} margin={{ top: 4, right: 16, left: -8, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
            <XAxis
              dataKey="date_label"
              tick={{ fontSize: 11 }}
              tickLine={false}
              axisLine={false}
            />
            <YAxis
              tickFormatter={v => `${v}%`}
              tick={{ fontSize: 11 }}
              tickLine={false}
              axisLine={false}
            />
            <ReferenceLine y={0} stroke="hsl(var(--border))" strokeDasharray="4 4" />
            <Tooltip content={<NetSentimentTooltip events={inWindowEvents} />} />
            <Line
              type="monotone"
              dataKey="net_pct"
              stroke="#22c55e"
              strokeWidth={2}
              dot={false}
              activeDot={{ r: 4 }}
            />
            {/* Event markers — dashed vertical lines colored per event.
                Using the same slate-blue color for all events on this
                chart since it's a single-game view; the Post Volume by
                Title chart uses per-game colors because it's multi-line. */}
            {inWindowEvents.map(ev => (
              <ReferenceLine
                key={`ev-${ev.id}`}
                x={ev.date_label}
                stroke="#f59e0b"
                strokeDasharray="4 3"
                strokeWidth={1.5}
                strokeOpacity={0.85}
                ifOverflow="visible"
                isFront
                label={{ value: '●', position: 'top', fill: '#f59e0b', fontSize: 10 }}
              />
            ))}
          </LineChart>
        </ResponsiveContainer>

        {/* Compact event list under the chart, matching the pattern used
            by the Post Volume by Title chart. Only shown when there are
            in-window events, so most single-game dashboards stay
            uncluttered. */}
        {inWindowEvents.length > 0 && (
          <div className="mt-3 border-t border-border/60 pt-2">
            <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              Timeline events in this window
            </p>
            <ul className="grid grid-cols-1 gap-x-4 gap-y-0.5 text-[11px] sm:grid-cols-2">
              {inWindowEvents.map(ev => (
                <li key={ev.id} className="flex items-baseline gap-1.5">
                  <span aria-hidden style={{ color: '#f59e0b' }}>●</span>
                  <span className="tabular-nums text-muted-foreground">{ev.event_date}</span>
                  <span className="truncate" title={ev.name}>{ev.name}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

function NetSentimentTooltip({
  active,
  payload,
  label,
  events,
}: TooltipProps<number, string> & { events: { date_label: string; name: string }[] }) {
  if (!active || !payload?.length) return null
  const d = payload[0].payload as NetSentimentPoint & { date_label: string; net_pct: number }
  // Any event whose date matches the currently-hovered X label surfaces
  // in the tooltip so users see WHY the sentiment moved on that day.
  const dayEvents = events.filter(ev => ev.date_label === d.date_label)
  return (
    <div className="rounded-md border bg-popover p-3 text-xs shadow-md">
      <p className="font-semibold mb-1">{d.date_label}</p>
      <p>Net sentiment: <span className={d.net_pct >= 0 ? 'text-green-600' : 'text-red-600'}>{d.net_pct >= 0 ? '+' : ''}{d.net_pct}%</span></p>
      <p className="text-muted-foreground mt-1">
        +{d.positive_count} / -{d.negative_count} / ~{d.neutral_count} &nbsp;({d.total} total)
      </p>
      {dayEvents.length > 0 && (
        <div className="mt-1.5 border-t border-border/60 pt-1.5">
          {dayEvents.map((ev, i) => (
            <p key={i} className="flex items-baseline gap-1">
              <span aria-hidden style={{ color: '#f59e0b' }}>●</span>
              <span className="font-medium">{ev.name}</span>
            </p>
          ))}
        </div>
      )}
    </div>
  )
}
