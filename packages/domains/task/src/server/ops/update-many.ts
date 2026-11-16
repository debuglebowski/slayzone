import type { SlayzoneDb } from '@slayzone/platform'
import type { Task, UpdateTaskInput } from '@slayzone/task-contracts'
import { taskEvents } from '../events.js'
import { parseTask, updateTask, validateTaskUpdate, type OpDeps } from './shared.js'
import { applyProjectChange, hasUpdateFields } from './move-to-project.js'

export interface UpdateManyTasksInput {
  ids: string[]
  updates: Omit<Partial<UpdateTaskInput>, 'id'>
}

export async function updateManyTasksOp(
  db: SlayzoneDb,
  data: UpdateManyTasksInput,
  deps: OpDeps
): Promise<Task[]> {
  const { ipcMain, onMutation } = deps
  const { ids, updates } = data
  if (ids.length === 0) return []

  // All-or-nothing: an update invalid for ANY task (e.g. a status one task's
  // project lacks) rejects the batch before a single row is written.
  for (const id of ids) await validateTaskUpdate(db, { ...updates, id } as UpdateTaskInput)

  // A project change is ONE move for every listed task (subtasks, tags, detach),
  // with its own transaction and events; the rest then applies in the new project.
  const { rest, moved } = await applyProjectChange(db, ids, updates, deps)
  if (moved && !hasUpdateFields(rest)) {
    const rows = await db.all<Record<string, unknown>>(
      `SELECT * FROM tasks WHERE id IN (${ids.map(() => '?').join(', ')})`,
      ids
    )
    return rows.flatMap((r) => {
      const t = parseTask(r)
      return t ? [t] : []
    })
  }

  // `updateTask` is a conditional read-modify-write with runtime side effects, so
  // each update runs as its own awaited call. Each records its own activity
  // events in the same transaction as its write (`task:update`).
  const results: Array<{ id: string; previous: Task | null; next: Task | null }> = []
  for (const id of ids) {
    const previousRow = await db.get<Record<string, unknown>>('SELECT * FROM tasks WHERE id = ?', [
      id
    ])
    const previousTask = parseTask(previousRow)
    const nextTask = await updateTask(db, { ...rest, id } as UpdateTaskInput)
    results.push({ id, previous: previousTask, next: nextTask })
  }

  for (const r of results) {
    if (!r.next) continue
    ipcMain?.emit('db:tasks:update:done', null, r.id, {
      oldStatus: r.previous?.status,
      previous: r.previous,
      next: r.next
    })
    const projectId = r.next.project_id ?? r.previous?.project_id
    if (projectId) {
      taskEvents.emit('task:updated', {
        taskId: r.id,
        projectId,
        oldStatus: r.previous?.status
      })
    }
  }
  if (results.some((r) => r.next)) onMutation?.()

  return results.flatMap((r) => (r.next ? [r.next] : []))
}
