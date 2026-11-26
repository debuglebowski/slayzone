/**
 * The heavy state of a task's NON-primary panel instances (editor open files, git
 * tab and repo, artifacts selection…), in `tasks.panel_instance_state` keyed by
 * instance id (docs/plans/panel-model.md §1.2). A primary instance keeps its state
 * where it always lived (`editor_open_files`, `git_active_tab`, …).
 *
 * Panels read their entry when they mount; changes write the whole map, debounced,
 * bound to the task they were made in (a task switch or unmount sends a pending
 * write to its own task right away). A hub without the column
 * (`task.panel_instance_state === undefined`) keeps the state for this session only.
 */
import { useEffect, useEffectEvent, useRef, useState } from 'react'
import type { PanelInstanceState, Task, UpdateTaskInput } from '@slayzone/task-contracts'
import { patchInstanceState, withoutInstanceState } from '@slayzone/task-contracts'
import { useStableCallback } from '@slayzone/ui'

export const INSTANCE_STATE_SAVE_DEBOUNCE_MS = 500

export interface PanelInstanceStateApi {
  /** An instance's state (empty when it has none). */
  get: (instanceId: string) => Record<string, unknown>
  /** Merge into an instance's state (undefined deletes a key) and persist. */
  patch: (instanceId: string, patch: Record<string, unknown>) => void
  /** Drop a closed instance's state and persist. */
  drop: (instanceId: string) => void
}

const EMPTY: Record<string, unknown> = {}

export function usePanelInstanceState(
  task: Task | null,
  updateTask: (input: UpdateTaskInput) => Promise<unknown>
): PanelInstanceStateApi {
  const taskId = task?.id ?? null
  const seed = task?.panel_instance_state ?? {}
  const [state, setState] = useState<PanelInstanceState>(seed)
  // Mirrors `state` for handlers (several patches in one tick must all land).
  const stateRef = useRef<PanelInstanceState>(seed)
  const supported = task?.panel_instance_state !== undefined

  const pendingRef = useRef<{
    taskId: string
    value: PanelInstanceState
    timer: ReturnType<typeof setTimeout>
  } | null>(null)

  const flush = useStableCallback(() => {
    const pending = pendingRef.current
    if (!pending) return
    pendingRef.current = null
    clearTimeout(pending.timer)
    updateTask({ id: pending.taskId, panelInstanceState: pending.value }).catch((error: unknown) =>
      console.warn('[task] saving panel instance state failed:', error)
    )
  })

  const write = useStableCallback((next: PanelInstanceState) => {
    stateRef.current = next
    setState(next)
    if (!taskId || !supported) return
    if (pendingRef.current) clearTimeout(pendingRef.current.timer)
    pendingRef.current = {
      taskId,
      value: next,
      timer: setTimeout(flush, INSTANCE_STATE_SAVE_DEBOUNCE_MS)
    }
  })

  // Another task (the page swapped tasks): send what is pending to its own task,
  // then start from the new task's stored state. Adjusted while rendering.
  const [seenTaskId, setSeenTaskId] = useState(taskId)
  if (taskId !== seenTaskId) {
    setSeenTaskId(taskId)
    setState(seed)
  }
  // An Effect Event: seeds once per task — later echoes of our own writes must not reset it.
  const reseed = useEffectEvent(() => {
    stateRef.current = task?.panel_instance_state ?? {}
  })
  useEffect(() => {
    reseed()
    return flush
  }, [taskId, flush])

  const get = (instanceId: string): Record<string, unknown> => state[instanceId] ?? EMPTY
  const patch = useStableCallback((instanceId: string, p: Record<string, unknown>) =>
    write(patchInstanceState(stateRef.current, instanceId, p))
  )
  const drop = useStableCallback((instanceId: string) => {
    if (!(instanceId in stateRef.current)) return
    write(withoutInstanceState(stateRef.current, instanceId))
  })

  return { get, patch, drop }
}
