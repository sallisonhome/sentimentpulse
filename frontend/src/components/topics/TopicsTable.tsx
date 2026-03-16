import { ArrowUp, ArrowDown, Minus } from 'lucide-react'
import { format, parseISO } from 'date-fns'
import { Card, CardContent } from '../ui/card'
import SentimentBadge from '../shared/SentimentBadge'
import { cn } from '../../lib/utils'
import type { TopicTrend, TrendDirection } from '../../types'
import type { SortKey, SortDir } from './TopicFilters'

const TREND_CONFIG: Record<TrendDirection, { icon: typeof ArrowUp; class: string; label: string }> = {
  rising:  { icon: ArrowUp,   class: 'text-green-600', label: 'Rising'  },
  stable:  { icon: Minus,     class: 'text-slate-500', label: 'Stable'  },
  falling: { icon: ArrowDown, class: 'text-red-600',   label: 'Falling' },
}

interface TopicsTableProps {
  topics: TopicTrend[]
  sortKey: SortKey
  sortDir: SortDir
  onSortChange: (key: SortKey, dir: SortDir) => void
}

type Comparator = (a: TopicTrend, b: TopicTrend) => number

const COMPARATORS: Record<SortKey, Comparator> = {
  mention_count: (a, b) => b.mention_count - a.mention_count,
  velocity:      (a, b) => b.velocity - a.velocity,
  last_seen:     (a, b) => b.last_seen.localeCompare(a.last_seen),
  first_seen:    (a, b) => b.first_seen.localeCompare(a.first_seen),
  topic_label:   (a, b) => a.topic_label.localeCompare(b.topic_label),
}

const COLUMNS: { key: SortKey; label: string; align?: 'right' }[] = [
  { key: 'topic_label',   label: 'Topic'       },
  { key: 'mention_count', label: 'Mentions',  align: 'right' },
  { key: 'velocity',      label: 'Velocity',  align: 'right' },
  { key: 'last_seen',     label: 'Last Seen'  },
  { key: 'first_seen',    label: 'First Seen' },
]

export default function TopicsTable({ topics, sortKey, sortDir, onSortChange }: TopicsTableProps) {
  const sorted = [...topics].sort((a, b) => {
    const cmp = COMPARATORS[sortKey](a, b)
    return sortDir === 'asc' ? -cmp : cmp
  })

  function handleHeaderClick(key: SortKey) {
    if (key === sortKey) {
      onSortChange(key, sortDir === 'desc' ? 'asc' : 'desc')
    } else {
      onSortChange(key, key === 'topic_label' ? 'asc' : 'desc')
    }
  }

  return (
    <Card>
      <CardContent className="p-0">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/50">
                <th className="w-10 px-4 py-3 text-left text-xs font-medium text-muted-foreground">#</th>
                {COLUMNS.map(col => (
                  <th
                    key={col.key}
                    className={cn(
                      'px-4 py-3 text-xs font-medium text-muted-foreground cursor-pointer select-none hover:text-foreground transition-colors',
                      col.align === 'right' ? 'text-right' : 'text-left',
                    )}
                    onClick={() => handleHeaderClick(col.key)}
                  >
                    <span className="inline-flex items-center gap-1">
                      {col.label}
                      {sortKey === col.key && (
                        sortDir === 'desc'
                          ? <ArrowDown className="h-3 w-3" />
                          : <ArrowUp className="h-3 w-3" />
                      )}
                    </span>
                  </th>
                ))}
                <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground">Sentiment</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground">Trend</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((t, idx) => {
                const trend = TREND_CONFIG[t.trend_direction]
                const TrendIcon = trend.icon
                return (
                  <tr key={t.id} className="border-b last:border-0 hover:bg-muted/30 transition-colors">
                    <td className="px-4 py-3 text-xs text-muted-foreground tabular-nums">{idx + 1}</td>
                    <td className="px-4 py-3 font-medium">{t.topic_label}</td>
                    <td className="px-4 py-3 text-right tabular-nums">{t.mention_count.toLocaleString()}</td>
                    <td className="px-4 py-3 text-right tabular-nums">{t.velocity.toFixed(2)}</td>
                    <td className="px-4 py-3 text-muted-foreground text-xs">
                      {format(parseISO(t.last_seen), 'MMM d, yyyy')}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground text-xs">
                      {format(parseISO(t.first_seen), 'MMM d, yyyy')}
                    </td>
                    <td className="px-4 py-3">
                      <SentimentBadge sentiment={t.sentiment} />
                    </td>
                    <td className="px-4 py-3">
                      <span className={cn('inline-flex items-center gap-1 text-xs font-medium', trend.class)}>
                        <TrendIcon className="h-3 w-3" />
                        {trend.label}
                      </span>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  )
}
