import type { SlayzoneDb } from '@slayzone/platform'

export async function getAllBlockedTaskIdsOp(db: SlayzoneDb): Promise<string[]> {
  const rows = await db.all<{ id: string }>(
    `SELECT DISTINCT blocks_task_id AS id FROM task_dependencies
      UNION
      SELECT id FROM tasks WHERE is_blocked = 1 AND deleted_at IS NULL`
  )
  return rows.map((r) => r.id)
}
