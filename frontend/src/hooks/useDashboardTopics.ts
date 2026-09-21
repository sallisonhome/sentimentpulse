// 2026-09-21 (v0031): Top Topics widget data was previously packed into
// the main /dashboard response, but building it drives LLM synthesis calls
// that on cold cache took 60-120+s per period on heavy titles like
// Hellraiser and 504'd the whole dashboard through nginx's 120s proxy
// timeout. Split into its own endpoint and its own React Query hook so
// the fast dashboard payload renders immediately and the Top Topics
// panel shows its own loading state while the LLM works.
//
// Backend: GET /api/games/{id}/dashboard/topics?period=... returns
// TopTopicsSummary directly (same shape as before, just isolated).

import { useQuery } from '@tanstack/react-query'
import { api } from '../lib/api'
import type { Period } from '../types'
import type { TopTopicsSummary } from '../components/dashboard/TopTopicsPanel'

export function useDashboardTopics(gameId: number | null, period: Period) {
  return useQuery<TopTopicsSummary>({
    queryKey: ['dashboard-topics', gameId, period],
    queryFn: () =>
      api
        .get<TopTopicsSummary>(`/games/${gameId}/dashboard/topics`, { params: { period } })
        .then(r => r.data),
    enabled: gameId != null,
    // The LLM work is the whole point of this endpoint being separate;
    // give it a generous stale time so users don't retrigger synthesis
    // on every focus change. 5 minutes matches the ~15-min server-side
    // TTL cache in dashboard_feedback_synthesizer.py.
    staleTime: 5 * 60 * 1000,
  })
}
