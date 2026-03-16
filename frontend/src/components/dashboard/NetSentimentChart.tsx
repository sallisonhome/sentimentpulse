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

interface NetSentimentChartProps {
  data: NetSentimentPoint[]
}

export default function NetSentimentChart({ data }: NetSentimentChartProps) {
  const formatted = data.map(d => ({
    ...d,
    date_label: format(parseISO(d.summary_date), 'MMM d'),
    net_pct: parseFloat((d.net_sentiment * 100).toFixed(1)),
  }))

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
            <Tooltip content={<NetSentimentTooltip />} />
            <Line
              type="monotone"
              dataKey="net_pct"
              stroke="#22c55e"
              strokeWidth={2}
              dot={false}
              activeDot={{ r: 4 }}
            />
          </LineChart>
        </ResponsiveContainer>
      </CardContent>
    </Card>
  )
}

function NetSentimentTooltip({ active, payload, label }: TooltipProps<number, string>) {
  if (!active || !payload?.length) return null
  const d = payload[0].payload as NetSentimentPoint & { date_label: string; net_pct: number }
  return (
    <div className="rounded-md border bg-popover p-3 text-xs shadow-md">
      <p className="font-semibold mb-1">{d.date_label}</p>
      <p>Net sentiment: <span className={d.net_pct >= 0 ? 'text-green-600' : 'text-red-600'}>{d.net_pct >= 0 ? '+' : ''}{d.net_pct}%</span></p>
      <p className="text-muted-foreground mt-1">
        +{d.positive_count} / -{d.negative_count} / ~{d.neutral_count} &nbsp;({d.total} total)
      </p>
    </div>
  )
}
