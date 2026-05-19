import { useState } from 'react'
import { CalendarDays } from 'lucide-react'
import { useAppContext } from '../contexts/AppContext'
import { useMonthlySummaries } from '../hooks/useMonthlySummaries'
import { useWindow7DaySummary } from '../hooks/useWindow7DaySummary'
import PeriodSelector, { monthKey } from '../components/summary/PeriodSelector'
import BoldIdeasCard from '../components/summary/BoldIdeasCard'
import ExecutiveSummaryCard from '../components/summary/ExecutiveSummaryCard'
import RecommendedActionsCard from '../components/summary/RecommendedActionsCard'
import SummaryTopicsRow from '../components/summary/SummaryTopicsRow'
import EmptyState from '../components/shared/EmptyState'
import SkeletonCard from '../components/shared/SkeletonCard'
import ErrorBoundary from '../components/shared/ErrorBoundary'
import { Button } from '../components/ui/button'
import { Card, CardContent } from '../components/ui/card'
import { cn } from '../lib/utils'
import type { MonthlySummary, WindowSummary } from '../types'

// ── Helpers ────────────────────────────────────────────────────────────────────

function StatChip({ label, value, pct, color }: { label: string; value: number; pct: number; color: string }) {
  return (
    <Card>
      <CardContent className="flex flex-col justify-center p-4">
        <p className="text-xs text-muted-foreground">{label}</p>
        <p className={cn('mt-1 text-xl font-bold', color)}>{value.toLocaleString()}</p>
        <p className="text-xs text-muted-foreground">{(pct * 100).toFixed(1)}% of total</p>
      </CardContent>
    </Card>
  )
}

interface PeriodData {
  positive_count: number
  negative_count: number
  neutral_count: number
  top_positive_topics: string[] | null
  top_negative_topics: string[] | null
  top_neutral_topics: string[] | null
  executive_summary: string | null
  recommended_actions: string | null
  bold_ideas: string[] | null
}

function PeriodStatsRow({ data }: { data: PeriodData }) {
  const total = data.positive_count + data.negative_count + data.neutral_count
  const pos = data.positive_count
  const neg = data.negative_count
  const posNegTotal = pos + neg
  const ratioPct = posNegTotal > 0 ? (pos / posNegTotal) * 100 : null
  const ratioDisplay = ratioPct != null ? `${ratioPct.toFixed(1)}%` : 'N/A'
  const ratioColor = ratioPct != null
    ? ratioPct >= 66 ? 'text-green-600' : ratioPct >= 50 ? 'text-amber-500' : 'text-red-600'
    : 'text-muted-foreground'

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      <Card>
        <CardContent className="flex flex-col justify-center p-4">
          <p className="text-xs text-muted-foreground">Pos/Neg Ratio</p>
          <p className={cn('mt-1 text-xl font-bold', ratioColor)}>{ratioDisplay}</p>
          <p className="text-xs text-muted-foreground">{pos.toLocaleString()} pos / {neg.toLocaleString()} neg</p>
        </CardContent>
      </Card>
      <StatChip label="Positive" value={pos} pct={total > 0 ? pos / total : 0} color="text-green-600" />
      <StatChip label="Negative" value={neg} pct={total > 0 ? neg / total : 0} color="text-red-600" />
      <StatChip label="Neutral" value={data.neutral_count} pct={total > 0 ? data.neutral_count / total : 0} color="text-slate-500" />
    </div>
  )
}

function PeriodBody({ data, isWindow }: { data: PeriodData; isWindow?: boolean }) {
  const boldIdeas = data.bold_ideas ?? []

  return (
    <div className={cn('space-y-4', isWindow && 'rounded-xl border border-dashed border-primary/40 bg-primary/5 p-4')}>
      <PeriodStatsRow data={data} />

      <div
        className={cn(
          'grid gap-4',
          // Two-column grid only when both cards have content. If recommended
          // actions are absent (backend returned null after stripping meta-leak),
          // the executive summary expands to full width.
          data.recommended_actions && data.recommended_actions.trim() ? 'lg:grid-cols-2' : '',
        )}
      >
        <ExecutiveSummaryCard text={data.executive_summary} />
        <RecommendedActionsCard text={data.recommended_actions} />
      </div>

      {boldIdeas.length > 0 && (
        <BoldIdeasCard ideas={boldIdeas} />
      )}

      <SummaryTopicsRow
        positive={data.top_positive_topics}
        negative={data.top_negative_topics}
        neutral={data.top_neutral_topics}
      />
    </div>
  )
}

// ── 7-day panel ────────────────────────────────────────────────────────────────

