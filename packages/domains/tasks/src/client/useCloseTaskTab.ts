import { useCallback } from 'react'
import { useTabStore } from '@slayzone/settings/client'
import { getClientForHub, getHubIdForTask, useTRPCClient } from '@slayzone/transport/client'

/**
 * Closing a task's tab. A temporary task has no home outside its tab, so closing
 * it also kills its terminal and deletes the task — on the hub that owns it.
 *
 * `deleteTask` is the RAW (non-undoable) board delete: a scratch terminal closing
 * shouldn't surface an "undo delete" toast. The returned closers resolve once a
 * temporary task's delete has landed, so a caller can safely undo right after.
 */
export function useCloseTaskTab(deleteTask: (taskId: string) => Promise<void>) {
  const trpcClient = useTRPCClient()

  const closeTab = useCallback(
    async (index: number): Promise<void> => {
      const store = useTabStore.getState()
      const tab = store.tabs[index]
      let discarded: Promise<void> | undefined
      if (tab?.type === 'task') {
        const task = store._taskLookup.tasks.find((t) => t.id === tab.taskId)
        if (task?.is_temporary) {
          const client = getClientForHub(getHubIdForTask(tab.taskId), trpcClient)
          void client.pty.kill.mutate({ sessionId: `${tab.taskId}:${tab.taskId}` })
          discarded = deleteTask(tab.taskId)
        }
      }
      store.closeTab(index)
      await discarded
    },
    [deleteTask, trpcClient]
  )

  const closeTabByTaskId = useCallback(
    async (taskId: string): Promise<void> => {
      const index = useTabStore
        .getState()
        .tabs.findIndex((t) => t.type === 'task' && t.taskId === taskId)
      if (index >= 0) await closeTab(index)
    },
    [closeTab]
  )

  return { closeTab, closeTabByTaskId }
}
