import { TrendingUp, TrendingDown, Minus } from 'lucide-react'
import { Card, CardContent } from '../ui/card'
import { cn } from '../../lib/utils'
import type { DailySummary } from '../../types'

interface SummaryStatsRowProps {
  summary: DailySummary
}

export default function SummaryStatsRow({ summary }: SummaryStatsRowProps) {
  const total = summary.positive_count + summary.negative_count + summary.neutral_count
  const delta = summary.sentiment_trend_delta

  const DeltaIcon = delta == null ? Minus : delta > 0 ? TrendingUp : delta < 0 ? TrendingDown : Minus
  const deltaColor =
    delta == null ? 'text-muted-foreground'
    : delta > 0   ? 'text-green-600'
    : delta < 0   ? 'text-red-600'
    : 'text-slate-500'

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      <StatChip label="Positive" value={summary.positive_count} pct={total > 0 ? summary.positive_count / total : 0} color="text-green-600" />
      <StatChip label="Negative" value={summary.negative_count} pct={total > 0 ? summary.negative_count / total : 0} color="text-red-600" />
      <StatChip label="Neutral"  value={summary.neutral_count}  pct={total > 0 ? summary.neutral_count / total  : 0} color="text-slate-500" />

      {/* Delta chip */}
      <Card>
        <CardContent className="flex flex-col justify-center p-4">
          <p className="text-xs text-muted-foreground">Trend Δ</p>
          <div className={cn('mt-1 flex items-center gap-1 text-xl font-bold', deltaColor)}>
            <DeltaIcon className="h-4 w-4" />
            {delta == null ? 'N/A' : `${delta >= 0 ? '+' : ''}${(delta * 100).toFixed(1)}%`}
          </div>
          <p className="text-xs text-muted-foreground">vs prior period</p>
        </CardContent>
      </Card>
    </div>
  )
}

function StatChip({
  label, value, pct, color,
}: { label: string; value: number; pct: number; color: string }) {
  return (
    <Card>
      <CardContent className="flex flex-col justify-center p-4">
        <p className="text-xs text-muted-foreground">{label}</p>
        <p className={cn('mt-1 text-xl font-bold', color)}>{value.toLocaleString()}</p>
        <p className="text-xs text-muted-foreground">{(pct * 100).toFixed(1)}% of total</p>
      </CardContent>
    </Card>
  )
}
