import type { SlayzoneDb } from '@slayzone/platform'
import type { Task, UpdateTaskInput } from '@slayzone/task/shared'
import { buildTaskUpdatedEvents } from '../history.js'
import { taskEvents } from '../events.js'
import { colorOne, parseTask, updateTask, type OpDeps } from './shared.js'

export async function updateTaskOp(
  db: SlayzoneDb,
  data: UpdateTaskInput,
  deps: OpDeps
): Promise<Task | null> {
  const { ipcMain, onMutation } = deps
  // `updateTask` is a conditional read-modify-write that runs side effects via
  // runtime adapters, so it can't live inside a worker named-txn. Read the prior
  // row, apply the update, then record the diff-derived activity events atomically
  // through the `task:record-events` named transaction (keeps `recordActivityEvents`
  // running synchronously inside the worker).
  const previousRow = await db.get<Record<string, unknown>>('SELECT * FROM tasks WHERE id = ?', [
    data.id
  ])
  const previousTask = parseTask(previousRow)
  const nextTask = await updateTask(db, data)

  if (previousTask && nextTask) {
    const events = buildTaskUpdatedEvents(previousTask, nextTask)
    if (events.length > 0) {
      await db.namedTxn('task:record-events', { events })
    }
  }

  const result = { previousTask, nextTask }

  if (result.nextTask) {
    ipcMain.emit('db:tasks:update:done', null, data.id, { oldStatus: result.previousTask?.status })
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
