import { TrendingUp, TrendingDown, Minus } from 'lucide-react'
import { Card, CardContent } from '../ui/card'
import { cn } from '../../lib/utils'
import type { DailySummary } from '../../types'

interface SummaryStatsRowProps {
  summary: DailySummary
}

export default function SummaryStatsRow({ summary }: SummaryStatsRowProps) {
  const total = summary.positive_count + summary.negative_count + summary.neutral_count
  const pos = summary.positive_count
  const neg = summary.negative_count

  // Positive/Negative Ratio as percentage: positive / (positive + negative) * 100
  const posNegTotal = pos + neg
  const ratioPct = posNegTotal > 0 ? (pos / posNegTotal) * 100 : null
  const ratioDisplay = ratioPct != null ? `${ratioPct.toFixed(1)}%` : 'N/A'
  const ratioColor = ratioPct != null
    ? ratioPct >= 66 ? 'text-green-600'
      : ratioPct >= 50 ? 'text-amber-500'
      : 'text-red-600'
    : 'text-muted-foreground'

  // Sentiment Velocity (based on trend delta as proxy for ratio change)
  const delta = summary.sentiment_trend_delta
  const VelIcon = delta == null ? Minus : delta > 0 ? TrendingUp : delta < 0 ? TrendingDown : Minus
  const velLabel = delta == null ? 'Stable' : delta > 0.02 ? 'Improving' : delta < -0.02 ? 'Declining' : 'Stable'
  const velColor =
    delta == null ? 'text-muted-foreground'
    : delta > 0.02 ? 'text-green-600'
    : delta < -0.02 ? 'text-red-600'
    : 'text-slate-500'

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
      {/* Pos/Neg Ratio — far left */}
      <Card>
        <CardContent className="flex flex-col justify-center p-4">
          <p className="text-xs text-muted-foreground">Pos/Neg Ratio</p>
          <p className={cn('mt-1 text-xl font-bold', ratioColor)}>{ratioDisplay}</p>
          <p className="text-xs text-muted-foreground">{pos.toLocaleString()} pos / {neg.toLocaleString()} neg</p>
        </CardContent>
      </Card>

      {/* Sentiment Velocity — right of Ratio */}
      <Card>
        <CardContent className="flex flex-col justify-center p-4">
          <p className="text-xs text-muted-foreground">Sentiment Velocity</p>
          <div className={cn('mt-1 flex items-center gap-1 text-xl font-bold', velColor)}>
            <VelIcon className="h-4 w-4" />
            {velLabel}
          </div>
          <p className="text-xs text-muted-foreground">based on ratio trend</p>
        </CardContent>
      </Card>

      <StatChip label="Positive" value={pos} pct={total > 0 ? pos / total : 0} color="text-green-600" />
      <StatChip label="Negative" value={neg} pct={total > 0 ? neg / total : 0} color="text-red-600" />
      <StatChip label="Neutral"  value={summary.neutral_count}  pct={total > 0 ? summary.neutral_count / total  : 0} color="text-slate-500" />
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
