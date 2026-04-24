import type { Database } from 'better-sqlite3'
import type { Task } from '@slayzone/task/shared'
import { recordActivityEvents } from '@slayzone/history/main'
import { buildTaskUnarchivedEvents } from '../history.js'
import { parseTask, type OpDeps } from './shared.js'

export function unarchiveTaskOp(db: Database, id: string, deps: OpDeps): Task | null {
  const { ipcMain, onMutation } = deps
  const task = db.transaction(() => {
    db.prepare(`
      UPDATE tasks SET archived_at = NULL, updated_at = datetime('now')
      WHERE id = ?
    `).run(id)
    const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Record<string, unknown> | undefined
    const nextTask = parseTask(row)
    if (nextTask) {
      recordActivityEvents(db, buildTaskUnarchivedEvents(nextTask))
    }
    return nextTask
  })()
  ipcMain.emit('db:tasks:unarchive:done', null, id)
  onMutation?.()
  return task
}
