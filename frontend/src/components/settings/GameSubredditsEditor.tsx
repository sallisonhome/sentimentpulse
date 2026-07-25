import { useState } from 'react'
import { X, Plus } from 'lucide-react'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Badge } from '../ui/badge'
import { useUpdateGameSettings } from '../../hooks/useGames'
import type { Game, CompetitorGame } from '../../types'

interface GameSubredditsEditorProps {
  /** The game (parent Saber title OR competitor title) these subreddits belong to. */
  game: Game | CompetitorGame
  /** Optional: render a smaller/compact variant for nested competitor cards. */
  compact?: boolean
}

/**
 * Reusable tracked-subreddits editor: chip list + `r/ subreddit name` input +
 * "+ Add subreddit" button + its own "Save changes" button.
 *
 * This is the ONLY place subreddit state lives. It is always instantiated
 * with a single `game` (whichever game — parent or competitor — it belongs
 * to) and saves exclusively to THAT game's id via `PATCH /api/games/{game.id}`.
 * There is no shared state and no way for a save here to reach any other
 * game's record — each card mounts its own independent instance of this
 * component bound to its own game id.
 */
export default function GameSubredditsEditor({ game, compact = false }: GameSubredditsEditorProps) {
  const [subreddits, setSubreddits] = useState<string[]>(game.subreddits ?? [])
  const [input, setInput] = useState('')
  const [dirty, setDirty] = useState(false)

  // Bound to this specific game's id — the mutation target never changes.
  const { mutate: save, isPending, error } = useUpdateGameSettings(game.id)

  function addSubreddit() {
    const val = input.trim().replace(/^r\//, '')
    if (!val || subreddits.includes(val)) return
    // Defense-in-depth (2026-07-24): reject purely-numeric input. A real
    // subreddit name must contain at least one letter (Reddit enforces
    // this itself — numeric-only handles were never allowed). This is
    // a belt-and-suspenders guard on top of the redesigned Settings UX
    // that separates the subreddit input from the competitor-AppID input,
    // catching the failure mode where a user accidentally pastes a
    // Steam AppID here instead of into the Competitor input below.
    if (!/[a-zA-Z]/.test(val)) {
      // eslint-disable-next-line no-alert
      alert(
        `"${val}" doesn't look like a subreddit name — real subreddits contain letters. ` +
        `If you meant to add a competitor title by Steam AppID, scroll down to the ` +
        `"Competitor Titles" section and use the input there.`,
      )
      return
    }
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
    <div className={compact ? 'space-y-2' : 'space-y-3'}>
      <div>
        <p className="mb-2 text-xs font-medium text-muted-foreground uppercase tracking-wide">
          Tracked Subreddits
        </p>
        <div className={`flex flex-wrap gap-1.5 ${compact ? 'min-h-[1.75rem]' : 'min-h-[2rem]'}`}>
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
      </div>

      {/* Add subreddit — standard styling, no tint. Intentionally the visual
          opposite of the dashed/tinted "Add competitor title" input so the
          two can never be mistaken for one another. */}
      <div className="flex items-center gap-2">
        <div className="relative flex-1 max-w-xs">
          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">r/</span>
          <Input
            placeholder="subreddit name"
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && addSubreddit()}
            className={compact ? 'pl-7 h-8 text-sm' : 'pl-7'}
          />
        </div>
        <Button type="button" variant="outline" size="sm" onClick={addSubreddit}>
          <Plus className="mr-1 h-3.5 w-3.5" />
          Add subreddit
        </Button>
      </div>

      <div className="flex items-center justify-between pt-0.5">
        {error && <p className="text-xs text-destructive">{(error as Error).message}</p>}
        <div className="ml-auto">
          <Button size="sm" disabled={!dirty || isPending} onClick={handleSave}>
            {isPending ? 'Saving…' : 'Save changes'}
          </Button>
        </div>
      </div>
    </div>
  )
}
