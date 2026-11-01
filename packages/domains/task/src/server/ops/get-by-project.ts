import type { SlayzoneDb } from '@slayzone/platform'
import type { Task } from '@slayzone/task-contracts'
import { parseAndColorTasks, TASK_ORDER_BY } from './shared.js'

export async function getByProjectOp(db: SlayzoneDb, projectId: string): Promise<Task[]> {
  const rows = await db.all<Record<string, unknown>>(
    `SELECT t.*, el.external_url AS linear_url
      FROM tasks t
      LEFT JOIN external_links el ON el.task_id = t.id AND el.provider = 'linear'
      WHERE t.project_id = ? AND t.archived_at IS NULL AND t.deleted_at IS NULL
      ${TASK_ORDER_BY}`,
    [projectId]
  )
  return parseAndColorTasks(db, rows)
}

/** Trash is scoped to one project and retains entries for 30 days. */
export async function getDeletedTasksOp(db: SlayzoneDb, projectId: string): Promise<Task[]> {
  const rows = await db.all<Record<string, unknown>>(
    `SELECT t.*, el.external_url AS linear_url
      FROM tasks t
      LEFT JOIN external_links el ON el.task_id = t.id AND el.provider = 'linear'
      WHERE t.project_id = ? AND t.deleted_at IS NOT NULL
        AND t.deleted_at >= datetime('now', '-30 days')
      ORDER BY t.deleted_at DESC, t.id`,
    [projectId]
  )
  return parseAndColorTasks(db, rows)
}
