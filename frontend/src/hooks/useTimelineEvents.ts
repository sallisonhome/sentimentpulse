import { useMutation, useQuery } from '@tanstack/react-query'
import { api } from '../lib/api'
import { queryClient } from '../lib/queryClient'

/**
 * Timeline events: user-authored calendar events overlaid on the
 * Post Volume by Title chart. Events are scoped per-game, but the
 * feature is only surfaced when the game is part of a parent/competitor
 * group — enforced both client-side (widget is hidden when the parent
 * has zero competitors) and server-side (POST returns 409 for
 * standalone games).
 */
export interface TimelineEvent {
  id: number
  game_id: number
  event_date: string       // YYYY-MM-DD
  name: string
  created_at: string
}

export interface TimelineEventCreate {
  event_date: string       // YYYY-MM-DD
  name: string
}

export function useTimelineEvents(gameId: number | null) {
  return useQuery<TimelineEvent[]>({
    queryKey: ['timeline-events', gameId],
    queryFn: () => api.get<TimelineEvent[]>(`/games/${gameId}/timeline-events`).then(r => r.data),
    enabled: gameId != null,
  })
}

export function useAddTimelineEvent(gameId: number) {
  return useMutation({
    mutationFn: (payload: TimelineEventCreate) =>
      api.post<TimelineEvent>(`/games/${gameId}/timeline-events`, payload).then(r => r.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['timeline-events', gameId] })
      // The Post Volume by Title chart reads from competitor-timeseries,
      // which now includes the events payload — invalidate it so the
      // marker appears immediately after add without a page reload.
      queryClient.invalidateQueries({ queryKey: ['competitor-timeseries'] })
    },
  })
}

export function useDeleteTimelineEvent(gameId: number) {
  return useMutation({
    mutationFn: (eventId: number) =>
      api.delete(`/games/${gameId}/timeline-events/${eventId}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['timeline-events', gameId] })
      queryClient.invalidateQueries({ queryKey: ['competitor-timeseries'] })
    },
  })
}
