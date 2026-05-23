import { useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../lib/api'
import type { WindowSummary } from '../types'

interface WindowSummaryRequest {
  days?: number
}

/**
 * On-demand rolling-window summary mutation.
 *
 * Usage:
 *   const { mutate, data, isPending } = useWindowSummary(gameId)
 *   mutate({ days: 1 })   // Past 1 day
 *   mutate({ days: 7 })   // Past 7 days
 *
 * The backend caches results per (game_id, days, ingest_date) so a second
 * call on the same day with the same `days` returns instantly. This is
 * modelled as a mutation (not a query) because the user explicitly triggers
 * generation.
 *
 * Supports any `days` value the backend accepts (currently 1-90 per
 * WindowSummaryRequest schema validator).
 */
export function useWindowSummary(gameId: number | null) {
  const queryClient = useQueryClient()

  return useMutation<WindowSummary, Error, WindowSummaryRequest>({
    mutationFn: ({ days = 7 } = {}) =>
      api
        .post<WindowSummary>(`/games/${gameId}/window-summary`, { days })
        .then(r => r.data),
    onSuccess: (data) => {
      // Cache the result so repeated calls in the same session are free
      queryClient.setQueryData(
        ['window-summary', gameId, data.window_days, data.ingest_date],
        data,
      )
    },
  })
}

// ── Backward-compat alias ────────────────────────────────────────────────────
// Existing imports of useWindow7DaySummary continue to work. New code should
// import useWindowSummary directly.
export { useWindowSummary as useWindow7DaySummary }
