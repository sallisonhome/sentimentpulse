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

  if (!data || data.sentiment_today.total === 0) {
    return (
      <EmptyState
        title="No data for this period"
        description="Run an ingestion or select a different time period."
      />
    )
  }

  return (
    <ErrorBoundary>
      <div className="space-y-4">
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
