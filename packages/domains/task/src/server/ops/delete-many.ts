import type { Database } from 'better-sqlite3'
import { recordActivityEvents } from '@slayzone/history/server'
import { taskEvents } from '../events.js'
import { buildTaskDeletedEvents } from '../history.js'
import { cleanupTaskImmediate, parseTask, type OpDeps } from './shared.js'

export interface DeleteManyTasksResult {
  deletedIds: string[]
  blockedIds: string[]
}

export function deleteManyTasksOp(db: Database, ids: string[], deps: OpDeps): DeleteManyTasksResult {
  const { ipcMain, onMutation } = deps
  if (ids.length === 0) return { deletedIds: [], blockedIds: [] }

  const blockedIds: string[] = []
  const deletable: { id: string; previous: ReturnType<typeof parseTask> }[] = []

  for (const id of ids) {
    const previousRow = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Record<string, unknown> | undefined
    const previousTask = parseTask(previousRow)
    const linkCount = (db.prepare('SELECT COUNT(*) as count FROM external_links WHERE task_id = ?').get(id) as { count: number }).count
    if (linkCount > 0) {
      blockedIds.push(id)
      continue
    }
    deletable.push({ id, previous: previousTask })
  }

  for (const { id } of deletable) {
    cleanupTaskImmediate(id)
  }

  const deletedIds: string[] = []
  db.transaction(() => {
    for (const { id, previous } of deletable) {
      const updateResult = db.prepare(`
        UPDATE tasks SET deleted_at = datetime('now'), updated_at = datetime('now') WHERE id = ?
      `).run(id)
      if (updateResult.changes > 0) {
        if (previous) recordActivityEvents(db, buildTaskDeletedEvents(previous))
        deletedIds.push(id)
      }
    }
  })()

  for (const { id, previous } of deletable) {
    if (!deletedIds.includes(id)) continue
    ipcMain.emit('db:tasks:delete:done', null, id)
    if (previous) {
      taskEvents.emit('task:deleted', { taskId: id, projectId: previous.project_id })
    }
  }
  if (deletedIds.length > 0) onMutation?.()

  return { deletedIds, blockedIds }
}
