import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  type TooltipProps,
} from 'recharts'
import { format, parseISO } from 'date-fns'
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

  const formatted = data.timeseries.map(point => ({
    ...point,
    date_label: format(parseISO(point.day), 'MMM d'),
  }))

  function handleLegendClick(gameId: number, isParent: boolean) {
    // Clicking the parent's own name is a no-op — we're already on its
    // dashboard. Clicking a competitor switches the selected game and
    // returns to the Dashboard route (this app has no per-game URL
    // pattern; game selection is state-driven via AppContext).
    if (isParent) return
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
          </LineChart>
        </ResponsiveContainer>
        <p className="mt-2 text-[11px] text-muted-foreground">
          Click a competitor's name in the legend to open its full dashboard.
        </p>
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
