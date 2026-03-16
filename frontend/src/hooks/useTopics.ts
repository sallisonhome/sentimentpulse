import { useQuery } from '@tanstack/react-query'
import { api } from '../lib/api'
import type { TopicTrend, Sentiment, Period } from '../types'

interface TopicsParams {
  sentiment?: Sentiment
  period?: Period
  direction?: string
}

export function useTopics(gameId: number | null, params: TopicsParams = {}) {
  return useQuery<TopicTrend[]>({
    queryKey: ['topics', gameId, params],
    queryFn: () =>
      api.get<TopicTrend[]>(`/games/${gameId}/topics`, { params }).then(r => r.data),
    enabled: gameId != null,
  })
}
