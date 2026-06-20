import type { SlayzoneDb } from '@slayzone/platform'
import type { Task, UpdateTaskInput } from '@slayzone/task/shared'
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
    ipcMain?.emit('db:tasks:update:done', null, data.id, { oldStatus: result.previousTask?.status })
    const projectId =
      result.nextTask.project_id ?? result.previousTask?.project_id ?? data.projectId
    if (projectId) {
      taskEvents.emit('task:updated', {
        taskId: data.id,
        projectId,
        oldStatus: result.previousTask?.status
      })
    }
    onMutation?.()
  }
  return colorOne(db, result.nextTask)
}
