import {
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  type TooltipProps,
} from 'recharts'
import { format, parseISO } from 'date-fns'
import { Card, CardContent, CardHeader, CardTitle } from '../ui/card'
import { sourceLabel } from '../../lib/utils'
import type { VolumePoint } from '../../types'

const SOURCE_COLORS = {
  steam_review: '#3b82f6',
  steam_forum:  '#a855f7',
  reddit:       '#f97316',
  bluesky:      '#0085ff',  // Bluesky brand blue
}

interface VolumeBySourceChartProps {
  data: VolumePoint[]
}

export default function VolumeBySourceChart({ data }: VolumeBySourceChartProps) {
  const formatted = data.map(d => ({
    ...d,
    date_label: format(parseISO(d.day), 'MMM d'),
  }))

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Post Volume by Source</CardTitle>
      </CardHeader>
      <CardContent>
        <ResponsiveContainer width="100%" height={220}>
          <BarChart data={formatted} margin={{ top: 4, right: 16, left: -8, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" className="stroke-border" vertical={false} />
            <XAxis
              dataKey="date_label"
              tick={{ fontSize: 11 }}
              tickLine={false}
              axisLine={false}
            />
            <YAxis
              tick={{ fontSize: 11 }}
              tickLine={false}
              axisLine={false}
              allowDecimals={false}
            />
            <Tooltip content={<VolumeTooltip />} />
            <Legend
              formatter={v => sourceLabel(v)}
              iconSize={10}
              wrapperStyle={{ fontSize: 11 }}
            />
            <Bar dataKey="steam_review" stackId="a" fill={SOURCE_COLORS.steam_review} radius={[0, 0, 0, 0]} />
            <Bar dataKey="steam_forum"  stackId="a" fill={SOURCE_COLORS.steam_forum}  radius={[0, 0, 0, 0]} />
            <Bar dataKey="reddit"       stackId="a" fill={SOURCE_COLORS.reddit}       radius={[0, 0, 0, 0]} />
            <Bar dataKey="bluesky"      stackId="a" fill={SOURCE_COLORS.bluesky}      radius={[3, 3, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </CardContent>
    </Card>
  )
}

function VolumeTooltip({ active, payload, label }: TooltipProps<number, string>) {
  if (!active || !payload?.length) return null
  const total = payload.reduce((sum, p) => sum + ((p.value as number) ?? 0), 0)
  return (
    <div className="rounded-md border bg-popover p-3 text-xs shadow-md space-y-1">
      <p className="font-semibold">{label}</p>
      {payload.map(p => (
        <p key={p.dataKey} style={{ color: p.fill }}>
          {sourceLabel(p.dataKey as string)}: {(p.value as number).toLocaleString()}
        </p>
      ))}
      <p className="border-t pt-1 text-muted-foreground">Total: {total.toLocaleString()}</p>
    </div>
  )
}
