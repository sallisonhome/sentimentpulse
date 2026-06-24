/**
 * Hooks for managing the executive digest recipient list.
 *
 * Mirror of /api/digest/recipients (GET/POST/PATCH/DELETE).  All mutations
 * invalidate the recipient list query so the Settings UI updates
 * immediately without a refetch hop.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../lib/api'

export interface DigestRecipient {
  id: number
  email: string
  is_active: boolean
  created_at: string
}

const KEY = ['digest-recipients']

export function useDigestRecipients() {
  return useQuery<DigestRecipient[]>({
    queryKey: KEY,
    queryFn: () => api.get<DigestRecipient[]>('/digest/recipients').then(r => r.data),
  })
}

export function useAddDigestRecipient() {
  const qc = useQueryClient()
  return useMutation<DigestRecipient, Error, string>({
    mutationFn: (email: string) =>
      api.post<DigestRecipient>('/digest/recipients', { email }).then(r => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  })
}

export function useDeleteDigestRecipient() {
  const qc = useQueryClient()
  return useMutation<void, Error, number>({
    mutationFn: (id: number) =>
      api.delete(`/digest/recipients/${id}`).then(() => undefined),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  })
}

export function useToggleDigestRecipient() {
  const qc = useQueryClient()
  return useMutation<DigestRecipient, Error, { id: number; is_active: boolean }>({
    mutationFn: ({ id, is_active }) =>
      api.patch<DigestRecipient>(`/digest/recipients/${id}`, { is_active })
        .then(r => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  })
}
