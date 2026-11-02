import { useQueryClient } from '@tanstack/react-query'
import { Alert } from 'react-native'
import type { BoardData } from '../hub-board'
import { useTRPC, useTRPCClient } from '../trpc'

/**
 * Archives tasks on the hub of the nearest `HubScope` (the board's project's hub, which
 * owns them) in one `task.archiveMany` — desktop's "Archive all" of a completed column.
 * Optimistic like desktop: the tasks leave the board at once; a failure puts them back,
 * reloads the board, and says why.
 */
export function useArchiveAll(): (taskIds: readonly string[]) => Promise<void> {
  const trpc = useTRPC()
  const client = useTRPCClient()
  const queryClient = useQueryClient()

  return async (taskIds) => {
    if (taskIds.length === 0) return
    const filter = trpc.task.loadBoardData.queryFilter()
    await queryClient.cancelQueries(filter)
    const snapshot = queryClient.getQueriesData<BoardData>(filter)
    const ids = new Set(taskIds)
    const now = new Date().toISOString()
    for (const [key, data] of snapshot) {
      if (!data) continue
      queryClient.setQueryData(key, {
        ...data,
        tasks: data.tasks.map((t) => (ids.has(t.id) ? { ...t, archived_at: now } : t))
      })
    }
    await client.task.archiveMany.mutate({ ids: [...taskIds] }).catch((error: unknown) => {
      for (const [key, data] of snapshot) queryClient.setQueryData(key, data)
      void queryClient.invalidateQueries(filter)
      Alert.alert(
        "Couldn't archive the tasks",
        error instanceof Error ? error.message : String(error)
      )
    })
  }
}
