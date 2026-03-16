import { PieChart, Pie, Cell, Tooltip, ResponsiveContainer, type TooltipProps } from 'recharts'
import { Card, CardContent, CardHeader, CardTitle } from '../ui/card'
import type { SentimentCounts } from '../../types'

const SLICES = [
  { key: 'positive', label: 'Positive', color: '#22c55e' },
  { key: 'negative', label: 'Negative', color: '#ef4444' },
  { key: 'neutral',  label: 'Neutral',  color: '#94a3b8' },
] as const

interface SentimentDonutProps {
  sentiment: SentimentCounts
}

export default function SentimentDonut({ sentiment }: SentimentDonutProps) {
  const chartData = SLICES.map(s => ({
    name:  s.label,
    value: sentiment[s.key],
    color: s.color,
  })).filter(d => d.value > 0)

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Today's Breakdown</CardTitle>
      </CardHeader>
      <CardContent className="flex items-center gap-4">
        <ResponsiveContainer width={160} height={160}>
          <PieChart>
            <Pie
              data={chartData}
              cx="50%"
              cy="50%"
              innerRadius={48}
              outerRadius={72}
              paddingAngle={2}
              dataKey="value"
              strokeWidth={0}
            >
              {chartData.map((entry, i) => (
                <Cell key={i} fill={entry.color} />
              ))}
            </Pie>
            <Tooltip content={<DonutTooltip total={sentiment.total} />} />
          </PieChart>
        </ResponsiveContainer>

        {/* Legend */}
        <div className="flex flex-col gap-2 text-sm">
          {SLICES.map(s => (
            <div key={s.key} className="flex items-center gap-2">
              <span className="h-3 w-3 rounded-full flex-shrink-0" style={{ backgroundColor: s.color }} />
              <span className="text-muted-foreground">{s.label}</span>
              <span className="ml-auto font-medium tabular-nums">
                {sentiment.total > 0
                  ? `${((sentiment[s.key] / sentiment.total) * 100).toFixed(1)}%`
                  : '—'}
              </span>
            </div>
          ))}
          <div className="mt-1 border-t pt-1 text-xs text-muted-foreground">
            {sentiment.total.toLocaleString()} total
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

function DonutTooltip({ active, payload, total }: TooltipProps<number, string> & { total: number }) {
  if (!active || !payload?.length) return null
  const { name, value, color } = payload[0].payload
  const pct = total > 0 ? ((value / total) * 100).toFixed(1) : '0'
  return (
    <div className="rounded-md border bg-popover p-2 text-xs shadow-md">
      <p className="font-semibold" style={{ color }}>{name}</p>
      <p>{value.toLocaleString()} posts ({pct}%)</p>
    </div>
  )
}
