import { useQuery, useMutation } from '@tanstack/react-query'
import { api } from '../lib/api'
import { queryClient } from '../lib/queryClient'
import type { Game, GameDetail } from '../types'

/**
 * Fetch all active games INCLUDING competitor titles — used by the main
 * app dropdown. Competitors render with a "Competitor" badge in the
 * picker so users can pick them directly instead of hunting the parent's
 * Post Volume by Title chart.
 */
export function useGames() {
  return useQuery<Game[]>({
    queryKey: ['games'],
    queryFn: () => api.get<Game[]>('/games?is_active=true').then(r => r.data),
  })
}

/**
 * Same as useGames() but excludes competitors — used only where a truly
 * parents-only view matters (e.g. Settings page's parent-card list, or
 * the competitor-timeseries chart's group‑set).
 */
export function useParentGames() {
  return useQuery<Game[]>({
    queryKey: ['games', 'parents-only'],
    queryFn: () => api.get<Game[]>('/games?is_active=true&exclude_competitors=true').then(r => r.data),
  })
}

/** Fetch ALL games regardless of active status (used by Settings page). */
export function useAllGames() {
  return useQuery<Game[]>({
    queryKey: ['games', 'all'],
    // exclude_competitors=true — competitors get their own dedicated
    // sub-cards nested inside each parent's GameSettingsCard; they must
    // not render as top-level parent cards in the Settings list (see the
    // 2026-07-24 UX rule from the user: "ILL is not a Saber game it is a
    // competitor to sit under Hellraiser as a child game").
    queryFn: () => api.get<Game[]>('/games?exclude_competitors=true').then(r => r.data),
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
