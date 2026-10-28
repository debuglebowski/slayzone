import type { SlayzoneDb } from '@slayzone/platform'
import type { Task, UpdateTaskInput } from '@slayzone/task-contracts'
import { taskEvents } from '../events.js'
import { colorOne, parseTask, updateTask, type OpDeps } from './shared.js'

export async function updateTaskOp(
  db: SlayzoneDb,
  data: UpdateTaskInput,
  deps: OpDeps
): Promise<Task | null> {
  const { ipcMain, onMutation } = deps
  // `updateTask` commits its field UPDATE + the diff-derived activity events
  // atomically (worker `task:update` txn) — a failed event insert rolls back the
  // field write. We still read the prior row here for the post-mutation
  // `task:updated` event's `oldStatus`.
  const previousRow = await db.get<Record<string, unknown>>('SELECT * FROM tasks WHERE id = ?', [
    data.id
  ])
  const previousTask = parseTask(previousRow)
  const nextTask = await updateTask(db, data)

  const result = { previousTask, nextTask }

  if (result.nextTask) {
    // The row before and after, so listeners (integration push) can tell what changed.
    ipcMain?.emit('db:tasks:update:done', null, data.id, {
      oldStatus: result.previousTask?.status,
      previous: result.previousTask,
      next: result.nextTask
    })
    const projectId =
      result.nextTask.project_id ?? result.previousTask?.project_id ?? data.projectId
    if (projectId) {
      taskEvents.emit('task:updated', {
        taskId: data.id,
        projectId,
        oldStatus: result.previousTask?.status
      })
    }
    // `updateTask` writes only this task's row (+ its conversation ledger, which
    // feeds the same row's `currentConversationByMode`), so the renderer can
    // patch just this row instead of reloading the board.
    onMutation?.({ taskIds: [data.id] })
  }
  return colorOne(db, result.nextTask)
}
