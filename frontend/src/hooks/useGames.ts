import { useQuery, useMutation } from '@tanstack/react-query'
import { api } from '../lib/api'
import { queryClient } from '../lib/queryClient'
import type { Game, GameDetail } from '../types'

export function useGames() {
  return useQuery<Game[]>({
    queryKey: ['games'],
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
    mutationFn: (data: { subreddits?: string[]; is_active?: boolean }) =>
      api.patch(`/games/${gameId}`, data).then(r => r.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['games'] })
    },
  })
}
