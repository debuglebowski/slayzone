import { useEffect, useState, useCallback } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTRPC } from '@slayzone/transport/client'
import type { ExternalGroup, ExternalScope } from '@slayzone/integrations/shared'

export interface UseProviderDataResult {
  groups: ExternalGroup[]
  scopes: ExternalScope[]
  loadingGroups: boolean
  loadingScopes: boolean
  selectedGroupId: string | null
  selectedScopeId: string | null
  setSelectedGroupId: (id: string | null) => void
  setSelectedScopeId: (id: string | null) => void
  error: string | null
  reload: () => void
}

/**
 * Generic hook for loading provider groups (teams/repos/projects) and
 * scopes (Linear projects, GitHub ProjectV2, etc.) via adapter-dispatched IPC.
 */
export function useProviderData(
  connectionId: string | null,
  options?: {
    initialGroupId?: string | null
    initialScopeId?: string | null
  }
): UseProviderDataResult {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(options?.initialGroupId ?? null)
  const [selectedScopeId, setSelectedScopeId] = useState<string | null>(options?.initialScopeId ?? null)

  const groupsQuery = useQuery({
    ...trpc.integrations.listProviderGroups.queryOptions({ connectionId: connectionId ?? '' }),
    enabled: !!connectionId,
  })
  const scopesQuery = useQuery({
    ...trpc.integrations.listProviderScopes.queryOptions({ connectionId: connectionId ?? '', groupId: selectedGroupId ?? '' }),
    enabled: !!connectionId && !!selectedGroupId,
  })

  const groups = groupsQuery.data ?? []
  const scopes = scopesQuery.data ?? []
  const loadingGroups = !!connectionId && groupsQuery.isLoading
  const loadingScopes = !!connectionId && !!selectedGroupId && scopesQuery.isLoading
  const error = (groupsQuery.error ?? scopesQuery.error) ? String((groupsQuery.error ?? scopesQuery.error)) : null

  // Auto-select initial / first group when data arrives
  useEffect(() => {
    if (!connectionId) { setSelectedGroupId(null); setSelectedScopeId(null); return }
    if (!groupsQuery.data) return
    if (options?.initialGroupId && groups.some((g) => g.id === options.initialGroupId)) {
      setSelectedGroupId(options.initialGroupId)
    } else if (!selectedGroupId || !groups.some((g) => g.id === selectedGroupId)) {
      setSelectedGroupId(groups[0]?.id ?? null)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectionId, groupsQuery.data])

  // Auto-select initial / first scope when data arrives
  useEffect(() => {
    if (!scopesQuery.data) return
    if (options?.initialScopeId && scopes.some((s) => s.id === options.initialScopeId)) {
      setSelectedScopeId(options.initialScopeId)
    } else if (!selectedScopeId || !scopes.some((s) => s.id === selectedScopeId)) {
      setSelectedScopeId(scopes[0]?.id ?? null)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopesQuery.data])

  const reload = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: trpc.integrations.listProviderGroups.queryKey() })
    queryClient.invalidateQueries({ queryKey: trpc.integrations.listProviderScopes.queryKey() })
  }, [queryClient, trpc])

  return {
    groups,
    scopes,
    loadingGroups,
    loadingScopes,
    selectedGroupId,
    selectedScopeId,
    setSelectedGroupId,
    setSelectedScopeId,
    error,
    reload
  }
}
