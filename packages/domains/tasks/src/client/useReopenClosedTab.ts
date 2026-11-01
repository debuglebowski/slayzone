import { useCallback } from 'react'
import { useTabStore, type ClosedTabRestorer } from '@slayzone/tabs-state'
import { useHubOwnershipStore } from '@slayzone/transport/client'
import { getClientForHub, useTRPCClient } from './trpc'
import type { Task } from '@slayzone/task-contracts'
import { toast } from '@slayzone/ui'

/** Reopen a preserved tab. Also restores legacy scratch tabs closed before
 * tab closing stopped deleting tasks, so existing reopen stacks keep working. */
export function useReopenClosedTab(
  /** Upsert one task into board state (useTasksData's updateTask). */
  updateTask: (task: Task | null | undefined) => void
): () => Promise<void> {
  const trpcClient = useTRPCClient()

  return useCallback(async (): Promise<void> => {
    const restore: ClosedTabRestorer = async ({ taskId, discarded }) => {
      const hubId = discarded?.hubId
      const restored = await getClientForHub(hubId, trpcClient).task.restore.mutate({ id: taskId })
      if (!restored) return null
      if (hubId) useHubOwnershipStore.getState().noteTaskHub(taskId, hubId)
      updateTask(restored)
      return restored
    }
    try {
      await useTabStore.getState().reopenClosedTab(restore)
    } catch (err) {
      console.error('[tabs] reopen closed tab failed:', err)
      toast.error("Couldn't reopen the closed tab")
    }
  }, [trpcClient, updateTask])
}
