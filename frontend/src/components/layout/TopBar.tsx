import { useEffect } from 'react'
import { useAppContext } from '../../contexts/AppContext'
import { useGames, useLatestGame } from '../../hooks/useGames'
import { useIngestStatus, useTriggerIngest } from '../../hooks/useIngest'
import PeriodFilter from '../shared/PeriodFilter'
import { Button } from '../ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'
import { RefreshCw } from 'lucide-react'
import { relativeTime } from '../../lib/utils'

export default function TopBar() {
  const { selectedGameId, setSelectedGameId, period, setPeriod } = useAppContext()
  const { data: games } = useGames()
  const { data: latestGame } = useLatestGame()
  const { data: ingestStatus } = useIngestStatus()
  const triggerIngest = useTriggerIngest()

  // Auto-select most recent game on first load
  useEffect(() => {
    if (selectedGameId == null && latestGame) {
      setSelectedGameId(latestGame.id)
    }
  }, [latestGame, selectedGameId, setSelectedGameId])

  return (
    <header className="flex h-14 items-center justify-between border-b bg-card px-6">
      <div className="flex items-center gap-3">
        {/* Game selector */}
        <Select
          value={selectedGameId?.toString() ?? ''}
          onValueChange={val => setSelectedGameId(Number(val))}
        >
          <SelectTrigger className="w-52">
            <SelectValue placeholder="Select a game…" />
          </SelectTrigger>
          <SelectContent>
            {games?.map(g => (
              <SelectItem key={g.id} value={g.id.toString()}>
                {g.name}
              </SelectItem>
            ))}
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
      </div>
    </header>
  )
}
