import { useQuery } from '@tanstack/react-query'
import { api } from '../lib/api'
import type { DailySummary, Period } from '../types'

export function useLatestSummary(gameId: number | null) {
  return useQuery<DailySummary>({
    queryKey: ['summaries', gameId, 'latest'],
    queryFn: () =>
      api.get<DailySummary>(`/games/${gameId}/summaries/latest`).then(r => r.data),
    enabled: gameId != null,
  })
}

export function useSummaryHistory(gameId: number | null, period: Period = 'lifetime') {
  return useQuery<DailySummary[]>({
    queryKey: ['summaries', gameId, 'history', period],
    queryFn: () =>
      api.get<DailySummary[]>(`/games/${gameId}/summaries`, { params: { period } }).then(r => r.data),
    enabled: gameId != null,
  })
}
