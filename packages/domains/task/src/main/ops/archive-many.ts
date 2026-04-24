import type { Database } from 'better-sqlite3'
import { recordActivityEvents } from '@slayzone/history/main'
import { buildTaskArchivedEvents } from '../history.js'
import { cleanupTaskFull, parseTasks, type OpDeps } from './shared.js'

export async function archiveManyTasksOp(db: Database, ids: string[], deps: OpDeps): Promise<void> {
  const { ipcMain, onMutation } = deps
  if (ids.length === 0) return
  const placeholdersForExisting = ids.map(() => '?').join(',')
  const existingRows = db.prepare(`SELECT * FROM tasks WHERE id IN (${placeholdersForExisting}) OR parent_id IN (${placeholdersForExisting})`).all(...ids, ...ids) as Record<string, unknown>[]
  const existingTasks = parseTasks(existingRows)
  for (const id of ids) {
    await cleanupTaskFull(db, id)
  }
  // Also archive sub-tasks of all given parents
  const parentPlaceholders = ids.map(() => '?').join(',')
  const childIds = (db.prepare(`SELECT id FROM tasks WHERE parent_id IN (${parentPlaceholders}) AND archived_at IS NULL`).all(...ids) as { id: string }[]).map(r => r.id)
  for (const childId of childIds) { await cleanupTaskFull(db, childId) }
  const allIds = [...ids, ...childIds]
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
  }
  onMutation?.()
}
