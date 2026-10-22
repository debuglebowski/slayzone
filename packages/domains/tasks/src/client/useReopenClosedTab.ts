import { useCallback } from 'react'
import { useTabStore, type ClosedTabRestorer } from '@slayzone/settings/client'
import { getClientForHub, useHubOwnershipStore, useTRPCClient } from '@slayzone/transport/client'
import type { Task } from '@slayzone/task/shared'
import { toast } from '@slayzone/ui'

/**
 * ⌘⇧T: reopen the last closed tab. Closing a temporary task's tab deleted the
 * task (useCloseTaskTab), so reopening one first restores it on the hub that
 * owned it, and upserts it onto the board before the tab opens — otherwise the
 * tab sync that drops tabs of vanished tasks would close it again straight away.
 */
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
