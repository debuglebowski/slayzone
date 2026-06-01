import type { SlayzoneDb } from '@slayzone/platform'
import { taskEvents } from '../events.js'
import { buildTaskDeletedEvents } from '../history.js'
import { cleanupTaskImmediate, parseTask, type OpDeps } from './shared.js'

export type DeleteTaskResult = boolean | { blocked: true; reason: 'linked_to_provider' }

export async function deleteTaskOp(
  db: SlayzoneDb,
  id: string,
  deps: OpDeps
): Promise<DeleteTaskResult> {
  const { ipcMain, onMutation } = deps
  const previousRow = await db.get<Record<string, unknown>>('SELECT * FROM tasks WHERE id = ?', [id])
  const previousTask = parseTask(previousRow)
  const linkCount = (
    await db.get<{ count: number }>(
      'SELECT COUNT(*) as count FROM external_links WHERE task_id = ?',
      [id]
    )
  )?.count
  if ((linkCount ?? 0) > 0) {
    return { blocked: true, reason: 'linked_to_provider' }
  }

  cleanupTaskImmediate(id)
  // Soft-delete + delete-event recording must commit atomically; the event list is
  // known up-front (built from the pre-read task), and the event write is gated on
  // the UPDATE actually changing a row — a conditional that lives in the named txn.
  const result = await db.namedTxn<{ changes: number }>('task:soft-delete', {
    sql: `
      UPDATE tasks SET deleted_at = datetime('now'), updated_at = datetime('now') WHERE id = ?
    `,
    params: [id],
    events: previousTask ? buildTaskDeletedEvents(previousTask) : []
  })
  if (result.changes > 0) {
    ipcMain.emit('db:tasks:delete:done', null, id)
    if (previousTask) {
      taskEvents.emit('task:deleted', { taskId: id, projectId: previousTask.project_id })
    }
    onMutation?.()
  }
  return result.changes > 0
}
