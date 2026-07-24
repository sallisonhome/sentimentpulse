import { useState } from 'react'
import { X, Plus } from 'lucide-react'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Badge } from '../ui/badge'
import { useUpdateGameSettings } from '../../hooks/useGames'

interface CompetitorSubredditEditorProps {
  competitorId: number
  initialSubreddits: string[]
}

/**
 * Inline subreddit add/remove editor for a competitor title, nested inside
 * its card in the Competitor Titles section of GameSettingsCard.
 *
 * There is no standalone reusable subreddit-editor component in this
 * codebase (Saber titles edit subreddits directly inline inside
 * GameSettingsCard) — this component adapts that same inline pattern so
 * competitors get identical subreddit-management UX via the existing
 * PATCH /api/games/{id} endpoint (which already applies to any Game row,
 * competitor or not).
 */
export default function CompetitorSubredditEditor({ competitorId, initialSubreddits }: CompetitorSubredditEditorProps) {
  const [subreddits, setSubreddits] = useState<string[]>(initialSubreddits)
  const [input, setInput] = useState('')
  const [dirty, setDirty] = useState(false)

  const { mutate: save, isPending, error } = useUpdateGameSettings(competitorId)

  function addSubreddit() {
    const val = input.trim().replace(/^r\//, '')
    if (!val || subreddits.includes(val)) return
    setSubreddits(prev => [...prev, val])
    setInput('')
    setDirty(true)
  }

  function removeSubreddit(name: string) {
    setSubreddits(prev => prev.filter(s => s !== name))
    setDirty(true)
  }

  function handleSave() {
    save({ subreddits }, { onSuccess: () => setDirty(false) })
  }

  return (
    <div className="rounded-md bg-muted/40 p-3 space-y-2">
      <p className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide">
        Tracked Subreddits
      </p>
      <div className="flex flex-wrap gap-1.5 min-h-[1.75rem]">
        {subreddits.length === 0 && (
          <span className="text-xs text-muted-foreground italic">None — Reddit posts will not be collected.</span>
        )}
        {subreddits.map(sub => (
          <Badge key={sub} variant="secondary" className="gap-1 pr-1">
            r/{sub}
            <button
              type="button"
              onClick={() => removeSubreddit(sub)}
              className="ml-0.5 rounded hover:text-destructive transition-colors"
              aria-label={`Remove r/${sub}`}
            >
              <X className="h-3 w-3" />
            </button>
          </Badge>
        ))}
      </div>
      <div className="flex items-center gap-2">
        <div className="relative flex-1 max-w-xs">
          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">r/</span>
          <Input
            placeholder="subreddit name"
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && addSubreddit()}
            className="pl-7 h-8 text-sm"
          />
        </div>
        <Button type="button" variant="outline" size="sm" onClick={addSubreddit}>
          <Plus className="mr-1 h-3.5 w-3.5" />
          Add
        </Button>
      </div>
      <div className="flex items-center justify-between pt-0.5">
        {error && <p className="text-xs text-destructive">{(error as Error).message}</p>}
        <div className="ml-auto">
          <Button size="sm" disabled={!dirty || isPending} onClick={handleSave}>
            {isPending ? 'Saving…' : 'Save subreddits'}
          </Button>
        </div>
      </div>
    </div>
  )
}
