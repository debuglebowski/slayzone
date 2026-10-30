/**
 * Writing a task's own fields to the hub that owns it (`task.update` and friends), shown
 * at once: a changed field shows its new value until the hub's board reload carries a
 * value of its own, and goes back to the hub's value — with why — when the hub refuses
 * (desktop's optimistic writes do the same). Must render inside the task's hub scope.
 */
import type { UpdateTaskInput } from '@slayzone/task-contracts'
import { useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import type { BoardTask } from '../hub-board'
import { useTRPC, useTRPCClient } from '../trpc'

/** The fields a write shows before the hub confirms it. */
export type ShownFields = Partial<
  Pick<
    BoardTask,
    'title' | 'status' | 'priority' | 'due_date' | 'is_blocked' | 'blocked_comment' | 'archived_at'
  >
>
type FieldKey = keyof ShownFields

/** One field written, not yet confirmed: `value` shows while the hub still holds `base`. */
interface Pending {
  value: unknown
  base: unknown
}

export interface TaskWrites {
  /** The task as shown: the hub's row with the writes in flight applied. */
  task: BoardTask
  /** Why the last write failed; null = it didn't. */
  error: string | null
  setError: (error: string | null) => void
  /** Shows `shown` at once and sends `input`; resolves once the hub has answered. */
  update: (shown: ShownFields, input: Omit<UpdateTaskInput, 'id'>) => Promise<boolean>
  /** Any other write of this task (archive, delete, tags…): its failure becomes `error`. */
  run: <T>(write: () => Promise<T>) => Promise<T | undefined>
  /** Loads the hub's board again (what every task screen shows). */
  refresh: () => void
}

export const messageOf = (err: unknown): string =>
  err instanceof Error ? err.message : String(err)

export function useTaskWrites(hubTask: BoardTask): TaskWrites {
  const trpc = useTRPC()
  const client = useTRPCClient()
  const queryClient = useQueryClient()
  const [pending, setPending] = useState<{
    taskId: string
    fields: Partial<Record<FieldKey, Pending>>
  }>({ taskId: hubTask.id, fields: {} })
  const [error, setError] = useState<string | null>(null)

  // A pending value stops showing once the hub holds something other than its base (its
  // board reload confirmed it, or someone changed it since): dropped here, during render.
  const live = pending.taskId === hubTask.id ? pending.fields : {}
  const superseded = (Object.keys(live) as FieldKey[]).filter((k) => live[k]?.base !== hubTask[k])
  if (pending.taskId !== hubTask.id || superseded.length > 0) {
    const kept = { ...live }
    for (const k of superseded) delete kept[k]
    setPending({ taskId: hubTask.id, fields: kept })
  }
  const task = { ...hubTask }
  for (const k of Object.keys(live) as FieldKey[]) {
    const p = live[k]
    if (p && p.base === hubTask[k]) Object.assign(task, { [k]: p.value })
  }

  const refresh = () => void queryClient.invalidateQueries(trpc.task.loadBoardData.queryFilter())

  const drop = (taskId: string, keys: FieldKey[], values: ShownFields) =>
    setPending((prev) => {
      if (prev.taskId !== taskId) return prev
      const fields = { ...prev.fields }
      for (const k of keys) if (fields[k]?.value === values[k]) delete fields[k]
      return { taskId, fields }
    })

  const update: TaskWrites['update'] = (shown, input) => {
    const taskId = hubTask.id
    const keys = Object.keys(shown) as FieldKey[]
    setError(null)
    setPending((prev) => {
      const fields = prev.taskId === taskId ? { ...prev.fields } : {}
      for (const k of keys) fields[k] = { value: shown[k], base: hubTask[k] }
      return { taskId, fields }
    })
    return client.task.update
      .mutate({ id: taskId, ...input })
      .then(() => {
        refresh()
        return true
      })
      .catch((err: unknown) => {
        // Not saved: the hub still holds the old values, show them again.
        drop(taskId, keys, shown)
        setError(`Couldn't save: ${messageOf(err)}`)
        return false
      })
  }

  const run: TaskWrites['run'] = (write) => {
    setError(null)
    return write()
      .then((result) => {
        refresh()
        return result
      })
      .catch((err: unknown) => {
        setError(`Couldn't save: ${messageOf(err)}`)
        return undefined
      })
  }

  return { task, error, setError, update, run, refresh }
}
