import { useMutation, useQuery } from '@tanstack/react-query'
import { api } from '../lib/api'
import { queryClient } from '../lib/queryClient'
import type { CompetitorGame, CompetitorTimeseriesResponse, Period } from '../types'

/** List the competitor titles tracked under a parent Saber game. */
export function useCompetitors(parentId: number | null) {
  return useQuery<CompetitorGame[]>({
    queryKey: ['competitors', parentId],
    queryFn: () => api.get<CompetitorGame[]>(`/games/${parentId}/competitors`).then(r => r.data),
    enabled: parentId != null,
  })
}

/** Add a competitor by Steam AppID under a parent Saber title. */
export function useAddCompetitor(parentId: number) {
  return useMutation({
    mutationFn: (steam_app_id: number) =>
      api.post<CompetitorGame>(`/games/${parentId}/competitors`, { steam_app_id }).then(r => r.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['competitors', parentId] })
      queryClient.invalidateQueries({ queryKey: ['games'] })
    },
  })
}

/** Remove a competitor from a parent's tracking list (destructive). */
export function useRemoveCompetitor(parentId: number) {
  return useMutation({
    mutationFn: (competitorId: number) =>
      api.delete(`/games/${parentId}/competitors/${competitorId}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['competitors', parentId] })
      queryClient.invalidateQueries({ queryKey: ['games'] })
    },
  })
}

/**
 * Daily post-volume comparison across a parent Saber title and its
 * tracked competitors — feeds CompetitorTimeseriesChart. Always resolves
 * (200) even with zero competitors; caller uses `games.length > 1` as the
 * "show this chart" signal.
 */
export function useCompetitorTimeseries(parentId: number | null, period: Period) {
  return useQuery<CompetitorTimeseriesResponse>({
    queryKey: ['competitor-timeseries', parentId, period],
    queryFn: () =>
      api
        .get<CompetitorTimeseriesResponse>(`/games/${parentId}/competitor-timeseries`, { params: { period } })
        .then(r => r.data),
    enabled: parentId != null,
  })
}
