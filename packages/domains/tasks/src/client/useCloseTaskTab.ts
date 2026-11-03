import { useCallback } from 'react'
import { useTabStore } from '@slayzone/tabs-state'
import { getHubIdForTask } from '@slayzone/transport/client'
import { getClientForHub, useTRPCClient } from './trpc'

export interface CloseTaskTabOptions {
  /** A pending write whose completion the caller needs to await. */
  after?: Promise<unknown>
}

/**
 * Closing a task's tab. A regular task keeps running in the background. A
 * temporary (scratch) task's tab IS its agent, so closing it also stops every
 * process the task owns — terminals and chats, on the hub that owns it. The task
 * itself is kept: ⌘⇧T or the project's scratch-terminal list reopens it, and its
 * terminal auto-starts again.
 *
 * `after` is a write still in flight for the task (⌘⇧D's status update): the tab
 * closes now; the scratch kill waits for that write and is skipped if it fails, so
 * a rolled-back close finds its agent still running. The closers then reject with
 * the write's error; a failed stop itself is only logged.
 */
export function useCloseTaskTab() {
  const trpcClient = useTRPCClient()

  const closeTab = useCallback(
    async (index: number, opts?: CloseTaskTabOptions): Promise<void> => {
      const store = useTabStore.getState()
      const tab = store.tabs[index]
      let stopped: Promise<unknown> | undefined
      if (tab?.type === 'task') {
        const task = store._taskLookup.tasks.find((t) => t.id === tab.taskId)
        if (task?.is_temporary) {
          const taskId = tab.taskId
          const client = getClientForHub(getHubIdForTask(taskId), trpcClient)
          // The tab is already gone; a failed stop must not surface as a close error.
          const stop = () =>
            client.pty.killTask.mutate({ taskId }).catch((err: unknown) => {
              console.error('[closeTab] failed to stop scratch terminal', taskId, err)
            })
          stopped = opts?.after ? opts.after.then(stop) : stop()
        }
      }
      store.closeTab(index)
      await (stopped ?? opts?.after)
    },
    [trpcClient]
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
