import { useState, useEffect, useCallback } from 'react'
import { useQuery } from '@tanstack/react-query'
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
 * scopes (Linear projects, GitHub ProjectV2, etc.) via adapter-dispatched tRPC.
 *
 * Replaces per-provider useState + useEffect pairs for group/scope loading.
 */
export function useProviderData(
  connectionId: string | null,
  options?: {
    /** Pre-select a group on load */
    initialGroupId?: string | null
    /** Pre-select a scope on load */
    initialScopeId?: string | null
  }
): UseProviderDataResult {
  const trpc = useTRPC()
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(
    options?.initialGroupId ?? null
  )
  const [selectedScopeId, setSelectedScopeId] = useState<string | null>(
    options?.initialScopeId ?? null
  )

  // Groups for the active connection.
  const groupsQuery = useQuery(
    trpc.integrations.listProviderGroups.queryOptions(
      { connectionId: connectionId ?? '' },
      { enabled: !!connectionId }
    )
  )

  // Scopes for the active connection + selected group.
  const scopesQuery = useQuery(
    trpc.integrations.listProviderScopes.queryOptions(
      { connectionId: connectionId ?? '', groupId: selectedGroupId ?? '' },
      { enabled: !!connectionId && !!selectedGroupId }
    )
  )

  const groups = (connectionId ? groupsQuery.data : undefined) ?? []
  const scopes =
    connectionId && selectedGroupId ? (scopesQuery.data ?? []) : []

  // Reset selections when the connection clears.
  useEffect(() => {
    if (!connectionId) {
      setSelectedGroupId(null)
      setSelectedScopeId(null)
    }
  }, [connectionId])

  // Auto-select a group once groups load (mirrors the old fetch callback).
  useEffect(() => {
    if (!connectionId || !groupsQuery.isSuccess) return
    const result = groupsQuery.data ?? []
    setSelectedGroupId((current) => {
      if (options?.initialGroupId && result.some((g) => g.id === options.initialGroupId)) {
        return options.initialGroupId
      }
      if (!current || !result.some((g) => g.id === current)) {
        return result[0]?.id ?? null
      }
      return current
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectionId, groupsQuery.isSuccess, groupsQuery.data])

  // Clear scope selection when group clears (mirrors old effect's early-return).
  useEffect(() => {
    if (!connectionId || !selectedGroupId) setSelectedScopeId(null)
  }, [connectionId, selectedGroupId])

  // Auto-select a scope once scopes load.
  useEffect(() => {
    if (!connectionId || !selectedGroupId || !scopesQuery.isSuccess) return
    const result = scopesQuery.data ?? []
    setSelectedScopeId((current) => {
      if (options?.initialScopeId && result.some((s) => s.id === options.initialScopeId)) {
        return options.initialScopeId
      }
      if (!current || !result.some((s) => s.id === current)) {
        return result[0]?.id ?? null
      }
      return current
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectionId, selectedGroupId, scopesQuery.isSuccess, scopesQuery.data])

  const reload = useCallback(() => {
    void groupsQuery.refetch()
    void scopesQuery.refetch()
  }, [groupsQuery, scopesQuery])

  const groupsError = groupsQuery.error
  const scopesError = scopesQuery.error
  const error = groupsError
    ? groupsError instanceof Error
      ? groupsError.message
      : String(groupsError)
    : scopesError
      ? scopesError instanceof Error
        ? scopesError.message
        : String(scopesError)
      : null

  return {
    groups,
    scopes,
    loadingGroups: !!connectionId && groupsQuery.isFetching,
    loadingScopes: !!connectionId && !!selectedGroupId && scopesQuery.isFetching,
    selectedGroupId,
    selectedScopeId,
    setSelectedGroupId,
    setSelectedScopeId,
    error,
    reload
  }
}
