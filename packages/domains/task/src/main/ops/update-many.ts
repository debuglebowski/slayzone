import type { SlayzoneDb } from '@slayzone/platform'
import type { Task, UpdateTaskInput } from '@slayzone/task/shared'
import type { RecordActivityEventInput } from '@slayzone/history/main'
import { buildTaskUpdatedEvents } from '../history.js'
import { taskEvents } from '../events.js'
import { colorOne, parseTask, updateTask, type OpDeps } from './shared.js'

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

  // `updateTask` is a conditional read-modify-write with runtime side effects, so
  // each update runs as its own awaited call rather than inside a worker named-txn.
  // The diff-derived activity events are accumulated and recorded together via the
  // `task:record-events` named transaction.
  const results: Array<{ id: string; previous: Task | null; next: Task | null }> = []
  const events: RecordActivityEventInput[] = []
  for (const id of ids) {
    const previousRow = await db.get<Record<string, unknown>>('SELECT * FROM tasks WHERE id = ?', [
      id
    ])
    const previousTask = parseTask(previousRow)
    const nextTask = await updateTask(db, { ...updates, id } as UpdateTaskInput)
    if (previousTask && nextTask) {
      events.push(...buildTaskUpdatedEvents(previousTask, nextTask))
    }
    results.push({ id, previous: previousTask, next: nextTask })
  }

  if (events.length > 0) {
    await db.namedTxn('task:record-events', { events })
  }

  for (const r of results) {
    if (!r.next) continue
    ipcMain?.emit('db:tasks:update:done', null, r.id, { oldStatus: r.previous?.status })
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

  const colored: Task[] = []
  for (const r of results) {
    const c = await colorOne(db, r.next)
    if (c) colored.push(c)
  }
  return colored
}