function Window7DayPanel({ gameId }: { gameId: number }) {
  const { mutate, data, isPending, error } = useWindow7DaySummary(gameId)

  if (!data && !isPending && !error) {
    return (
      <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-primary/40 bg-primary/5 p-8 text-center">
        <CalendarDays className="h-8 w-8 text-primary/60" />
        <p className="text-sm text-muted-foreground">Click to generate a real-time summary of the past 7 days.</p>
        <Button onClick={() => mutate({ days: 7 })} variant="outline">
          Generate Past 7 Days
        </Button>
      </div>
    )
  }

  if (isPending) {
    return (
      <div className="space-y-4 rounded-xl border border-dashed border-primary/40 bg-primary/5 p-4">
        <p className="text-sm text-muted-foreground animate-pulse">Analyzing the past 7 days…</p>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => <SkeletonCard key={i} lines={2} />)}
        </div>
        <SkeletonCard lines={6} />
        <SkeletonCard lines={5} />
      </div>
    )
  }

  if (error) {
    return (
      <div className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800 dark:border-red-800 dark:bg-red-950 dark:text-red-200">
        Failed to generate 7-day summary: {error.message}
        <Button size="sm" variant="outline" className="ml-3" onClick={() => mutate({ days: 7 })}>
          Retry
        </Button>
      </div>
    )
  }

  const ws = data as WindowSummary
  const startDate = new Date(ws.ingest_date)
  startDate.setDate(startDate.getDate() - ws.window_days + 1)
  const fmt = (d: Date) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  const endDate = new Date(ws.ingest_date)
  const rangeLabel = `${fmt(startDate)} – ${fmt(endDate)}, ${endDate.getFullYear()}`

  return (
    <div>
      <p className="mb-3 text-sm text-muted-foreground">
        Past 7 days · {rangeLabel}
      </p>
      <PeriodBody data={ws} isWindow />
    </div>
  )
}

// ── Empty state for current open month ────────────────────────────────────────

function CurrentMonthEmptyState({ gameId }: { gameId: number }) {
  const { mutate, isPending } = useWindow7DaySummary(gameId)
  const now = new Date()
  const monthName = now.toLocaleDateString('en-US', { month: 'long' })

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-muted bg-muted/30 px-5 py-6 text-center">
        <p className="text-sm text-muted-foreground">
          The <strong>{monthName}</strong> summary will be released on the 1st of next month.
          Want a preview?
        </p>
        <Button
          className="mt-3"
          variant="outline"
          disabled={isPending}
          onClick={() => mutate({ days: 7 })}
        >
          <CalendarDays className="mr-2 h-4 w-4" />
          {isPending ? 'Generating…' : 'Generate Past 7 Days'}
        </Button>
      </div>
    </div>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function SummaryPage() {
  const { selectedGameId } = useAppContext()
  const { data: months, isLoading, error } = useMonthlySummaries(selectedGameId)

  // Track selected period key ("2024-4") or "7day" for the on-demand view
  const [selectedKey, setSelectedKey] = useState<string | null>(null)

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

  const monthList: MonthlySummary[] = months ?? []

  // Determine active key: default to most recent month, or "7day"
  const defaultKey = monthList.length > 0 ? monthKey(monthList[0].period_year, monthList[0].period_month) : null
  const activeKey = selectedKey ?? defaultKey

  // Is the user in 7-day mode?
  const is7Day = activeKey === '7day'

  // Find currently selected monthly summary
  const activeSummary: MonthlySummary | undefined = is7Day
    ? undefined
    : monthList.find(m => monthKey(m.period_year, m.period_month) === activeKey)

  // Period label for the heading
  const periodLabel = is7Day
    ? 'Past 7 days'
    : activeSummary?.month_label ?? 'No summaries yet'

  return (
    <ErrorBoundary>
      <div className="space-y-5">
        {/* Page header */}
        <div>
          <h2 className="text-2xl font-bold">Executive Summary</h2>
          <p className="text-sm text-muted-foreground mt-0.5">{periodLabel}</p>
        </div>

        {/* Period controls: month/year selector + 7-day button */}
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            {monthList.length > 0 && (
              <PeriodSelector
                months={monthList}
                selectedKey={activeKey ?? ''}
                onChange={key => setSelectedKey(key)}
              />
            )}
          </div>
          <Button
            variant={is7Day ? 'default' : 'outline'}
            size="sm"
            onClick={() => setSelectedKey(is7Day ? defaultKey : '7day')}
            className={cn(
              'gap-1.5 shrink-0',
              is7Day && 'ring-2 ring-primary ring-offset-2',
            )}
          >
            <CalendarDays className="h-4 w-4" />
            {is7Day ? 'Back to Monthly' : '+ Past 7 days'}
          </Button>
        </div>

        {/* Main content */}
        {is7Day ? (
          <Window7DayPanel gameId={selectedGameId} />
        ) : activeSummary ? (
          <PeriodBody data={activeSummary} />
        ) : monthList.length === 0 ? (
          <CurrentMonthEmptyState gameId={selectedGameId} />
        ) : null}
      </div>
    </ErrorBoundary>
  )
}
