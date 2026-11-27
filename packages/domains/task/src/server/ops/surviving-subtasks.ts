import type { SlayzoneDb } from '@slayzone/platform'
import { taskEvents } from '../events.js'

interface Survivor {
  id: string
  project_id: string
}

/**
 * Delete erases only the selected tasks: their unselected subtasks survive, moved to
 * the nearest surviving ancestor by the erasure engine. Read before deleting, so
 * {@link announceSurvivingSubtasks} can tell listeners those rows changed.
 */
export async function survivingSubtasks(db: SlayzoneDb, ids: string[]): Promise<Survivor[]> {
  const selected = JSON.stringify(ids)
  return db.all<Survivor>(
    `SELECT id,project_id FROM tasks
      WHERE parent_id IN (SELECT value FROM json_each(?)) AND id NOT IN (SELECT value FROM json_each(?))`,
    [selected, selected]
  )
}

/**
 * Tasks linked to `ids` by a dependency, either way: deleting one of `ids` drops the
 * link, which changes the other task's blocked state. Read before deleting.
 */
export async function dependencyNeighbours(db: SlayzoneDb, ids: string[]): Promise<string[]> {
  const selected = JSON.stringify(ids)
  const rows = await db.all<{ id: string }>(
    `SELECT blocks_task_id AS id FROM task_dependencies WHERE task_id IN (SELECT value FROM json_each(?))
      UNION
      SELECT task_id AS id FROM task_dependencies WHERE blocks_task_id IN (SELECT value FROM json_each(?))`,
    [selected, selected]
  )
  return rows.map((r) => r.id)
}

/** `task:updated` for each re-parented subtask that still exists. */
export async function announceSurvivingSubtasks(
  db: SlayzoneDb,
  survivors: Survivor[]
): Promise<void> {
  for (const survivor of survivors) {
    if (!(await db.get('SELECT 1 FROM tasks WHERE id = ?', [survivor.id]))) continue
    taskEvents.emit('task:updated', { taskId: survivor.id, projectId: survivor.project_id })
  }
}
