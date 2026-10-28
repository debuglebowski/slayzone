import { useCallback } from 'react'
import { type QueryClient, useQueryClient } from '@tanstack/react-query'
import { useTRPC } from './trpc'

/** Which provider's status sync locks the project's statuses (null = none, or unknown). */
export async function fetchStatusSyncLock(
  queryClient: QueryClient,
  trpc: ReturnType<typeof useTRPC>,
  projectId: string
): Promise<string | null> {
  try {
    const [linear, github] = await Promise.all([
      queryClient.fetchQuery(
        trpc.integrations.getProjectMapping.queryOptions({ projectId, provider: 'linear' })
      ),
      queryClient.fetchQuery(
        trpc.integrations.getProjectMapping.queryOptions({ projectId, provider: 'github' })
      )
    ])
    if (linear?.status_setup_complete) return 'Linear'
    if (github?.status_setup_complete) return 'GitHub'
    return null
  } catch {
    return null
  }
}

/**
 * The status-sync lock lookup ProjectSettingsDialog runs (projects'
 * `ProjectSettingsTabs.useStatusSyncLockLookup`). Its identity follows the query
 * client and the hub's tRPC proxy, so the dialog re-checks when either changes.
 */
export function useStatusSyncLockLookup(): (projectId: string) => Promise<string | null> {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  return useCallback(
    (projectId: string) => fetchStatusSyncLock(queryClient, trpc, projectId),
    [queryClient, trpc]
  )
}
