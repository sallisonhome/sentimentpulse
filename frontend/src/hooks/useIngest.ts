import { useQuery, useMutation } from '@tanstack/react-query'
import { api } from '../lib/api'
import { queryClient } from '../lib/queryClient'
import type { IngestStatus, IngestRunResult } from '../types'

export function useIngestStatus() {
  return useQuery<IngestStatus>({
    queryKey: ['ingest', 'status'],
    queryFn: () => api.get<IngestStatus>('/ingest/status').then(r => r.data),
    refetchInterval: (query) => {
      // Poll every 5s while running, otherwise every 30s
      return query.state.data?.is_running ? 5_000 : 30_000
    },
  })
}

export function useTriggerIngest() {
  return useMutation<IngestRunResult>({
    mutationFn: () => api.post<IngestRunResult>('/ingest/run').then(r => r.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['ingest', 'status'] })
      queryClient.invalidateQueries({ queryKey: ['dashboard'] })
      queryClient.invalidateQueries({ queryKey: ['summaries'] })
      queryClient.invalidateQueries({ queryKey: ['topics'] })
      queryClient.invalidateQueries({ queryKey: ['posts'] })
    },
  })
}
