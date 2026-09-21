// 2026-09-21 (v0031): Top Topics widget data was previously packed into
// the main /dashboard response, but building it drives LLM synthesis calls
// that on cold cache took 60-120+s per period on heavy titles like
// Hellraiser and 504'd the whole dashboard through nginx's 120s proxy
// timeout. Split into its own endpoint and its own React Query hook so
// the fast dashboard payload renders immediately and the Top Topics
// panel shows its own loading state while the LLM works.
//
// 2026-09-21 (v0031b): the endpoint is now NON-BLOCKING. It returns 200
// immediately with `status: 'pending'` and empty arrays if the underlying
// synthesizer cache is cold, and kicks off background synthesis on the
// server. This hook polls at 4s intervals while status is 'pending' so
// the widget picks up the real data as soon as it's ready.
//
// Backend: GET /api/games/{id}/dashboard/topics?period=... returns
// TopTopicsSummary with a `status` field ('ready' | 'pending').

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
    // While synthesis is running on the server, poll every 4s until the
    // endpoint reports status='ready'. Once ready, stop polling and let
    // the 5-minute staleTime keep the answer around across focus changes.
    refetchInterval: (query) => {
      const data = query.state.data
      if (data && data.status === 'pending') return 4000
      return false
    },
    // The LLM work is the whole point of this endpoint being separate;
    // give it a generous stale time so users don't retrigger synthesis
    // on every focus change. 5 minutes matches the ~15-min server-side
    // TTL cache in dashboard_feedback_synthesizer.py.
    staleTime: 5 * 60 * 1000,
  })
}
