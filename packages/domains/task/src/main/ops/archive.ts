import type { Database } from 'better-sqlite3'
import type { Task } from '@slayzone/task/shared'
import { recordActivityEvents } from '@slayzone/history/main'
import { buildTaskArchivedEvents } from '../history.js'
import { cleanupTaskFull, parseTask, parseTasks, type OpDeps } from './shared.js'

export async function archiveTaskOp(db: Database, id: string, deps: OpDeps): Promise<Task | null> {
  const { ipcMain, onMutation } = deps
  const toArchiveRows = db.prepare('SELECT * FROM tasks WHERE id = ? OR parent_id = ?').all(id, id) as Record<string, unknown>[]
  const toArchiveTasks = parseTasks(toArchiveRows)
  await cleanupTaskFull(db, id)
  // Also archive sub-tasks
  const childIds = (db.prepare('SELECT id FROM tasks WHERE parent_id = ? AND archived_at IS NULL').all(id) as { id: string }[]).map(r => r.id)
  for (const childId of childIds) { await cleanupTaskFull(db, childId) }
  const archivedTask = db.transaction(() => {
    db.prepare(`
      UPDATE tasks SET archived_at = datetime('now'), worktree_path = NULL, base_dir = NULL, updated_at = datetime('now')
      WHERE id = ? OR parent_id = ?
    `).run(id, id)
    recordActivityEvents(db, buildTaskArchivedEvents(toArchiveTasks))
    const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Record<string, unknown> | undefined
    return parseTask(row)
  })()
  ipcMain.emit('db:tasks:archive:done', null, id)
  onMutation?.()
  return archivedTask
}
