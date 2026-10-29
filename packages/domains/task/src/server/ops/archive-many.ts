import type { SlayzoneDb } from '@slayzone/platform'
import { assertPathSafeId } from '@slayzone/platform/safe-path'
import { taskEvents } from '../events.js'
import { buildTaskArchivedEvents } from '../history.js'
import { cleanupTaskFull, parseTasks, type OpDeps } from './shared.js'
// Loads the TxnRegistry augmentation that types this file's `db.namedTxn` calls.
import type {} from '../task-txns.js'

export async function archiveManyTasksOp(
  db: SlayzoneDb,
  ids: string[],
  deps: OpDeps
): Promise<void> {
  const { ipcMain, onMutation } = deps
  if (ids.length === 0) return
  // Every id becomes an artifact dir name in cleanupTaskFull: refuse the whole batch
  // before the first cleanup, not halfway through it.
  for (const id of ids) assertPathSafeId(id, 'taskId')
  const placeholdersForExisting = ids.map(() => '?').join(',')
  const existingRows = await db.all<Record<string, unknown>>(
    `SELECT * FROM tasks WHERE id IN (${placeholdersForExisting}) OR parent_id IN (${placeholdersForExisting})`,
    [...ids, ...ids]
  )
  const existingTasks = parseTasks(existingRows)
  // Resolve sub-tasks first so cleanup can exclude in-batch siblings from the shared-worktree guard.
  const parentPlaceholders = ids.map(() => '?').join(',')
  const childIds = (
    await db.all<{ id: string }>(
      `SELECT id FROM tasks WHERE parent_id IN (${parentPlaceholders}) AND archived_at IS NULL`,
      ids
    )
  ).map((r) => r.id)
  const allIds = [...ids, ...childIds]
  for (const id of ids) {
    await cleanupTaskFull(db, id, allIds)
  }
  for (const childId of childIds) {
    await cleanupTaskFull(db, childId, allIds)
  }
  const placeholders = allIds.map(() => '?').join(',')
  await db.namedTxn('task:archive', {
    sql: `
      UPDATE tasks SET archived_at = datetime('now'), worktree_path = NULL, base_dir = NULL, updated_at = datetime('now')
      WHERE id IN (${placeholders})
    `,
    params: allIds,
    events: buildTaskArchivedEvents(existingTasks.filter((task) => allIds.includes(task.id)))
  })
  for (const id of allIds) {
    ipcMain?.emit('db:tasks:archive:done', null, id)
    const projectRow = await db.get<{ project_id: string }>(
      'SELECT project_id FROM tasks WHERE id = ?',
      [id]
    )
    if (projectRow) {
      taskEvents.emit('task:archived', { taskId: id, projectId: projectRow.project_id })
    }
  }
  onMutation?.()
}
