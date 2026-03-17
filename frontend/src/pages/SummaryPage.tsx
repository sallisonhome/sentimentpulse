import { useState, useEffect } from 'react'
import { format, parseISO } from 'date-fns'
import { useAppContext } from '../contexts/AppContext'
import { useSummaryHistory } from '../hooks/useSummaries'
import SummaryDateSelector from '../components/summary/SummaryDateSelector'
import SummaryStatsRow from '../components/summary/SummaryStatsRow'
import ExecutiveSummaryCard from '../components/summary/ExecutiveSummaryCard'
import RecommendedActionsCard from '../components/summary/RecommendedActionsCard'
import SummaryTopicsRow from '../components/summary/SummaryTopicsRow'
import EmptyState from '../components/shared/EmptyState'
import SkeletonCard from '../components/shared/SkeletonCard'
import ErrorBoundary from '../components/shared/ErrorBoundary'

export default function SummaryPage() {
  const { selectedGameId, period } = useAppContext()
  const { data: history, isLoading, error } = useSummaryHistory(selectedGameId, period)
  const [selectedId, setSelectedId] = useState<number | null>(null)

  // Default to the most recent summary whenever history loads / game or period changes
  useEffect(() => {
    if (history?.length) {
      setSelectedId(history[0].id)
    } else {
      setSelectedId(null)
    }
  }, [history])

  if (!selectedGameId) {
    return <EmptyState title="No game selected" description="Select a game from the top bar." />
  }

  if (isLoading) {
    return (
      <div className="space-y-4">
        <SkeletonCard lines={2} className="max-w-xs" />
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => <SkeletonCard key={i} lines={2} />)}
        </div>
        <SkeletonCard lines={8} />
        <SkeletonCard lines={6} />
      </div>
    )
  }

  if (error) {
    return <EmptyState title="Failed to load summaries" description={error.message} />
  }

  if (!history?.length) {
    return (
      <EmptyState
        title="No summaries for this period"
        description="Try a wider time period or run an ingestion to generate today's summary."
      />
    )
  }

  const summary = history.find(s => s.id === selectedId) ?? history[0]
  const dateLabel = format(parseISO(summary.summary_date), 'EEEE, MMMM d yyyy')
  const noNewRecords = summary.executive_summary?.startsWith('[No new posts collected]')
  const total = summary.positive_count + summary.negative_count + summary.neutral_count

  return (
    <ErrorBoundary>
      <div className="space-y-5">
        {/* No-new-records callout */}
        {noNewRecords && (
          <div className="rounded-md border border-yellow-200 bg-yellow-50 px-4 py-2 text-sm text-yellow-800 dark:border-yellow-800 dark:bg-yellow-950 dark:text-yellow-200">
            <strong>No new posts collected on this date.</strong> No community posts were ingested during the {dateLabel} run.
            Topics and recommended actions are carried forward from the previous active collection.
          </div>
        )}
        {/* Page header */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-2xl font-bold">Executive Summary</h2>
            <p className="text-sm text-muted-foreground">{dateLabel}{total === 0 && !noNewRecords ? ' — no posts collected' : ''}</p>
          </div>
          {history.length > 1 && (
            <SummaryDateSelector
              summaries={history}
              selectedId={summary.id}
              onChange={setSelectedId}
            />
          )}
        </div>

        {/* Stat chips row */}
        <SummaryStatsRow summary={summary} />

        {/* AI narrative + actions */}
        <div className="grid gap-4 lg:grid-cols-2">
          <ExecutiveSummaryCard text={summary.executive_summary} />
          <RecommendedActionsCard text={summary.recommended_actions} />
        </div>

        {/* Topic badges */}
        <SummaryTopicsRow
          positive={summary.top_positive_topics}
          negative={summary.top_negative_topics}
          neutral={summary.top_neutral_topics}
        />
      </div>
    </ErrorBoundary>
  )
}
