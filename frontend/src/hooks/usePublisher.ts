import { useQuery } from '@tanstack/react-query'
import { api } from '../lib/api'
import type { Publisher } from '../types'

export function usePublisher() {
  return useQuery<Publisher>({
    queryKey: ['publisher'],
    queryFn: () => api.get<Publisher>('/publishers/me').then(r => r.data),
  })
}
