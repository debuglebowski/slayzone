import type { SlayzoneDb } from '@slayzone/platform'
import type { Task } from '@slayzone/task/shared'
import { buildTaskRestoredEvents } from '../history.js'
import { taskEvents } from '../events.js'
import { colorOne, parseTask, type OpDeps } from './shared.js'

export async function restoreTaskOp(
  db: SlayzoneDb,
  id: string,
  deps: OpDeps
): Promise<Task | null> {
  const { ipcMain, onMutation } = deps
  // Read project_id up-front so the restore event can be built before the write —
  // lets the UPDATE + event recording commit atomically via the `task:update` named
  // transaction (the restored event only needs id + project_id).
  const before = await db.get<{ project_id: string }>('SELECT project_id FROM tasks WHERE id = ?', [
    id
  ])
  await db.namedTxn('task:update', {
    sql: `
      UPDATE tasks SET deleted_at = NULL, updated_at = datetime('now') WHERE id = ?
    `,
    params: [id],
    events: before
      ? buildTaskRestoredEvents({ id, project_id: before.project_id } as Task)
      : []
  })
  const row = await db.get<Record<string, unknown>>('SELECT * FROM tasks WHERE id = ?', [id])
  const task = parseTask(row)
  onMutation?.()
  if (task) {
    const projectId = task.project_id
    taskEvents.emit('task:restored', { taskId: id, projectId })
    ipcMain?.emit('db:tasks:restore:done', null, id, projectId)
  }
  return colorOne(db, task)
}
