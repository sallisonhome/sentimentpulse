import { useEffect, useState } from 'react'
import { useAppContext } from '../../contexts/AppContext'
import { useGames, useLatestGame } from '../../hooks/useGames'
import { useIngestStatus, useTriggerIngest } from '../../hooks/useIngest'
import PeriodFilter from '../shared/PeriodFilter'
import { Button } from '../ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'
import { RefreshCw, MessageSquare } from 'lucide-react'
import { relativeTime } from '../../lib/utils'
import { fetchAllRedditData, uploadToDroplet } from '../../lib/redditFetcher'
import { queryClient } from '../../lib/queryClient'
import ThemeToggle from '../shared/ThemeToggle'

export default function TopBar() {
  const { selectedGameId, setSelectedGameId, period, setPeriod } = useAppContext()
  const { data: games } = useGames()
  const { data: latestGame } = useLatestGame()
  const { data: ingestStatus } = useIngestStatus()
  const triggerIngest = useTriggerIngest()

  const [redditFetching, setRedditFetching] = useState(false)
  const [redditProgress, setRedditProgress] = useState('')

  async function handleFetchReddit() {
    setRedditFetching(true)
    setRedditProgress('Fetching from Reddit...')
    try {
      const { data, totalPosts } = await fetchAllRedditData((p) => {
        setRedditProgress(`${p.current}/${p.total}: ${p.currentGame} (${p.totalPosts} posts)`)
      })
      setRedditProgress(`Uploading ${totalPosts} posts...`)
      const result = await uploadToDroplet(data)
      setRedditProgress(result.message)
      // Refresh all data after a short delay for ingestion to process
      setTimeout(() => {
        queryClient.invalidateQueries({ queryKey: ['dashboard'] })
        queryClient.invalidateQueries({ queryKey: ['posts'] })
        queryClient.invalidateQueries({ queryKey: ['summaries'] })
        queryClient.invalidateQueries({ queryKey: ['topics'] })
        queryClient.invalidateQueries({ queryKey: ['ingest', 'status'] })
        setRedditProgress('')
      }, 5000)
    } catch (err: any) {
      setRedditProgress(`Error: ${err.message}`)
    } finally {
      setRedditFetching(false)
    }
  }

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
        <Button
          size="sm"
          variant="outline"
          disabled={redditFetching || ingestStatus?.is_running}
          onClick={handleFetchReddit}
          data-testid="button-fetch-reddit"
        >
          <MessageSquare className={`mr-2 h-3.5 w-3.5 ${redditFetching ? 'animate-pulse' : ''}`} />
          {redditFetching ? redditProgress || 'Fetching…' : 'Fetch Reddit'}
        </Button>
        <ThemeToggle />
      </div>
    </header>
  )
}
