import type { SlayzoneDb } from '@slayzone/platform'
import type { Task } from '@slayzone/task-contracts'
import { taskEvents } from '../events.js'
import { buildTaskArchivedEvents } from '../history.js'
import { cleanupTaskFull, notifyTaskPaths, parseTask, parseTasks, type OpDeps } from './shared.js'
// Loads the TxnRegistry augmentation that types this file's `db.namedTxn` calls.
import type {} from '../task-txns.js'

export async function archiveTaskOp(
  db: SlayzoneDb,
  id: string,
  deps: OpDeps
): Promise<Task | null> {
  const { ipcMain, onMutation } = deps
  const projectRow = await db.get<{ project_id: string }>(
    'SELECT project_id FROM tasks WHERE id = ?',
    [id]
  )
  const toArchiveRows = await db.all<Record<string, unknown>>(
    'SELECT * FROM tasks WHERE id = ? OR parent_id = ?',
    [id, id]
  )
  const toArchiveTasks = parseTasks(toArchiveRows)
  const childIds = (
    await db.all<{ id: string }>(
      'SELECT id FROM tasks WHERE parent_id = ? AND archived_at IS NULL',
      [id]
    )
  ).map((r) => r.id)
  const batch = [id, ...childIds]
  await cleanupTaskFull(db, id, batch, { preserveArtifacts: true })
  for (const childId of childIds) {
    await cleanupTaskFull(db, childId, batch, { preserveArtifacts: true })
  }
  await db.namedTxn('task:archive', {
    sql: `
      UPDATE tasks SET archived_at = datetime('now'), has_worktree = 0, has_base_dir = 0, updated_at = datetime('now')
      WHERE id = ? OR parent_id = ?
    `,
    params: [id, id],
    events: buildTaskArchivedEvents(toArchiveTasks)
  })
  // Archived: no checkout any more, on the computer either (robustness plan §9, P0).
  // `worktree_computer_id` stays so the clear reaches the computer holding the
  // folders; without a folder it no longer decides where work runs.
  for (const taskId of batch) await notifyTaskPaths(taskId, { op: 'clear' })
  const row = await db.get<Record<string, unknown>>('SELECT * FROM tasks WHERE id = ?', [id])
  const archivedTask = parseTask(row)
  ipcMain?.emit('db:tasks:archive:done', null, id)
  if (projectRow) {
    taskEvents.emit('task:archived', { taskId: id, projectId: projectRow.project_id })
  }
  onMutation?.()
  return archivedTask
}
