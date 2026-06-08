import type { SlayzoneDb } from '@slayzone/platform'
import type { Task } from '@slayzone/task/shared'
import { buildTaskUnarchivedEvents } from '../history.js'
import { taskEvents } from '../events.js'
import { parseTask, type OpDeps } from './shared.js'

export async function unarchiveTaskOp(
  db: SlayzoneDb,
  id: string,
  deps: OpDeps
): Promise<Task | null> {
  const { ipcMain, onMutation } = deps
  // Read project_id up-front so the unarchive event can be built before the write —
  // lets the UPDATE + event recording commit atomically via the `task:update` named
  // transaction (the unarchived event only needs id + project_id).
  const before = await db.get<{ project_id: string }>('SELECT project_id FROM tasks WHERE id = ?', [
    id
  ])
  await db.namedTxn('task:update', {
    sql: `
      UPDATE tasks SET archived_at = NULL, updated_at = datetime('now')
      WHERE id = ?
    `,
    params: [id],
    events: before
      ? buildTaskUnarchivedEvents({ id, project_id: before.project_id } as Task)
      : []
  })
  const row = await db.get<Record<string, unknown>>('SELECT * FROM tasks WHERE id = ?', [id])
  const task = parseTask(row)
  if (task) {
    taskEvents.emit('task:unarchived', { taskId: id, projectId: task.project_id })
  }
  ipcMain?.emit('db:tasks:unarchive:done', null, id)
  onMutation?.()
  return task
}
