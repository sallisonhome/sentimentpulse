import { useState } from 'react'
import { X, Plus, Trash2 } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '../ui/card'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Switch } from '../ui/switch'
import { Badge } from '../ui/badge'
import { useUpdateGameSettings } from '../../hooks/useGames'
import { useAddCompetitor, useCompetitors, useRemoveCompetitor } from '../../hooks/useCompetitors'
import { MAX_COMPETITORS_PER_PARENT } from '../../types'
import type { Game } from '../../types'
import CompetitorSubredditEditor from './CompetitorSubredditEditor'

interface GameSettingsCardProps {
  game: Game
}

export default function GameSettingsCard({ game }: GameSettingsCardProps) {
  const [isActive, setIsActive]       = useState(game.is_active)
  const [subreddits, setSubreddits]   = useState<string[]>(game.subreddits ?? [])
  const [subredditInput, setSubredditInput] = useState('')
  const [commercialContext, setCommercialContext] = useState<string>(game.commercial_context ?? '')
  const [showBrief, setShowBrief]     = useState(false)
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
      { is_active: isActive, subreddits, commercial_context: commercialContext },
      { onSuccess: () => setDirty(false) },
    )
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center justify-between text-base">
          <span>{game.name}</span>
          <div className="flex items-center gap-2 text-sm font-normal text-muted-foreground">
            <span>{isActive ? 'Visible' : 'Hidden'}</span>
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

        {/* Commercial-strategic context brief (CLAUDE.md §21) */}
        <div className="pt-1">
          <button
            type="button"
            onClick={() => setShowBrief(s => !s)}
            className="flex items-center justify-between w-full text-xs font-medium text-muted-foreground uppercase tracking-wide hover:text-foreground transition-colors"
          >
            <span>Commercial Strategic Context</span>
            <span className="text-[10px] normal-case font-normal">
              {commercialContext ? `${commercialContext.length} chars` : 'not set — using default'} · {showBrief ? 'hide' : 'edit'}
            </span>
          </button>
          {showBrief && (
            <div className="mt-2">
              <textarea
                value={commercialContext}
                onChange={e => { setCommercialContext(e.target.value); setDirty(true) }}
                placeholder={
                  "4-6 sentences telling the AI what comparisons are commercial assets (e.g. 'Resident Evil Requiem is the 2026 commercial benchmark; community comparisons to RE are an asset to amplify'), what tailwinds to ride, and what threats to differentiate from. Leave blank to use the default brief."
                }
                rows={6}
                className="w-full px-3 py-2 text-sm rounded-md border border-input bg-background placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring resize-y min-h-[140px]"
              />
              <p className="mt-1 text-[11px] text-muted-foreground">
                Read by the summary AI before generating recommendations.  Tells it to amplify positive commercial comparisons instead of counter-positioning away from them.
              </p>
            </div>
          )}
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

        {/* Competitor Titles */}
        <CompetitorTitlesSection parentId={game.id} parentName={game.name} />
      </CardContent>
    </Card>
  )
}

// ── Competitor Titles section ───────────────────────────────────────────────
// Lets the operator track up to MAX_COMPETITORS_PER_PARENT competing
// titles alongside this Saber title. Each competitor becomes a fully-
// fledged Game row (own subreddits, sentiment, topics, executive summary)
// linked to this game as its parent via the competitor_games join table.

function CompetitorTitlesSection({ parentId, parentName }: { parentId: number; parentName: string }) {
  const { data: competitors, isLoading } = useCompetitors(parentId)
  const addCompetitor = useAddCompetitor(parentId)
  const removeCompetitor = useRemoveCompetitor(parentId)
  const [appIdInput, setAppIdInput] = useState('')
  const [addError, setAddError] = useState<string | null>(null)
  const [editingCompetitorId, setEditingCompetitorId] = useState<number | null>(null)

  const count = competitors?.length ?? 0
  const atCapacity = count >= MAX_COMPETITORS_PER_PARENT

  async function handleAdd() {
    setAddError(null)
    const appId = parseInt(appIdInput.trim(), 10)
    if (!appId || appId <= 0) {
      setAddError('Enter a valid numeric Steam AppID.')
      return
    }
    try {
      await addCompetitor.mutateAsync(appId)
      setAppIdInput('')
    } catch (err) {
      setAddError(err instanceof Error ? err.message : 'Failed to add competitor')
    }
  }

  function handleRemove(id: number, name: string) {
    if (!confirm(`Remove ${name} as a competitor? This permanently deletes its posts, sentiment, and summaries.`)) return
    removeCompetitor.mutate(id)
    if (editingCompetitorId === id) setEditingCompetitorId(null)
  }

  return (
    <div className="pt-4 border-t">
      <p className="mb-0.5 text-xs font-medium text-muted-foreground uppercase tracking-wide">
        Competitor Titles
      </p>
      <p className="mb-3 text-[11px] text-muted-foreground">
        Track up to {MAX_COMPETITORS_PER_PARENT} competing titles alongside {parentName}. Each competitor is
        treated as a full game with its own subreddits, sentiment analysis, topics, and executive summary.
      </p>

      {isLoading ? (
        <p className="text-xs text-muted-foreground">Loading competitors…</p>
      ) : count === 0 ? (
        <p className="text-xs text-muted-foreground italic mb-3">No competitors tracked yet.</p>
      ) : (
        <div className="space-y-2 mb-3">
          {competitors!.map(c => (
            <div key={c.id} className="rounded-md border p-3 space-y-2">
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-sm font-medium truncate">{c.name}</p>
                  <p className="text-[11px] text-muted-foreground">
                    Steam App ID: {c.steam_app_id}
                    {c.release_date && <> · Released {c.release_date}</>}
                  </p>
                </div>
                <div className="flex items-center gap-1 flex-none">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => setEditingCompetitorId(id => (id === c.id ? null : c.id))}
                  >
                    {editingCompetitorId === c.id ? 'Hide subreddits' : 'Edit subreddits →'}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    onClick={() => handleRemove(c.id, c.name)}
                    aria-label={`Remove ${c.name} as a competitor`}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>
              {editingCompetitorId === c.id && (
                <CompetitorSubredditEditor competitorId={c.id} initialSubreddits={c.subreddits ?? []} />
              )}
            </div>
          ))}
        </div>
      )}

      {atCapacity ? (
        <p className="text-xs text-muted-foreground">
          Maximum of {MAX_COMPETITORS_PER_PARENT} competitors reached. Remove one to add another.
        </p>
      ) : (
        <div className="flex items-center gap-2">
          <Input
            placeholder="Steam AppID (e.g. 2138710)"
            value={appIdInput}
            onChange={e => setAppIdInput(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleAdd()}
            className="max-w-xs"
            disabled={addCompetitor.isPending}
          />
          <Button type="button" variant="outline" size="sm" onClick={handleAdd} disabled={addCompetitor.isPending}>
            <Plus className="mr-1 h-3.5 w-3.5" />
            {addCompetitor.isPending ? 'Looking up…' : 'Look up'}
          </Button>
        </div>
      )}
      {addError && <p className="mt-1 text-xs text-destructive">{addError}</p>}
    </div>
  )
}
