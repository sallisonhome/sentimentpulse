import { useQuery } from '@tanstack/react-query'
import { api } from '../lib/api'
import type { MonthlySummary } from '../types'

/**
 * Fetch all monthly summaries for a game, newest first.
 * Returns a list of MonthlySummary objects each with a `month_label` field.
 */
export function useMonthlySummaries(gameId: number | null) {
  return useQuery<MonthlySummary[]>({
    queryKey: ['monthly-summaries', gameId],
    queryFn: () =>
      api.get<MonthlySummary[]>(`/games/${gameId}/monthly-summaries`).then(r => r.data),
    enabled: gameId != null,
    staleTime: 5 * 60 * 1000, // 5 minutes — monthly summaries rarely change
  })
}

/**
 * Fetch a single monthly summary for the given game/year/month.
 */
export function useMonthlyeSummary(gameId: number | null, year: number, month: number) {
  return useQuery<MonthlySummary>({
    queryKey: ['monthly-summaries', gameId, year, month],
    queryFn: () =>
      api
        .get<MonthlySummary>(`/games/${gameId}/monthly-summaries/${year}/${month}`)
        .then(r => r.data),
    enabled: gameId != null,
  })
}
