import type { Database } from 'better-sqlite3'
import type { Task } from '@slayzone/task/shared'
import { parseTasks } from './shared.js'

export function getBlockersOp(db: Database, taskId: string): Task[] {
  const rows = db
    .prepare(
      `SELECT tasks.* FROM tasks
       JOIN task_dependencies ON tasks.id = task_dependencies.task_id
       WHERE task_dependencies.blocks_task_id = ?`
    )
    .all(taskId) as Record<string, unknown>[]
  return parseTasks(rows)
}
