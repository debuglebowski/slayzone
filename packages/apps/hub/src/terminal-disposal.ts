import type { SlayzoneDb } from '@slayzone/platform'
import { taskEvents } from '@slayzone/task/server'
import { tabsEvents } from '@slayzone/task-terminals/server'
import type { createPtyOps } from '@slayzone/terminal/hub'
import { onTaskErased } from '@slayzone/content-erasure/server'

/** Confirmed row deletion ends terminal lifetime independently of renderer presence. */
export function wireTerminalDisposal(
  db: SlayzoneDb,
  ops: Pick<ReturnType<typeof createPtyOps>, 'ptyDisposeSession' | 'ptyDisposeTask'>
): () => void {
  const tab = ({ taskId, tabId }: { taskId: string; tabId: string }) =>
    ops.ptyDisposeSession(`${taskId}:${tabId}`)
  const task = ({ taskId }: { taskId: string }) => ops.ptyDisposeTask(taskId)
  tabsEvents.on('tab:deleted', tab)
  taskEvents.on('task:deleted', task)
  const stopErasure = onTaskErased(db, (taskId) => ops.ptyDisposeTask(taskId))
  return () => {
    tabsEvents.off('tab:deleted', tab)
    taskEvents.off('task:deleted', task)
    stopErasure()
  }
}
