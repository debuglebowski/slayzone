import type { SlayzoneDb } from '@slayzone/platform'
import type { Task } from '@slayzone/task/shared'
import { parseTasks } from './shared.js'

export async function getBlockersOp(db: SlayzoneDb, taskId: string): Promise<Task[]> {
  const rows = await db.all<Record<string, unknown>>(
    `SELECT tasks.* FROM tasks
       JOIN task_dependencies ON tasks.id = task_dependencies.task_id
       WHERE task_dependencies.blocks_task_id = ?`,
    [taskId]
  )
  return parseTasks(rows)
}
