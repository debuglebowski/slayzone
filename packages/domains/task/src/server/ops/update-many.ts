import type { Database } from 'better-sqlite3'
import type { Task, UpdateTaskInput } from '@slayzone/task/shared'
import { recordActivityEvents } from '@slayzone/history/server'
import { buildTaskUpdatedEvents } from '../history.js'
import { taskEvents } from '../events.js'
import { colorOne, parseTask, updateTask, type OpDeps } from './shared.js'

export interface UpdateManyTasksInput {
  ids: string[]
  updates: Omit<Partial<UpdateTaskInput>, 'id'>
}

export async function updateManyTasksOp(
  db: Database,
  data: UpdateManyTasksInput,
  deps: OpDeps,
): Promise<Task[]> {
  const { ipcMain, onMutation } = deps
  const { ids, updates } = data
  if (ids.length === 0) return []

  const results: Array<{ id: string; previous: Task | null; next: Task | null }> = db.transaction(() => {
    const out: Array<{ id: string; previous: Task | null; next: Task | null }> = []
    for (const id of ids) {
      const previousRow = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Record<string, unknown> | undefined
      const previousTask = parseTask(previousRow)
      const nextTask = updateTask(db, { ...updates, id } as UpdateTaskInput)
      if (previousTask && nextTask) {
        recordActivityEvents(db, buildTaskUpdatedEvents(previousTask, nextTask))
      }
      out.push({ id, previous: previousTask, next: nextTask })
    }
    return out
  })()

  for (const r of results) {
    if (!r.next) continue
    ipcMain.emit('db:tasks:update:done', null, r.id, { oldStatus: r.previous?.status })
    const projectId = r.next.project_id ?? r.previous?.project_id
    if (projectId) {
      taskEvents.emit('task:updated', {
        taskId: r.id,
        projectId,
        oldStatus: r.previous?.status,
      })
    }
  }
  if (results.some(r => r.next)) onMutation?.()

  const colored: Task[] = []
  for (const r of results) {
    const c = await colorOne(db, r.next)
    if (c) colored.push(c)
  }
  return colored
}
