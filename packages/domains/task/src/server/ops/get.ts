import type { SlayzoneDb } from '@slayzone/platform'
import type { Task } from '@slayzone/task/shared'
import { parseAndColorTask } from './shared.js'

export async function getTaskOp(db: SlayzoneDb, id: string): Promise<Task | null> {
  const row = await db.get<Record<string, unknown>>(
    `SELECT t.*, el.external_url AS linear_url
    FROM tasks t
    LEFT JOIN external_links el ON el.task_id = t.id AND el.provider = 'linear'
    WHERE t.id = ?`,
    [id]
  )
  return parseAndColorTask(db, row)
}
