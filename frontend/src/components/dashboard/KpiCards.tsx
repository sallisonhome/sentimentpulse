import { TrendingUp, TrendingDown, Minus } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '../ui/card'
import { cn } from '../../lib/utils'
import type { Period, SentimentCounts, SentimentVelocity } from '../../types'

const VELOCITY_CONFIG = {
  improving: { icon: TrendingUp,   color: 'text-green-600', label: 'Improving' },
  stable:    { icon: Minus,        color: 'text-slate-500',  label: 'Stable'    },
  declining: { icon: TrendingDown, color: 'text-red-600',   label: 'Declining' },
}

const PERIOD_LABELS: Record<Period, string> = {
  today:     'collected today',
  weekly:    'over 7 days',
  monthly:   'over 30 days',
  quarterly: 'over 90 days',
  lifetime:  'all time',
}

interface KpiCardsProps {
  sentiment: SentimentCounts
  velocity: SentimentVelocity
  period: Period
}

export default function KpiCards({ sentiment, velocity, period }: KpiCardsProps) {
  const vel = VELOCITY_CONFIG[velocity.direction]
  const VelIcon = vel.icon

  // Format the pos/neg ratio as a percentage: positive / (positive + negative) * 100
  const posNegTotal = sentiment.positive + sentiment.negative
  const ratioPct = posNegTotal > 0 ? (sentiment.positive / posNegTotal) * 100 : null
  const ratioValue = ratioPct != null ? `${ratioPct.toFixed(1)}%` : 'N/A'
  const ratioColor = ratioPct != null
    ? ratioPct >= 66 ? 'text-green-600'
      : ratioPct >= 50 ? 'text-amber-500'
      : 'text-red-600'
    : 'text-slate-500'

  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-6">
      <StatCard
        title="Total Posts"
        value={sentiment.total.toLocaleString()}
        sub={PERIOD_LABELS[period]}
      />

      {/* Positive/Negative Ratio — right of Total Posts */}
      <StatCard
        title="Pos/Neg Ratio"
        value={ratioValue}
        sub={`${sentiment.positive.toLocaleString()} pos / ${sentiment.negative.toLocaleString()} neg`}
        valueClass={ratioColor}
      />

      {/* Velocity card — right of Ratio */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium text-muted-foreground">Sentiment Velocity</CardTitle>
        </CardHeader>
        <CardContent>
          <div className={cn('flex items-center gap-2 text-2xl font-bold', vel.color)}>
            <VelIcon className="h-5 w-5" />
            {vel.label}
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            {velocity.delta_avg != null
              ? `${velocity.delta_avg >= 0 ? '+' : ''}${(velocity.delta_avg * 100).toFixed(1)}pp ${period === 'today' ? 'vs yesterday' : 'shift'}`
              : 'Insufficient data'}
          </p>
        </CardContent>
      </Card>

      <StatCard
        title="Positive"
        value={`${sentiment.positive_pct.toFixed(1)}%`}
        sub={`${sentiment.positive.toLocaleString()} posts`}
        valueClass="text-green-600"
      />
      <StatCard
        title="Negative"
        value={`${sentiment.negative_pct.toFixed(1)}%`}
        sub={`${sentiment.negative.toLocaleString()} posts`}
        valueClass="text-red-600"
      />
      <StatCard
        title="Neutral"
        value={`${sentiment.neutral_pct.toFixed(1)}%`}
        sub={`${sentiment.neutral.toLocaleString()} posts`}
        valueClass="text-slate-500"
      />
    </div>
  )
}

interface StatCardProps {
  title: string
  value: string
  sub: string
  valueClass?: string
}

function StatCard({ title, value, sub, valueClass }: StatCardProps) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">{title}</CardTitle>
      </CardHeader>
      <CardContent>
        <p className={cn('text-2xl font-bold', valueClass)}>{value}</p>
        <p className="mt-1 text-xs text-muted-foreground">{sub}</p>
      </CardContent>
    </Card>
  )
}
