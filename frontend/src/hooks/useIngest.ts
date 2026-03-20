import { useEffect, useRef } from 'react'
import { useQuery, useMutation } from '@tanstack/react-query'
import { api } from '../lib/api'
import { queryClient } from '../lib/queryClient'
import type { IngestStatus, IngestRunResult } from '../types'

export function useIngestStatus() {
  return useQuery<IngestStatus>({
    queryKey: ['ingest', 'status'],
    queryFn: () => api.get<IngestStatus>('/ingest/status').then(r => r.data),
    refetchInterval: (query) => {
      // Poll every 3s while running, otherwise every 30s
      return query.state.data?.is_running ? 3_000 : 30_000
    },
  })
}

/**
 * Watches ingest status and invalidates all data queries when a run
 * transitions from running → finished, so the UI refreshes automatically.
 */
export function useIngestAutoRefresh() {
  const { data: status } = useIngestStatus()
  const wasRunning = useRef(false)

  useEffect(() => {
    if (status?.is_running) {
      wasRunning.current = true
    } else if (wasRunning.current && status && !status.is_running) {
      // Ingestion just finished — refresh everything
      wasRunning.current = false
      queryClient.invalidateQueries({ queryKey: ['games'] })
      queryClient.invalidateQueries({ queryKey: ['dashboard'] })
      queryClient.invalidateQueries({ queryKey: ['summaries'] })
      queryClient.invalidateQueries({ queryKey: ['topics'] })
      queryClient.invalidateQueries({ queryKey: ['posts'] })
      queryClient.invalidateQueries({ queryKey: ['ingest', 'status'] })
    }
  }, [status?.is_running])
}

export function useTriggerIngest() {
  return useMutation<IngestRunResult>({
    mutationFn: () => api.post<IngestRunResult>('/ingest/run').then(r => r.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['ingest', 'status'] })
    },
  })
}
