import type { Database } from 'better-sqlite3'
import type { Task } from '@slayzone/task/shared'
import { parseTasks } from './shared.js'

export function getArchivedTasksOp(db: Database): Task[] {
  const rows = db
    .prepare('SELECT * FROM tasks WHERE archived_at IS NOT NULL AND deleted_at IS NULL ORDER BY archived_at DESC')
    .all() as Record<string, unknown>[]
  return parseTasks(rows)
}
