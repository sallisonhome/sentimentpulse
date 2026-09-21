// 2026-08-05 rewrite:
// The dashboard's Top Topics widget was previously a rank-with-badges list
// (topic label + mention_count badge + trend arrow + mini bar chart) that
// duplicated the Summary page's topic-metadata surface. Per spec, this
// widget now shows a concise text summary — top 1 topic per sentiment,
// with a runner-up when its volume is close to the leader. Ranking is by
// raw post-volume for the selected period (the endpoint honors the
// dashboard's `period` filter chip). Detail line describes the topic
// itself, not the period.
//
// 2026-09-21 (v0031):
// The topic-summary data now comes from its own endpoint
// (GET /dashboard/topics) via useDashboardTopics(), rather than being
// packed into the main dashboard payload. The main dashboard returns
// in <2s cold now, and this panel shows its own "Analyzing…" loading
// state while the backend runs the LLM synthesis (which can take
// 30-60s on heavy titles for wide periods). See dashboard router
// v0031 comment and lessons.md 2026-09-21.

import { Card, CardContent, CardHeader, CardTitle } from '../ui/card'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../ui/tabs'
import type { Period } from '../../types'
import { useDashboardTopics } from '../../hooks/useDashboardTopics'

// Local alias so the rest of the file reads naturally. `Period` is the
// canonical name in types/index.ts.
type PeriodValue = Period

// Backend response shape (matches backend/schemas.py TopicSummary).
export interface TopicSummary {
  label:   string
  detail:  string
  volume:  number
}

export interface TopTopicsSummary {
  positive: TopicSummary[]
  negative: TopicSummary[]
  neutral:  TopicSummary[]
  // v0031b (2026-09-21): 'pending' means the server kicked off
  // background LLM synthesis and returned immediately — the hook
  // will keep polling until this flips to 'ready'.
  status?:  'ready' | 'pending'
}

interface TopTopicsPanelProps {
  gameId: number | null
  period:  PeriodValue
}

// Empty-state copy per 2026-08-05 spec: when there aren't enough posts
// carrying definitive opinion + specificity signal to synthesize a
// sentence, tell the user that directly. The widget honors the
// selected filter strictly and does NOT relax the bar to fill space.
const EMPTY_STATE_COPY = "Not enough posts with definitive signal to surface topics here."

// Header anchor label — short tag that snaps to whichever period chip is
// selected. Deliberately minimal so it reads as a lightweight subtitle
// under the card title, not descriptive prose.
function periodAnchor(period: PeriodValue): string {
  switch (period) {
    case 'today':     return 'Today'
    case 'weekly':    return 'Past 7 days'
    case 'monthly':   return 'Past 30 days'
    case 'quarterly': return 'Past 90 days'
    case 'lifetime':  return 'All time'
    default:          return 'Selected period'
  }
}

export default function TopTopicsPanel({ gameId, period }: TopTopicsPanelProps) {
  const { data, isLoading, error } = useDashboardTopics(gameId, period)

  // Show the loading state both when the request is still in-flight AND
  // when the endpoint has already returned but the server-side LLM
  // synthesis is still running (status='pending'). The hook polls every
  // 4s and will flip status to 'ready' when the data lands.
  const showLoading = isLoading || (data?.status === 'pending')

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="text-base">Top Topics</CardTitle>
          {/* Small anchor label — dynamically reflects the selected filter. */}
          <span className="text-xs text-muted-foreground whitespace-nowrap">
            {periodAnchor(period)}
          </span>
        </div>
      </CardHeader>
      <CardContent>
        <Tabs defaultValue="negative">
          <TabsList className="mb-3">
            <TabsTrigger value="positive">Positive</TabsTrigger>
            <TabsTrigger value="negative">Negative</TabsTrigger>
            <TabsTrigger value="neutral">Neutral</TabsTrigger>
          </TabsList>
          <TabsContent value="positive">
            <TopicSummaryList
              items={data?.positive ?? []}
              isLoading={showLoading}
              hasError={!!error}
              period={period}
            />
          </TabsContent>
          <TabsContent value="negative">
            <TopicSummaryList
              items={data?.negative ?? []}
              isLoading={showLoading}
              hasError={!!error}
              period={period}
            />
          </TabsContent>
          <TabsContent value="neutral">
            <TopicSummaryList
              items={data?.neutral ?? []}
              isLoading={showLoading}
              hasError={!!error}
              period={period}
            />
          </TabsContent>
        </Tabs>
      </CardContent>
    </Card>
  )
}

function TopicSummaryList({
  items,
  isLoading,
  hasError,
  period: _period,
}: {
  items:     TopicSummary[]
  isLoading: boolean
  hasError:  boolean
  period:    PeriodValue
}) {
  // Loading state — LLM synthesis is running server-side. On cold cache
  // for a heavy title this can take 30-60s; the fast dashboard has
  // already rendered by this point so the user sees a normal page with
  // just this widget waiting on data.
  if (isLoading) {
    return (
      <p className="py-4 text-sm text-muted-foreground">
        Analyzing top topics…
      </p>
    )
  }

  if (hasError) {
    return (
      <p className="py-4 text-sm text-muted-foreground">
        Couldn’t load top topics. Try switching periods or refreshing.
      </p>
    )
  }

  if (!items.length) {
    return (
      <p className="py-4 text-sm text-muted-foreground">
        {EMPTY_STATE_COPY}
      </p>
    )
  }

  return (
    <ul className="space-y-3">
      {items.map((item) => (
        <li key={item.label} className="text-sm">
          <div className="font-medium">{item.label}</div>
          <div className="mt-0.5 text-muted-foreground">{item.detail}</div>
        </li>
      ))}
    </ul>
  )
}
