import { Card, CardContent, CardHeader, CardTitle } from '../ui/card'
import { Badge } from '../ui/badge'
import { cn } from '../../lib/utils'

interface SummaryTopicsRowProps {
  positive: string[] | null
  negative: string[] | null
  neutral:  string[] | null
}

const COLUMN_CONFIG = [
  { key: 'positive' as const, label: 'Top Positive Topics', badgeClass: 'border-transparent bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200' },
  { key: 'negative' as const, label: 'Top Negative Topics', badgeClass: 'border-transparent bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200' },
  { key: 'neutral'  as const, label: 'Top Neutral Topics',  badgeClass: 'border-transparent bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300' },
]

export default function SummaryTopicsRow({ positive, negative, neutral }: SummaryTopicsRowProps) {
  const dataMap = { positive, negative, neutral }

  return (
    <div className="grid gap-4 md:grid-cols-3">
      {COLUMN_CONFIG.map(col => {
        const topics = dataMap[col.key] ?? []
        return (
          <Card key={col.key}>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium">{col.label}</CardTitle>
            </CardHeader>
            <CardContent>
              {topics.length === 0 ? (
                <p className="text-xs text-muted-foreground">None recorded.</p>
              ) : (
                <div className="flex flex-wrap gap-1.5">
                  {topics.map(topic => (
                    <Badge key={topic} className={cn('text-xs', col.badgeClass)}>
                      {topic}
                    </Badge>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        )
      })}
    </div>
  )
}
