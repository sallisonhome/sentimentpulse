import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'
import type { Sentiment } from '../../types'

export type SortKey = 'mention_count' | 'velocity' | 'last_seen' | 'first_seen' | 'topic_label'
export type SortDir = 'asc' | 'desc'

interface TopicFiltersProps {
  sentiment: Sentiment | 'all'
  onSentimentChange: (v: Sentiment | 'all') => void
  sortKey: SortKey
  sortDir: SortDir
  onSortChange: (key: SortKey, dir: SortDir) => void
}

const SORT_OPTIONS: { value: string; label: string }[] = [
  { value: 'mention_count:desc', label: 'Most Mentions' },
  { value: 'velocity:desc',      label: 'Highest Velocity' },
  { value: 'last_seen:desc',     label: 'Recently Active' },
  { value: 'first_seen:desc',    label: 'Newest Topics' },
  { value: 'topic_label:asc',    label: 'A → Z' },
]

export default function TopicFilters({
  sentiment,
  onSentimentChange,
  sortKey,
  sortDir,
  onSortChange,
}: TopicFiltersProps) {
  const sortValue = `${sortKey}:${sortDir}`

  return (
    <div className="flex flex-wrap items-center gap-3">
      <Select value={sentiment} onValueChange={v => onSentimentChange(v as Sentiment | 'all')}>
        <SelectTrigger className="w-36">
          <SelectValue placeholder="Sentiment" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">All Sentiments</SelectItem>
          <SelectItem value="positive">Positive</SelectItem>
          <SelectItem value="negative">Negative</SelectItem>
          <SelectItem value="neutral">Neutral</SelectItem>
        </SelectContent>
      </Select>

      <Select
        value={sortValue}
        onValueChange={v => {
          const [key, dir] = v.split(':') as [SortKey, SortDir]
          onSortChange(key, dir)
        }}
      >
        <SelectTrigger className="w-44">
          <SelectValue placeholder="Sort by" />
        </SelectTrigger>
        <SelectContent>
          {SORT_OPTIONS.map(o => (
            <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}
