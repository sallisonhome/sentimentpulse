import { useState, type FormEvent } from 'react'
import { Search, X } from 'lucide-react'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'
import { Input } from '../ui/input'
import { Button } from '../ui/button'
import type { Sentiment, Source } from '../../types'

interface PostFiltersProps {
  sentiment: Sentiment | 'all'
  source: Source | 'all'
  search: string
  onSentimentChange: (v: Sentiment | 'all') => void
  onSourceChange: (v: Source | 'all') => void
  onSearchChange: (v: string) => void
}

export default function PostFilters({
  sentiment,
  source,
  search,
  onSentimentChange,
  onSourceChange,
  onSearchChange,
}: PostFiltersProps) {
  const [draft, setDraft] = useState(search)

  function handleSubmit(e: FormEvent) {
    e.preventDefault()
    onSearchChange(draft.trim())
  }

  function handleClear() {
    setDraft('')
    onSearchChange('')
  }

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

      <Select value={source} onValueChange={v => onSourceChange(v as Source | 'all')}>
        <SelectTrigger className="w-40">
          <SelectValue placeholder="Source" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">All Sources</SelectItem>
          <SelectItem value="steam_review">Steam Reviews</SelectItem>
          <SelectItem value="steam_forum">Steam Forums</SelectItem>
          <SelectItem value="reddit">Reddit</SelectItem>
          <SelectItem value="bluesky">Bluesky</SelectItem>
          <SelectItem value="dtf">DTF</SelectItem>
        </SelectContent>
      </Select>

      <form onSubmit={handleSubmit} className="flex items-center gap-2">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search posts…"
            value={draft}
            onChange={e => setDraft(e.target.value)}
            className="w-56 pl-9 pr-8"
          />
          {draft && (
            <button
              type="button"
              onClick={handleClear}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
        <Button type="submit" variant="outline" size="sm">Search</Button>
      </form>
    </div>
  )
}
