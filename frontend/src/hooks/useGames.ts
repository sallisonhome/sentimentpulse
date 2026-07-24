import { useQuery, useMutation } from '@tanstack/react-query'
import { api } from '../lib/api'
import { queryClient } from '../lib/queryClient'
import type { Game, GameDetail } from '../types'

/**
 * Fetch only active, non-competitor games (used by the main app dropdown).
 * exclude_competitors=true keeps competitor titles out of the top-level
 * game switcher — they're reached only by clicking their name on the
 * parent's Post Volume by Title chart (see CompetitorTimeseriesChart).
 */
export function useGames() {
  return useQuery<Game[]>({
    queryKey: ['games'],
    queryFn: () => api.get<Game[]>('/games?is_active=true&exclude_competitors=true').then(r => r.data),
  })
}

/** Fetch ALL games regardless of active status (used by Settings page). */
export function useAllGames() {
  return useQuery<Game[]>({
    queryKey: ['games', 'all'],
    queryFn: () => api.get<Game[]>('/games').then(r => r.data),
  })
}

export function useGameDetail(gameId: number | null) {
  return useQuery<GameDetail>({
    queryKey: ['games', gameId],
    queryFn: () => api.get<GameDetail>(`/games/${gameId}`).then(r => r.data),
    enabled: gameId != null,
  })
}

export function useLatestGame() {
  return useQuery<Game>({
    queryKey: ['games', 'latest'],
    queryFn: () => api.get<Game>('/games/latest').then(r => r.data),
  })
}

export function useUpdateGameSettings(gameId: number) {
  return useMutation({
    mutationFn: (data: { subreddits?: string[]; is_active?: boolean; commercial_context?: string }) =>
      api.patch(`/games/${gameId}`, data).then(r => r.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['games'] })
    },
  })
}
