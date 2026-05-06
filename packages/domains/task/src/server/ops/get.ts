import type { Database } from 'better-sqlite3'
import type { Task } from '@slayzone/task/shared'
import { parseAndColorTask } from './shared.js'

export function getTaskOp(db: Database, id: string): Promise<Task | null> {
  const row = db.prepare(
    `SELECT t.*, el.external_url AS linear_url
    FROM tasks t
    LEFT JOIN external_links el ON el.task_id = t.id AND el.provider = 'linear'
    WHERE t.id = ?`
  ).get(id) as Record<string, unknown> | undefined
  return parseAndColorTask(db, row)
}
