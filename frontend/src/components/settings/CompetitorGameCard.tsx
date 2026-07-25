import { useState } from 'react'
import { Trash2 } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '../ui/card'
import { Button } from '../ui/button'
import { Badge } from '../ui/badge'
import GameSubredditsEditor from './GameSubredditsEditor'
import type { CompetitorGame } from '../../types'

interface CompetitorGameCardProps {
  competitor: CompetitorGame
  parentName: string
  onRemove: (id: number, name: string) => void
  removePending?: boolean
}

/**
 * Full settings card for a single competitor title, nested under its
 * parent's "Competitor Titles" section. Mirrors GameSettingsCard's visual
 * shell (same Card/CardHeader/CardContent, same section-label style) but is
 * scoped entirely to this one competitor's own Game record:
 *
 *  - Its <GameSubredditsEditor> instance is bound to `competitor.id`, so any
 *    subreddit added here is saved via PATCH /api/games/{competitor.id} —
 *    completely isolated from the parent's own subreddits editor, which is a
 *    separate component instance bound to the parent's id.
 *  - There is no is_active toggle (competitors are always active); instead
 *    the header exposes a destructive "Remove competitor" action.
 */
export default function CompetitorGameCard({ competitor, parentName, onRemove, removePending }: CompetitorGameCardProps) {
  const [showContext, setShowContext] = useState(false)
  const hasContext = Boolean((competitor as { commercial_context?: string | null }).commercial_context)

  return (
    <Card className="border-l-2 border-l-muted-foreground/30 shadow-none">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center justify-between text-base">
          <div className="flex items-center gap-2 min-w-0">
            <span className="truncate">{competitor.name}</span>
            <Badge variant="outline" className="text-[10px] font-normal">Competitor</Badge>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="text-destructive hover:text-destructive hover:bg-destructive/10"
            disabled={removePending}
            onClick={() => onRemove(competitor.id, competitor.name)}
            aria-label={`Remove ${competitor.name} as a competitor`}
          >
            <Trash2 className="mr-1 h-3.5 w-3.5" />
            Remove competitor
          </Button>
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          under {parentName} · Steam App ID: {competitor.steam_app_id}
          {competitor.release_date && <> · Released {competitor.release_date}</>}
        </p>
      </CardHeader>

      <CardContent className="space-y-4">
        <GameSubredditsEditor game={competitor} compact />

        {/* Commercial context is optional for competitors — they're benchmarks,
            not our own titles. Only surfaced (collapsed) when one already exists. */}
        {hasContext && (
          <div className="pt-1 border-t">
            <button
              type="button"
              onClick={() => setShowContext(s => !s)}
              className="flex items-center justify-between w-full text-xs font-medium text-muted-foreground uppercase tracking-wide hover:text-foreground transition-colors pt-3"
            >
              <span>Commercial Strategic Context</span>
              <span className="text-[10px] normal-case font-normal">{showContext ? 'hide' : 'view'}</span>
            </button>
            {showContext && (
              <p className="mt-2 text-sm text-muted-foreground whitespace-pre-wrap">
                {(competitor as { commercial_context?: string | null }).commercial_context}
              </p>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
