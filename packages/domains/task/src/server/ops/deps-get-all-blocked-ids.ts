import type { Database } from 'better-sqlite3'

export function getAllBlockedTaskIdsOp(db: Database): string[] {
  const rows = db
    .prepare(`SELECT DISTINCT blocks_task_id AS id FROM task_dependencies
      UNION
      SELECT id FROM tasks WHERE is_blocked = 1 AND deleted_at IS NULL`)
    .all() as { id: string }[]
  return rows.map((r) => r.id)
}
