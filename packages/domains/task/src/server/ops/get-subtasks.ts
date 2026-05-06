import type { Database } from 'better-sqlite3'
import type { Task } from '@slayzone/task/shared'
import { parseAndColorTasks } from './shared.js'

export function getSubTasksOp(db: Database, parentId: string): Promise<Task[]> {
  const rows = db
    .prepare(
      `SELECT t.*, el.external_url AS linear_url
      FROM tasks t
      LEFT JOIN external_links el ON el.task_id = t.id AND el.provider = 'linear'
      WHERE t.parent_id = ? AND t.archived_at IS NULL AND t.deleted_at IS NULL
      ORDER BY t."order" ASC, t.created_at DESC`
    )
    .all(parentId) as Record<string, unknown>[]
  return parseAndColorTasks(db, rows)
}
