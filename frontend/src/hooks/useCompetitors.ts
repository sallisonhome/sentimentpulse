import { useMutation, useQuery } from '@tanstack/react-query'
import { api } from '../lib/api'
import { queryClient } from '../lib/queryClient'
import type { CompetitorGame, CompetitorTimeseriesResponse, Period } from '../types'

/**
 * Return the parent title of a competitor game, if any. Used by the
 * dashboard to render "← Back to <parent>" breadcrumbs on child pages.
 * Backend always returns HTTP 200 with `{parent_id: null, parent_name: null}`
 * for non-competitor games, so this hook is safe to call unconditionally
 * for any selected game.
 */
export interface ParentOfResponse {
  parent_id: number | null
  parent_name: string | null
}
export function useParentOf(gameId: number | null) {
  return useQuery<ParentOfResponse>({
    queryKey: ['parent-of', gameId],
    queryFn: () => api.get<ParentOfResponse>(`/games/${gameId}/parent`).then(r => r.data),
    enabled: gameId != null,
    // Parenthood almost never changes; cache aggressively so switching
    // between games doesn't spam the backend.
    staleTime: 5 * 60 * 1000,
  })
}

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
