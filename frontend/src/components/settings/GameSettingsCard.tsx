import { useState } from 'react'
import { X, Plus } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '../ui/card'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Switch } from '../ui/switch'
import { Badge } from '../ui/badge'
import { useUpdateGameSettings } from '../../hooks/useGames'
import type { Game } from '../../types'

interface GameSettingsCardProps {
  game: Game
}

export default function GameSettingsCard({ game }: GameSettingsCardProps) {
  const [isActive, setIsActive]       = useState(game.is_active)
  const [subreddits, setSubreddits]   = useState<string[]>(game.subreddits ?? [])
  const [subredditInput, setSubredditInput] = useState('')
  const [dirty, setDirty]             = useState(false)

  const { mutate: save, isPending, error } = useUpdateGameSettings(game.id)

  function addSubreddit() {
    const val = subredditInput.trim().replace(/^r\//, '')
    if (!val || subreddits.includes(val)) return
    setSubreddits(prev => [...prev, val])
    setSubredditInput('')
    setDirty(true)
  }

  function removeSubreddit(name: string) {
    setSubreddits(prev => prev.filter(s => s !== name))
    setDirty(true)
  }

  function handleActiveToggle(checked: boolean) {
    setIsActive(checked)
    setDirty(true)
  }

  function handleSave() {
    save(
      { is_active: isActive, subreddits },
      { onSuccess: () => setDirty(false) },
    )
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center justify-between text-base">
          <span>{game.name}</span>
          <div className="flex items-center gap-2 text-sm font-normal text-muted-foreground">
            <span>{isActive ? 'Tracking active' : 'Tracking paused'}</span>
            <Switch
              checked={isActive}
              onCheckedChange={handleActiveToggle}
            />
          </div>
        </CardTitle>
        <p className="text-xs text-muted-foreground">Steam App ID: {game.steam_app_id}</p>
      </CardHeader>

      <CardContent className="space-y-4">
        {/* Subreddit list */}
        <div>
          <p className="mb-2 text-xs font-medium text-muted-foreground uppercase tracking-wide">
            Tracked Subreddits
          </p>
          <div className="flex flex-wrap gap-1.5 min-h-[2rem]">
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

        {/* Add subreddit */}
        <div className="flex items-center gap-2">
          <div className="relative flex-1 max-w-xs">
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">r/</span>
            <Input
              placeholder="subreddit name"
              value={subredditInput}
              onChange={e => setSubredditInput(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && addSubreddit()}
              className="pl-7"
            />
          </div>
          <Button type="button" variant="outline" size="sm" onClick={addSubreddit}>
            <Plus className="mr-1 h-3.5 w-3.5" />
            Add
          </Button>
        </div>

        {/* Save row */}
        <div className="flex items-center justify-between pt-1">
          {error && (
            <p className="text-xs text-destructive">{(error as Error).message}</p>
          )}
          <div className="ml-auto">
            <Button
              size="sm"
              disabled={!dirty || isPending}
              onClick={handleSave}
            >
              {isPending ? 'Saving…' : 'Save changes'}
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
