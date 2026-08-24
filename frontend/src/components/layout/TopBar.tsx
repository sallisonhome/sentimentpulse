import { useEffect } from 'react'
import { useAppContext } from '../../contexts/AppContext'
import { useGames, useParentGames, useLatestGame, useGameDetail } from '../../hooks/useGames'
import { useIngestStatus, useTriggerIngest } from '../../hooks/useIngest'
import PeriodFilter from '../shared/PeriodFilter'
import { Button } from '../ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'
import { RefreshCw } from 'lucide-react'
import { relativeTime } from '../../lib/utils'
import ThemeToggle from '../shared/ThemeToggle'

export default function TopBar() {
  const { selectedGameId, setSelectedGameId, period, setPeriod } = useAppContext()
  const { data: games } = useGames()
  // Parents-only list — diffed against `games` below to identify which
  // dropdown items are competitors so we can render a "Competitor" badge
  // next to their names. Cheap: same table, same query, no join.
  const { data: parentGames } = useParentGames()
  const parentIds = new Set(parentGames?.map(g => g.id) ?? [])
  const { data: latestGame } = useLatestGame()
  // Separate fetch for the currently-selected game so the picker can
  // display competitor names (competitors are excluded from useGames() but
  // still need to render as the picker's current value when the user
  // navigates to a child dashboard via the Post Volume by Title chart).
  const { data: currentGame } = useGameDetail(selectedGameId)
  const { data: ingestStatus } = useIngestStatus()
  const triggerIngest = useTriggerIngest()

  // v0022 (2026-08-19): Auto-select the most recent game ONLY on true
  // first-ever load — when there is no persisted selection in
  // localStorage AND no ?game=<id> in the URL.  AppContext's useState
  // initializer reads localStorage first, so selectedGameId is only
  // null in that scenario.  Once this effect writes the initial id it
  // is persisted to localStorage by setSelectedGameId, so the fallback
  // won't re-fire on later navigations.
  //
  // BEFORE v0022 this same code was the actual cause of the "every
  // side-nav click resets to HOT WHEELS" bug: any navigation that
  // dropped ?game=<id> cleared state to null, this effect fired, and
  // silently switched the picker to the newest game.  Now that state
  // is localStorage-backed, that state-clearing pathway is gone, and
  // this fallback stays a first-load-only affordance.
  useEffect(() => {
    if (selectedGameId == null && latestGame) {
      setSelectedGameId(latestGame.id)
    }
  }, [latestGame, selectedGameId, setSelectedGameId])

  // v0026 (2026-08-24): if the currently-selected game gets Hidden in
  // Settings (is_active flipped to false), it drops out of useGames()
  // but the persisted selectedGameId in localStorage still points at
  // it -- so the trigger keeps rendering the hidden game's name via
  // useGameDetail (which fetches by id, ignoring is_active). Detect
  // that mismatch and drop the selection back to null so the
  // latestGame fallback above re-picks a visible title. Steve, 2026-
  // 08-24: hidden Docked DLC was still showing as the picker's
  // current value even though it was correctly missing from the
  // dropdown items themselves.
  //
  // Guards:
  //   - Wait for games to actually load (games !== undefined).
  //   - Only act when selectedGameId is set AND not present in the
  //     active list. Competitors ARE in useGames() output, so this
  //     doesn't accidentally punt off a valid competitor selection.
  useEffect(() => {
    if (selectedGameId == null || games == null) return
    const isVisible = games.some(g => g.id === selectedGameId)
    if (!isVisible) {
      setSelectedGameId(null)
    }
  }, [games, selectedGameId, setSelectedGameId])

  return (
    <header className="flex h-14 items-center justify-between border-b bg-card px-6">
      <div className="flex items-center gap-3">
        {/* Game selector */}
        <Select
          value={selectedGameId?.toString() ?? ''}
          onValueChange={val => setSelectedGameId(Number(val))}
        >
          <SelectTrigger className="w-52">
            {/*
              Radix's <SelectValue> reads the current value's corresponding
              <SelectItem> text. For competitors (not in `games`), that
              lookup fails and the trigger renders blank. Falling back to
              the fetched game's name here keeps the trigger informative on
              child dashboards.
            */}
            {/* Guard against the tiny window before useGames() resolves —
                still show the fetched game's name from useGameDetail so the
                trigger is never blank when a game is selected. */}
            {currentGame
              ? (
                <span className="flex items-center gap-2">
                  <span className="truncate">{currentGame.name}</span>
                  {parentGames != null && !parentIds.has(currentGame.id) && (
                    <span className="rounded-sm border border-border bg-muted px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide text-muted-foreground">
                      Competitor
                    </span>
                  )}
                </span>
              )
              : <SelectValue placeholder="Select a game…" />}
          </SelectTrigger>
          <SelectContent>
            {games?.map(g => {
              const isCompetitor = parentGames != null && !parentIds.has(g.id)
              return (
                <SelectItem key={g.id} value={g.id.toString()}>
                  <span className="flex items-center gap-2">
                    <span className="truncate">{g.name}</span>
                    {isCompetitor && (
                      <span className="rounded-sm border border-border bg-muted px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide text-muted-foreground">
                        Competitor
                      </span>
                    )}
                  </span>
                </SelectItem>
              )
            })}
          </SelectContent>
        </Select>

        <PeriodFilter value={period} onChange={setPeriod} />
      </div>

      <div className="flex items-center gap-3 text-sm text-muted-foreground">
        {ingestStatus && (
          <span>
            Last run: {relativeTime(ingestStatus.last_run_at)}
          </span>
        )}
        <Button
          size="sm"
          variant="outline"
          disabled={ingestStatus?.is_running || triggerIngest.isPending}
          onClick={() => triggerIngest.mutate()}
        >
          <RefreshCw className={`mr-2 h-3.5 w-3.5 ${ingestStatus?.is_running ? 'animate-spin' : ''}`} />
          {ingestStatus?.is_running ? 'Running…' : 'Run Ingest'}
        </Button>
        <ThemeToggle />
      </div>
    </header>
  )
}
