import { ArrowUp, ArrowDown, Minus } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '../ui/card'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../ui/tabs'
import { cn } from '../../lib/utils'
import type { TopicItem, TrendDirection } from '../../types'

const TREND_CONFIG: Record<TrendDirection, { icon: typeof ArrowUp; class: string; label: string }> = {
  rising:  { icon: ArrowUp,   class: 'text-green-600',  label: 'Rising'  },
  stable:  { icon: Minus,     class: 'text-slate-500',  label: 'Stable'  },
  falling: { icon: ArrowDown, class: 'text-red-600',    label: 'Falling' },
}

interface TopTopicsPanelProps {
  positive: TopicItem[]
  negative: TopicItem[]
  neutral:  TopicItem[]
}

export default function TopTopicsPanel({ positive, negative, neutral }: TopTopicsPanelProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Top Topics</CardTitle>
      </CardHeader>
      <CardContent>
        <Tabs defaultValue="negative">
          <TabsList className="mb-3">
            <TabsTrigger value="positive">Positive</TabsTrigger>
            <TabsTrigger value="negative">Negative</TabsTrigger>
            <TabsTrigger value="neutral">Neutral</TabsTrigger>
          </TabsList>
          <TabsContent value="positive"><TopicList items={positive} /></TabsContent>
          <TabsContent value="negative"><TopicList items={negative} /></TabsContent>
          <TabsContent value="neutral"><TopicList items={neutral} /></TabsContent>
        </Tabs>
      </CardContent>
    </Card>
  )
}

function TopicList({ items }: { items: TopicItem[] }) {
  if (!items.length) {
    return <p className="text-sm text-muted-foreground py-4 text-center">No topics found.</p>
  }

  const max = Math.max(...items.map(i => i.mention_count), 1)

  return (
    <ol className="space-y-2">
      {items.map((item, idx) => {
        const trend = TREND_CONFIG[item.trend_direction]
        const TrendIcon = trend.icon
        const barWidth = Math.round((item.mention_count / max) * 100)

        return (
          <li key={item.topic_label} className="flex items-center gap-3 text-sm">
            <span className="w-5 text-right text-xs text-muted-foreground tabular-nums">{idx + 1}</span>

            <div className="flex flex-1 flex-col gap-0.5">
              <div className="flex items-center justify-between">
                <span className="font-medium truncate">{item.topic_label}</span>
                <span className="ml-2 flex items-center gap-1 text-xs text-muted-foreground tabular-nums whitespace-nowrap">
                  <TrendIcon className={cn('h-3 w-3', trend.class)} />
                  {item.mention_count.toLocaleString()}
                </span>
              </div>
              {/* Mini bar */}
              <div className="h-1 w-full rounded-full bg-muted">
                <div
                  className="h-1 rounded-full bg-primary/50"
                  style={{ width: `${barWidth}%` }}
                />
              </div>
            </div>
          </li>
        )
      })}
    </ol>
  )
}
