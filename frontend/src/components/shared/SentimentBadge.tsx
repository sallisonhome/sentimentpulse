import { Badge } from '../ui/badge'
import { cn } from '../../lib/utils'
import type { Sentiment } from '../../types'

const SENTIMENT_STYLES: Record<Sentiment, string> = {
  positive: 'border-transparent bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200',
  negative: 'border-transparent bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200',
  neutral:  'border-transparent bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300',
}

interface SentimentBadgeProps {
  sentiment: Sentiment
  className?: string
}

export default function SentimentBadge({ sentiment, className }: SentimentBadgeProps) {
  return (
    <Badge className={cn(SENTIMENT_STYLES[sentiment], className)}>
      {sentiment.charAt(0).toUpperCase() + sentiment.slice(1)}
    </Badge>
  )
}
