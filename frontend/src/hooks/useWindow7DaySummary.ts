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
 *   const { mutate, data, isPending } = useWindow7DaySummary(gameId)
 *   mutate({ days: 7 })
 *
 * The backend caches results per (game_id, days, ingest_date) so a second
 * call on the same day returns instantly. This is modelled as a mutation
 * (not a query) because the user explicitly triggers generation.
 */
export function useWindow7DaySummary(gameId: number | null) {
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
