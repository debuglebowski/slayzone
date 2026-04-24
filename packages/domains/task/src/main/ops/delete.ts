import type { Database } from 'better-sqlite3'
import { recordActivityEvents } from '@slayzone/history/main'
import { buildTaskDeletedEvents } from '../history.js'
import { cleanupTaskImmediate, parseTask, type OpDeps } from './shared.js'

export type DeleteTaskResult = boolean | { blocked: true; reason: 'linked_to_provider' }

export function deleteTaskOp(db: Database, id: string, deps: OpDeps): DeleteTaskResult {
  const { onMutation } = deps
  const previousRow = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Record<string, unknown> | undefined
  const previousTask = parseTask(previousRow)
  const linkCount = (db.prepare(
    'SELECT COUNT(*) as count FROM external_links WHERE task_id = ?'
  ).get(id) as { count: number }).count
  if (linkCount > 0) {
    return { blocked: true, reason: 'linked_to_provider' }
  }

  cleanupTaskImmediate(id)
  const result = db.transaction(() => {
    const updateResult = db.prepare(`
      UPDATE tasks SET deleted_at = datetime('now'), updated_at = datetime('now') WHERE id = ?
    `).run(id)
    if (updateResult.changes > 0 && previousTask) {
      recordActivityEvents(db, buildTaskDeletedEvents(previousTask))
    }
    return updateResult
  })()
  if (result.changes > 0) {
    onMutation?.()
  }
  return result.changes > 0
}
