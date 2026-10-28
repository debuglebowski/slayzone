import { useCallback } from 'react'
import { useTabStore } from '@slayzone/tabs-state'
import { getClientForHub, getHubIdForTask, useTRPCClient } from '@slayzone/transport/client'

export interface CloseTaskTabOptions {
  /** A write in flight for the task; a temporary task's delete waits for it. */
  after?: Promise<unknown>
}

/**
 * Closing a task's tab. A temporary task has no home outside its tab, so closing
 * it also kills its terminal and deletes the task — on the hub that owns it. The
 * tab still goes on the reopen stack, marked with that hub, so ⌘⇧T
 * (useReopenClosedTab) can restore it.
 *
 * `deleteTask` is the RAW (non-undoable) board delete: a scratch terminal closing
 * shouldn't surface an "undo delete" toast. The returned closers resolve once a
 * temporary task's delete has landed, so a caller can safely undo right after.
 *
 * `after` is a write still in flight for the task (⌘⇧D's status update): the tab
 * closes now; a temporary task's terminal kill + delete wait for that write and are
 * skipped if it fails — so the write never races a delete, and a failed one leaves
 * the task intact to reopen. The closers then also reject with the write's error.
 */
export function useCloseTaskTab(deleteTask: (taskId: string) => Promise<void>) {
  const trpcClient = useTRPCClient()

  const closeTab = useCallback(
    async (index: number, opts?: CloseTaskTabOptions): Promise<void> => {
      const store = useTabStore.getState()
      const tab = store.tabs[index]
      let deleted: Promise<void> | undefined
      let discardedOnHub: { hubId?: string } | undefined
      if (tab?.type === 'task') {
        const task = store._taskLookup.tasks.find((t) => t.id === tab.taskId)
        if (task?.is_temporary) {
          const hubId = getHubIdForTask(tab.taskId)
          const client = getClientForHub(hubId, trpcClient)
          const taskId = tab.taskId
          const discard = (): Promise<void> => {
            void client.pty.kill.mutate({ sessionId: `${taskId}:${taskId}` })
            return deleteTask(taskId)
          }
          deleted = opts?.after ? opts.after.then(discard) : discard()
          discardedOnHub = { hubId }
        }
      }
      store.closeTab(index, discardedOnHub)
      await (deleted ?? opts?.after)
    },
    [deleteTask, trpcClient]
  )

  const closeTabByTaskId = useCallback(
    async (taskId: string, opts?: CloseTaskTabOptions): Promise<void> => {
      const index = useTabStore
        .getState()
        .tabs.findIndex((t) => t.type === 'task' && t.taskId === taskId)
      if (index >= 0) await closeTab(index, opts)
      else await opts?.after
    },
    [closeTab]
  )

  return { closeTab, closeTabByTaskId }
}
