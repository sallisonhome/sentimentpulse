import { ArrowLeft } from 'lucide-react'
import { useAppContext } from '../../contexts/AppContext'
import { useGames } from '../../hooks/useGames'
import { useParentOf } from '../../hooks/useCompetitors'
import { Badge } from '../ui/badge'

/**
 * Persistent per-page header showing the currently-selected game's name.
 * On competitor (child) pages, also shows a "← Back to <parent>"
 * breadcrumb link that returns to the parent's dashboard via state
 * (setSelectedGameId) rather than the browser history stack — the
 * browser back button on a child page was returning to /settings
 * because the chart's legend click navigates via `navigate('/')`, which
 * pushes '/' onto history without carrying the previous game context.
 *
 * Renders NOTHING (returns null) until we have the game data — never
 * flashes a blank header before name resolves.
 */
export default function GameTitleHeader() {
  const { selectedGameId, setSelectedGameId } = useAppContext()
  const { data: games } = useGames()
  const { data: parentOf } = useParentOf(selectedGameId)

  if (!selectedGameId || !games) return null

  const game = games.find(g => g.id === selectedGameId)
  if (!game) return null

  const isChild = parentOf?.parent_id != null

  const handleBackToParent = () => {
    if (parentOf?.parent_id != null) {
      setSelectedGameId(parentOf.parent_id)
    }
  }

  return (
    <div className="mb-1 flex flex-col gap-1">
      {isChild && (
        <button
          onClick={handleBackToParent}
          className="inline-flex w-fit items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeft className="h-3 w-3" />
          Back to {parentOf!.parent_name}
        </button>
      )}
      <div className="flex items-center gap-2">
        <h1 className="text-xl font-semibold tracking-tight text-foreground">
          {game.name}
        </h1>
        {isChild && (
          <Badge variant="outline" className="text-[10px] font-normal uppercase tracking-wide">
            Competitor · under {parentOf!.parent_name}
          </Badge>
        )}
      </div>
    </div>
  )
}
