import { useAppContext } from '../contexts/AppContext'
import { useDashboard } from '../hooks/useDashboard'
import KpiCards from '../components/dashboard/KpiCards'
import NetSentimentChart from '../components/dashboard/NetSentimentChart'
import SentimentDonut from '../components/dashboard/SentimentDonut'
import VolumeBySourceChart from '../components/dashboard/VolumeBySourceChart'
import TopTopicsPanel from '../components/dashboard/TopTopicsPanel'
import EmptyState from '../components/shared/EmptyState'
import SkeletonCard from '../components/shared/SkeletonCard'
import ErrorBoundary from '../components/shared/ErrorBoundary'

export default function DashboardPage() {
  const { selectedGameId, period } = useAppContext()
  const { data, isLoading, error } = useDashboard(selectedGameId, period)

  if (!selectedGameId) {
    return <EmptyState title="No game selected" description="Select a game from the top bar." />
  }

  if (isLoading) {
    return (
      <div className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
          {Array.from({ length: 5 }).map((_, i) => <SkeletonCard key={i} lines={2} />)}
        </div>
        <div className="grid gap-4 lg:grid-cols-3">
          <SkeletonCard lines={6} className="lg:col-span-2" />
          <SkeletonCard lines={6} />
        </div>
        <div className="grid gap-4 lg:grid-cols-2">
          <SkeletonCard lines={6} />
          <SkeletonCard lines={8} />
        </div>
      </div>
    )
  }

  if (error) {
    return <EmptyState title="Failed to load dashboard" description={error.message} />
  }

  // Only show empty state when there is truly no data at all — no trend history
  // and no posts collected today. A game with yesterday's data but no today's
  // data should still show the dashboard, not a blank page.
  if (!data || (data.sentiment_today.total === 0 && data.net_sentiment_trend.length === 0)) {
    return (
      <EmptyState
        title="No data for this period"
        description="Run an ingestion or select a different time period."
      />
    )
  }

  // Determine what state today's data is in:
  // - noNewRecords: ingestion ran today but found no new posts (zero-count summary exists)
  // - notCollectedYet: ingestion hasn't run today yet (no summary for today at all)
  const todayStr = new Date().toISOString().split('T')[0]
  const todayTrendEntry = data.net_sentiment_trend.find(p => p.summary_date === todayStr)
  const noNewRecords = data.sentiment_today.total === 0 && todayTrendEntry !== undefined
  const notCollectedYet = data.sentiment_today.total === 0 && todayTrendEntry === undefined && data.net_sentiment_trend.length > 0
  const lastDate = (noNewRecords || notCollectedYet)
    ? data.net_sentiment_trend.filter(p => p.total > 0).slice(-1)[0]?.summary_date
    : null

  return (
    <ErrorBoundary>
      <div className="space-y-4">
        {noNewRecords && (
          <div className="rounded-md border border-yellow-200 bg-yellow-50 px-4 py-2 text-sm text-yellow-800 dark:border-yellow-800 dark:bg-yellow-950 dark:text-yellow-200">
            <strong>No new posts collected on last ingestion.</strong> Sentiment counts show zero for today. Topics and trend charts reflect historical data.
            {lastDate && <> Last active collection: <strong>{lastDate}</strong>.</>}
          </div>
        )}
        {notCollectedYet && (
          <div className="rounded-md border border-yellow-200 bg-yellow-50 px-4 py-2 text-sm text-yellow-800 dark:border-yellow-800 dark:bg-yellow-950 dark:text-yellow-200">
            Today's ingestion has not run yet. Showing most recent available data.
            {lastDate && <> Last active collection: <strong>{lastDate}</strong>.</>}
          </div>
        )}
        {/* Row 1 — KPI stat cards */}
        <KpiCards sentiment={data.sentiment_today} velocity={data.sentiment_velocity} />

        {/* Row 2 — Net sentiment trend (wide) + donut (narrow) */}
        <div className="grid gap-4 lg:grid-cols-3">
          <div className="lg:col-span-2">
            {data.net_sentiment_trend.length > 0
              ? <NetSentimentChart data={data.net_sentiment_trend} />
              : <EmptyState title="No trend data" description="Data will appear after the first ingestion." />
            }
          </div>
          <SentimentDonut sentiment={data.sentiment_today} />
        </div>

        {/* Row 3 — Volume by source (wide) + top topics (narrow) */}
        <div className="grid gap-4 lg:grid-cols-3">
          <div className="lg:col-span-2">
            {data.volume_by_source.length > 0
              ? <VolumeBySourceChart data={data.volume_by_source} />
              : <EmptyState title="No volume data" />
            }
          </div>
          <TopTopicsPanel
            positive={data.top_positive_topics}
            negative={data.top_negative_topics}
            neutral={data.top_neutral_topics}
          />
        </div>
      </div>
    </ErrorBoundary>
  )
}
