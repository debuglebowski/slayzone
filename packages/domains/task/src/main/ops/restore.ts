import type { Database } from 'better-sqlite3'
import type { Task } from '@slayzone/task/shared'
import { recordActivityEvents } from '@slayzone/history/main'
import { buildTaskRestoredEvents } from '../history.js'
import { colorOne, parseTask, type OpDeps } from './shared.js'

export async function restoreTaskOp(db: Database, id: string, deps: OpDeps): Promise<Task | null> {
  const { onMutation } = deps
  const task = db.transaction(() => {
    db.prepare(`
      UPDATE tasks SET deleted_at = NULL, updated_at = datetime('now') WHERE id = ?
    `).run(id)
    const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Record<string, unknown> | undefined
    const nextTask = parseTask(row)
    if (nextTask) {
      recordActivityEvents(db, buildTaskRestoredEvents(nextTask))
    }
    return nextTask
  })()
  onMutation?.()
  return colorOne(db, task)
}
