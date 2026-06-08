import type { SlayzoneDb } from '@slayzone/platform'
import { taskEvents } from '../events.js'
import { buildTaskDeletedEvents } from '../history.js'
import { cleanupTaskImmediate, parseTask, type OpDeps } from './shared.js'

export interface DeleteManyTasksResult {
  deletedIds: string[]
  blockedIds: string[]
}

export async function deleteManyTasksOp(
  db: SlayzoneDb,
  ids: string[],
  deps: OpDeps
): Promise<DeleteManyTasksResult> {
  const { ipcMain, onMutation } = deps
  if (ids.length === 0) return { deletedIds: [], blockedIds: [] }

  const blockedIds: string[] = []
  const deletable: { id: string; previous: ReturnType<typeof parseTask> }[] = []

  for (const id of ids) {
    const previousRow = await db.get<Record<string, unknown>>('SELECT * FROM tasks WHERE id = ?', [
      id
    ])
    const previousTask = parseTask(previousRow)
    const linkCount = (
      await db.get<{ count: number }>(
        'SELECT COUNT(*) as count FROM external_links WHERE task_id = ?',
        [id]
      )
    )?.count
    if ((linkCount ?? 0) > 0) {
      blockedIds.push(id)
      continue
    }
    deletable.push({ id, previous: previousTask })
  }

  for (const { id } of deletable) {
    cleanupTaskImmediate(id)
  }

  // Soft-delete every deletable task + record deletion events in one transaction.
  // The named txn records events only for rows whose UPDATE actually changed a row
  // and returns the ids that were deleted.
  const { deletedIds } = await db.namedTxn('task:soft-delete-many', {
    ops: deletable.map(({ id, previous }) => ({
      id,
      sql: `
        UPDATE tasks SET deleted_at = datetime('now'), updated_at = datetime('now') WHERE id = ?
      `,
      params: [id],
      events: previous ? buildTaskDeletedEvents(previous) : []
    }))
  })

  for (const { id, previous } of deletable) {
    if (!deletedIds.includes(id)) continue
    ipcMain?.emit('db:tasks:delete:done', null, id)
    if (previous) {
      taskEvents.emit('task:deleted', { taskId: id, projectId: previous.project_id })
    }
  }
  if (deletedIds.length > 0) onMutation?.()

  return { deletedIds, blockedIds }
}
