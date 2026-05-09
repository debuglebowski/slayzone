import { useState, useEffect, useCallback } from 'react'
import { useTRPCClient } from "@slayzone/transport/client"
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
  const trpcClient = useTRPCClient()
  const [groups, setGroups] = useState<ExternalGroup[]>([])
  const [scopes, setScopes] = useState<ExternalScope[]>([])
  const [loadingGroups, setLoadingGroups] = useState(false)
  const [loadingScopes, setLoadingScopes] = useState(false)
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(options?.initialGroupId ?? null)
  const [selectedScopeId, setSelectedScopeId] = useState<string | null>(options?.initialScopeId ?? null)
  const [error, setError] = useState<string | null>(null)
  const [reloadCounter, setReloadCounter] = useState(0)

  const reload = useCallback(() => setReloadCounter((c) => c + 1), [])

  // Load groups when connection changes
  useEffect(() => {
    if (!connectionId) {
      setGroups([])
      setScopes([])
      setSelectedGroupId(null)
      setSelectedScopeId(null)
      return
    }

    let cancelled = false
    setLoadingGroups(true)
    setError(null)

    trpcClient.integrations.listProviderGroups.query({ connectionId }).then(
      (result) => {
        if (cancelled) return
        setGroups(result)
        setLoadingGroups(false)
        // Auto-select initial group if available
        if (options?.initialGroupId && result.some((g) => g.id === options.initialGroupId)) {
          setSelectedGroupId(options.initialGroupId)
        } else if (!selectedGroupId || !result.some((g) => g.id === selectedGroupId)) {
          setSelectedGroupId(result[0]?.id ?? null)
        }
      },
      (err) => {
        if (cancelled) return
        setError(err instanceof Error ? err.message : String(err))
        setLoadingGroups(false)
      }
    )

    return () => { cancelled = true }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectionId, reloadCounter])

  // Load scopes when group changes
  useEffect(() => {
    if (!connectionId || !selectedGroupId) {
      setScopes([])
      setSelectedScopeId(null)
      return
    }

    let cancelled = false
    setLoadingScopes(true)

    trpcClient.integrations.listProviderScopes.query({ connectionId, groupId: selectedGroupId }).then(
      (result) => {
        if (cancelled) return
        setScopes(result)
        setLoadingScopes(false)
        if (options?.initialScopeId && result.some((s) => s.id === options.initialScopeId)) {
          setSelectedScopeId(options.initialScopeId)
        } else if (!selectedScopeId || !result.some((s) => s.id === selectedScopeId)) {
          setSelectedScopeId(result[0]?.id ?? null)
        }
      },
      (err) => {
        if (cancelled) return
        setError(err instanceof Error ? err.message : String(err))
        setLoadingScopes(false)
      }
    )

    return () => { cancelled = true }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectionId, selectedGroupId, reloadCounter])

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
