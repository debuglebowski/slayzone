import type { SlayzoneDb } from '@slayzone/platform'
import { isTerminalStatus } from '@slayzone/projects-contracts'
import { getProjectColumns } from './shared.js'

/** Why a task's agents have been ended — see {@link whyTaskAgentsEnded}. */
export type TaskAgentsEndedReason = 'task-missing' | 'task-deleted' | 'task-archived' | 'task-done'

/**
 * Does this database PROVE the task's agents were ended — the task is gone, in the
 * Trash, archived, or in a terminal status (reaching one stops its agents:
 * `onReachedTerminal`)? `null` for a task whose agents may still run.
 *
 * For a computer session nothing in this hub run tracks (a previous run's): the
 * hub ends it on this evidence only, never because it does not know it.
 */
export async function whyTaskAgentsEnded(
  db: SlayzoneDb,
  taskId: string
): Promise<TaskAgentsEndedReason | null> {
  const task = await db.get<{
    project_id: string | null
    status: string | null
    deleted_at: string | null
    archived_at: string | null
  }>('SELECT project_id, status, deleted_at, archived_at FROM tasks WHERE id = ?', [taskId])
  if (!task) return 'task-missing'
  if (task.deleted_at) return 'task-deleted'
  if (task.archived_at) return 'task-archived'
  if (!task.status) return null
  const columns = task.project_id ? await getProjectColumns(db, task.project_id) : null
  return isTerminalStatus(task.status, columns) ? 'task-done' : null
}
