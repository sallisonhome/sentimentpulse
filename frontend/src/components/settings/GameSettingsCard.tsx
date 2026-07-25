import { useState } from 'react'
import { Plus } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '../ui/card'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Switch } from '../ui/switch'
import { Label } from '../ui/label'
import { useUpdateGameSettings } from '../../hooks/useGames'
import { useAddCompetitor, useCompetitors, useRemoveCompetitor } from '../../hooks/useCompetitors'
import { MAX_COMPETITORS_PER_PARENT } from '../../types'
import type { Game } from '../../types'
import GameSubredditsEditor from './GameSubredditsEditor'
import CompetitorGameCard from './CompetitorGameCard'

interface GameSettingsCardProps {
  game: Game
}

/**
 * Settings card for a top-level Saber title (parent game).
 *
 * Layout, top to bottom:
 *  1. Header — name, Steam AppID, Visible/Hidden toggle
 *  2. Tracked Subreddits (via <GameSubredditsEditor>, bound to this game's id)
 *  3. Commercial Strategic Context
 *  4. Save changes (parent-level fields only: is_active + commercial_context —
 *     subreddits saving is now owned entirely by GameSubredditsEditor)
 *  5. Competitor Titles section — visually separated (border-t + muted bg),
 *     each competitor rendered as its own full <CompetitorGameCard>, with a
 *     distinctly-styled "Add competitor title" zone below them.
 *
 * The parent's subreddits editor and the "Add competitor title" input are
 * two different components with two different mutation targets (this game's
 * id vs. the competitors endpoint) — there is no shared state, so a value
 * typed into one can never land in the other.
 */
export default function GameSettingsCard({ game }: GameSettingsCardProps) {
  const [isActive, setIsActive] = useState(game.is_active)
  const [commercialContext, setCommercialContext] = useState<string>(game.commercial_context ?? '')
  const [showBrief, setShowBrief] = useState(false)
  const [dirty, setDirty] = useState(false)

  const { mutate: save, isPending, error } = useUpdateGameSettings(game.id)

  function handleActiveToggle(checked: boolean) {
    setIsActive(checked)
    setDirty(true)
  }

  function handleSave() {
    // Parent-level fields only — never touches subreddits (owned by
    // GameSubredditsEditor) and never touches competitors.
    save(
      { is_active: isActive, commercial_context: commercialContext },
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
        {/* Tracked subreddits — owns its own state + save, scoped to this game's id */}
        <GameSubredditsEditor game={game} />

        {/* Commercial-strategic context brief (CLAUDE.md §21) */}
        <div className="pt-1 border-t">
          <button
            type="button"
            onClick={() => setShowBrief(s => !s)}
            className="flex items-center justify-between w-full text-xs font-medium text-muted-foreground uppercase tracking-wide hover:text-foreground transition-colors pt-3"
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

        {/* Save row — parent-level fields (is_active, commercial_context) only */}
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
// Visually separated from everything above it (border-t + muted/tinted
// background) so it reads as a distinct zone of the card, and the
// "Add competitor title" input is deliberately styled to look nothing like
// the subreddit input above it.

function CompetitorTitlesSection({ parentId, parentName }: { parentId: number; parentName: string }) {
  const { data: competitors, isLoading } = useCompetitors(parentId)
  const addCompetitor = useAddCompetitor(parentId)
  const removeCompetitor = useRemoveCompetitor(parentId)
  const [appIdInput, setAppIdInput] = useState('')
  const [addError, setAddError] = useState<string | null>(null)

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
  }

  return (
    <div className="-mx-6 -mb-6 mt-2 px-6 pb-6 pt-4 border-t bg-muted/20">
      <div className="flex items-start justify-between gap-3 mb-0.5">
        <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
          Competitor Titles
        </p>
        <p className="text-[11px] text-muted-foreground whitespace-nowrap">
          {count} of {MAX_COMPETITORS_PER_PARENT} tracked
        </p>
      </div>
      <p className="mb-3 text-[11px] text-muted-foreground max-w-md">
        Track up to {MAX_COMPETITORS_PER_PARENT} competing titles alongside {parentName}. Each competitor is
        treated as a full game with its own subreddits, sentiment analysis, topics, and executive summary.
      </p>

      {isLoading ? (
        <p className="text-xs text-muted-foreground">Loading competitors…</p>
      ) : count === 0 ? (
        <p className="text-xs text-muted-foreground italic mb-3">
          No competitors tracked yet. Add one below to compare its sentiment against {parentName}.
        </p>
      ) : (
        // Indented ~24px + left-border accent to signal these cards are
        // children of the parent, stacked vertically.
        <div className="space-y-3 mb-4 pl-6 border-l-2 border-muted">
          {competitors!.map(c => (
            <CompetitorGameCard
              key={c.id}
              competitor={c}
              parentName={parentName}
              onRemove={handleRemove}
              removePending={removeCompetitor.isPending}
            />
          ))}
        </div>
      )}

      {atCapacity ? (
        <p className="text-xs text-muted-foreground">Maximum reached — remove one to add another.</p>
      ) : (
        // Distinct visual zone (dashed border + tinted background) so this
        // can never be confused with the "Add subreddit" input above.
        <div className="border border-dashed bg-muted/30 p-3 rounded-md">
          <Label htmlFor={`add-competitor-${parentId}`} className="text-xs">
            Add a competitor by Steam AppID
          </Label>
          <div className="flex items-center gap-2 mt-1.5">
            <Input
              id={`add-competitor-${parentId}`}
              placeholder="e.g. 2138710"
              value={appIdInput}
              onChange={e => setAppIdInput(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleAdd()}
              className="max-w-xs bg-background"
              disabled={addCompetitor.isPending}
            />
            <Button type="button" variant="outline" size="sm" onClick={handleAdd} disabled={addCompetitor.isPending}>
              <Plus className="mr-1 h-3.5 w-3.5" />
              {addCompetitor.isPending ? 'Adding…' : 'Add competitor title'}
            </Button>
          </div>
        </div>
      )}
      {addError && <p className="mt-1 text-xs text-destructive">{addError}</p>}
    </div>
  )
}
