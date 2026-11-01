import { useCallback } from 'react'
import { useTabStore } from '@slayzone/tabs-state'

export interface CloseTaskTabOptions {
  /** A pending write whose completion the caller needs to await. */
  after?: Promise<unknown>
}

/** Close only the view. Scratch tasks and their running processes remain available. */
export function useCloseTaskTab() {
  const closeTab = useCallback(async (index: number, opts?: CloseTaskTabOptions): Promise<void> => {
    useTabStore.getState().closeTab(index)
    await opts?.after
  }, [])

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
