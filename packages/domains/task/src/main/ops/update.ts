import type { Database } from 'better-sqlite3'
import type { Task, UpdateTaskInput } from '@slayzone/task/shared'
import { recordActivityEvents } from '@slayzone/history/main'
import { buildTaskUpdatedEvents } from '../history.js'
import { colorOne, parseTask, updateTask, type OpDeps } from './shared.js'

export async function updateTaskOp(db: Database, data: UpdateTaskInput, deps: OpDeps): Promise<Task | null> {
  const { ipcMain, onMutation } = deps
  const result = db.transaction(() => {
    const previousRow = db.prepare('SELECT * FROM tasks WHERE id = ?').get(data.id) as Record<string, unknown> | undefined
    const previousTask = parseTask(previousRow)
    const nextTask = updateTask(db, data)

    if (previousTask && nextTask) {
      recordActivityEvents(db, buildTaskUpdatedEvents(previousTask, nextTask))
    }

    return {
      previousTask,
      nextTask,
    }
  })()

  if (result.nextTask) {
    ipcMain.emit('db:tasks:update:done', null, data.id, { oldStatus: result.previousTask?.status })
    onMutation?.()
  }
  return colorOne(db, result.nextTask)
}
