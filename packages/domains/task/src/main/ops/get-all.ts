import type { SlayzoneDb } from '@slayzone/platform'
import type { Task } from '@slayzone/task/shared'
import { parseAndColorTasks } from './shared.js'

export async function getAllTasksOp(db: SlayzoneDb): Promise<Task[]> {
  const rows = await db.all<Record<string, unknown>>(
    `SELECT t.*, el.external_url AS linear_url
      FROM tasks t
      LEFT JOIN external_links el ON el.task_id = t.id AND el.provider = 'linear'
      WHERE t.deleted_at IS NULL
      ORDER BY t."order" ASC, t.created_at DESC`
  )
  return parseAndColorTasks(db, rows)
}
