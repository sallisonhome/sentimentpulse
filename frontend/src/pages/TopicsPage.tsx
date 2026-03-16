import { useState } from 'react'
import { useAppContext } from '../contexts/AppContext'
import { useTopics } from '../hooks/useTopics'
import TopicFilters, { type SortKey, type SortDir } from '../components/topics/TopicFilters'
import TopicsTable from '../components/topics/TopicsTable'
import EmptyState from '../components/shared/EmptyState'
import SkeletonCard from '../components/shared/SkeletonCard'
import ErrorBoundary from '../components/shared/ErrorBoundary'
import type { Sentiment } from '../types'

export default function TopicsPage() {
  const { selectedGameId, period } = useAppContext()

  const [sentiment, setSentiment] = useState<Sentiment | 'all'>('all')
  const [sortKey, setSortKey]     = useState<SortKey>('mention_count')
  const [sortDir, setSortDir]     = useState<SortDir>('desc')

  const { data, isLoading, error } = useTopics(selectedGameId, {
    period,
    sentiment: sentiment === 'all' ? undefined : sentiment,
  })

  function handleSortChange(key: SortKey, dir: SortDir) {
    setSortKey(key)
    setSortDir(dir)
  }

  if (!selectedGameId) {
    return <EmptyState title="No game selected" description="Select a game from the top bar." />
  }

  return (
    <ErrorBoundary>
      <div className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-2xl font-bold">Topic Trends</h2>
            {data && (
              <p className="text-sm text-muted-foreground">
                {data.length} topic{data.length !== 1 ? 's' : ''} · {period}
              </p>
            )}
          </div>
          <TopicFilters
            sentiment={sentiment}
            onSentimentChange={v => setSentiment(v)}
            sortKey={sortKey}
            sortDir={sortDir}
            onSortChange={handleSortChange}
          />
        </div>

        {isLoading && <SkeletonCard lines={8} />}
        {error   && <EmptyState title="Failed to load topics" description={error.message} />}
        {!isLoading && !error && data?.length === 0 && (
          <EmptyState
            title="No topics found for this period"
            description="Try a wider time period or run an ingestion."
          />
        )}
        {!isLoading && !error && data && data.length > 0 && (
          <TopicsTable
            topics={data}
            sortKey={sortKey}
            sortDir={sortDir}
            onSortChange={handleSortChange}
          />
        )}
      </div>
    </ErrorBoundary>
  )
}
