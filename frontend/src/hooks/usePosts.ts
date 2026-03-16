import { useQuery } from '@tanstack/react-query'
import { api } from '../lib/api'
import type { PostsPage, Sentiment, Source } from '../types'

interface PostsParams {
  page?: number
  page_size?: number
  sentiment?: Sentiment
  source?: Source
  search?: string
  date_from?: string   // ISO date string YYYY-MM-DD
  date_to?: string     // ISO date string YYYY-MM-DD
}

export function usePosts(gameId: number | null, params: PostsParams = {}) {
  return useQuery<PostsPage>({
    queryKey: ['posts', gameId, params],
    queryFn: () =>
      api.get<PostsPage>(`/games/${gameId}/posts`, { params }).then(r => r.data),
    enabled: gameId != null,
  })
}
