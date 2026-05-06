import type { Database } from 'better-sqlite3'
import type { Task } from '@slayzone/task/shared'
import { parseAndColorTasks } from './shared.js'

export function getSubTasksRecursiveOp(db: Database, rootId: string): Promise<Task[]> {
  const rows = db
    .prepare(
      `WITH RECURSIVE subtree(id) AS (
        SELECT id FROM tasks
        WHERE parent_id = ? AND archived_at IS NULL AND deleted_at IS NULL
        UNION ALL
        SELECT t.id FROM tasks t
        JOIN subtree s ON t.parent_id = s.id
        WHERE t.archived_at IS NULL AND t.deleted_at IS NULL
      )
      SELECT t.*, el.external_url AS linear_url
      FROM tasks t
      JOIN subtree ON subtree.id = t.id
      LEFT JOIN external_links el ON el.task_id = t.id AND el.provider = 'linear'
      ORDER BY t."order" ASC, t.created_at DESC`
    )
    .all(rootId) as Record<string, unknown>[]
  return parseAndColorTasks(db, rows)
}
