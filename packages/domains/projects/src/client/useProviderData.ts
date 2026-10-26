import { useState, useCallback } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTRPC } from '@slayzone/transport/client'
import type { ExternalGroup, ExternalScope } from '@slayzone/integrations/shared'
import { depsChanged } from './deps-changed'

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
  const scopes = connectionId && selectedGroupId ? (scopesQuery.data ?? []) : []

  // The four selection rules below are adjusted during render, each keyed on
  // the dependencies (and evaluated in the order) of the effect it replaces.
  // Each starts unseen (`null`) because those effects acted on mount too. The
  // initial-id options are read when a rule fires, as the effects did.

  // Reset selections when the connection clears.
  const [connectionSeen, setConnectionSeen] = useState<readonly unknown[] | null>(null)
  if (depsChanged(connectionSeen, [connectionId])) {
    setConnectionSeen([connectionId])
    if (!connectionId) {
      setSelectedGroupId(null)
      setSelectedScopeId(null)
    }
  }

  // Auto-select a group once groups load (mirrors the old fetch callback).
  const groupsSeenDeps = [connectionId, groupsQuery.isSuccess, groupsQuery.data]
  const [groupsSeen, setGroupsSeen] = useState<readonly unknown[] | null>(null)
  if (depsChanged(groupsSeen, groupsSeenDeps)) {
    setGroupsSeen(groupsSeenDeps)
    if (connectionId && groupsQuery.isSuccess) {
      const result = groupsQuery.data ?? []
      const initialGroupId = options?.initialGroupId
      setSelectedGroupId((current) => {
        if (initialGroupId && result.some((g) => g.id === initialGroupId)) {
          return initialGroupId
        }
        if (!current || !result.some((g) => g.id === current)) {
          return result[0]?.id ?? null
        }
        return current
      })
    }
  }

  // Clear scope selection when group clears (mirrors old effect's early-return).
  const [groupSeen, setGroupSeen] = useState<readonly unknown[] | null>(null)
  if (depsChanged(groupSeen, [connectionId, selectedGroupId])) {
    setGroupSeen([connectionId, selectedGroupId])
    if (!connectionId || !selectedGroupId) setSelectedScopeId(null)
  }

  // Auto-select a scope once scopes load.
  const scopesSeenDeps = [connectionId, selectedGroupId, scopesQuery.isSuccess, scopesQuery.data]
  const [scopesSeen, setScopesSeen] = useState<readonly unknown[] | null>(null)
  if (depsChanged(scopesSeen, scopesSeenDeps)) {
    setScopesSeen(scopesSeenDeps)
    if (connectionId && selectedGroupId && scopesQuery.isSuccess) {
      const result = scopesQuery.data ?? []
      const initialScopeId = options?.initialScopeId
      setSelectedScopeId((current) => {
        if (initialScopeId && result.some((s) => s.id === initialScopeId)) {
          return initialScopeId
        }
        if (!current || !result.some((s) => s.id === current)) {
          return result[0]?.id ?? null
        }
        return current
      })
    }
  }

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
