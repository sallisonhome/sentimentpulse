import { useQuery } from '@tanstack/react-query'
import { api } from '../lib/api'
import type { DashboardData, Period } from '../types'

export function useDashboard(gameId: number | null, period: Period) {
  return useQuery<DashboardData>({
    queryKey: ['dashboard', gameId, period],
    queryFn: () =>
      api.get<DashboardData>(`/games/${gameId}/dashboard`, { params: { period } }).then(r => r.data),
    enabled: gameId != null,
  })
}
