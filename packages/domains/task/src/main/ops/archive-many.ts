import type { Database } from 'better-sqlite3'
import { recordActivityEvents } from '@slayzone/history/main'
import { taskEvents } from '../events.js'
import { buildTaskArchivedEvents } from '../history.js'
import { cleanupTaskFull, parseTasks, type OpDeps } from './shared.js'

export async function archiveManyTasksOp(db: Database, ids: string[], deps: OpDeps): Promise<void> {
  const { ipcMain, onMutation } = deps
  if (ids.length === 0) return
  const placeholdersForExisting = ids.map(() => '?').join(',')
  const existingRows = db.prepare(`SELECT * FROM tasks WHERE id IN (${placeholdersForExisting}) OR parent_id IN (${placeholdersForExisting})`).all(...ids, ...ids) as Record<string, unknown>[]
  const existingTasks = parseTasks(existingRows)
  // Resolve sub-tasks first so cleanup can exclude in-batch siblings from the shared-worktree guard.
  const parentPlaceholders = ids.map(() => '?').join(',')
  const childIds = (db.prepare(`SELECT id FROM tasks WHERE parent_id IN (${parentPlaceholders}) AND archived_at IS NULL`).all(...ids) as { id: string }[]).map(r => r.id)
  const allIds = [...ids, ...childIds]
  for (const id of ids) {
    await cleanupTaskFull(db, id, allIds)
  }
  for (const childId of childIds) { await cleanupTaskFull(db, childId, allIds) }
  const placeholders = allIds.map(() => '?').join(',')
  db.transaction(() => {
    db.prepare(`
      UPDATE tasks SET archived_at = datetime('now'), worktree_path = NULL, base_dir = NULL, updated_at = datetime('now')
      WHERE id IN (${placeholders})
    `).run(...allIds)
    recordActivityEvents(db, buildTaskArchivedEvents(existingTasks.filter((task) => allIds.includes(task.id))))
  })()
  for (const id of allIds) {
    ipcMain.emit('db:tasks:archive:done', null, id)
    const projectRow = db.prepare('SELECT project_id FROM tasks WHERE id = ?').get(id) as { project_id: string } | undefined
    if (projectRow) {
      taskEvents.emit('task:archived', { taskId: id, projectId: projectRow.project_id })
    }
  }
  onMutation?.()
}
