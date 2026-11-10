/**
 * A task's worktree path and custom working folder, read from the computer holding
 * them (robustness plan §9, P0; Phase 7d). The hub keeps no copy: `task.paths` relays
 * one read, batched across every task rendered in the same tick (a board or the
 * sidebar asks once, not once per row). With that computer away the answer is
 * `offline` and the UI says the task is "on <computer>" — never a stale path.
 *
 * Never throws during render: a task without a folder of its own answers at once
 * without asking; a read that fails is shown as offline; no task is `loading`'s
 * stand-in. Lookups in event handlers use {@link peekTaskPath} (the cached answer).
 *
 * @module task/client/useTaskPath
 */
import { useMemo } from 'react'
import { useQueries, useQuery, type QueryClient } from '@tanstack/react-query'
import type { Task, TaskPathState } from '@slayzone/task-contracts'
import { TASK_PATHS_MAX } from '@slayzone/task-contracts'
import { getClientForHub, getHubIdForTask } from '@slayzone/transport/client'
import { useClientForTask, useTRPC } from './trpc'
import { hasOwnFolder } from '../shared/main-terminal'

/** A task's paths as rendered: the computer's answer, or still asking. */
export type TaskPathView = TaskPathState | { state: 'loading' }

/** The fields of a task the read depends on (its version re-reads after a change). */
export type TaskPathSubject = Pick<
  Task,
  'id' | 'has_worktree' | 'has_base_dir' | 'updated_at' | 'computer_id'
> & { worktree_computer_id?: string | null }

const NONE: TaskPathState = { state: 'ok', worktreePath: null, baseDir: null }
const LOADING: TaskPathView = { state: 'loading' }

interface PathsClient {
  task: { paths: { query(input: { taskIds: string[] }): Promise<Record<string, TaskPathState>> } }
}

/** One pending batch per hub client: every id asked in the same tick, one request. */
const loaders = new WeakMap<object, (taskId: string) => Promise<TaskPathState>>()
function loaderFor(client: PathsClient): (taskId: string) => Promise<TaskPathState> {
  const known = loaders.get(client)
  if (known) return known
  let pending: Map<string, Array<(state: TaskPathState) => void>> | null = null
  const flush = async (batch: Map<string, Array<(state: TaskPathState) => void>>) => {
    const ids = [...batch.keys()]
    for (let i = 0; i < ids.length; i += TASK_PATHS_MAX) {
      const slice = ids.slice(i, i + TASK_PATHS_MAX)
      const answer = await client.task.paths
        .query({ taskIds: slice })
        .catch((): Record<string, TaskPathState> => ({}))
      for (const id of slice) {
        // Not answered (the read failed): offline, never a guess.
        const state = answer[id] ?? { state: 'offline' as const, computerId: null }
        for (const resolve of batch.get(id) ?? []) resolve(state)
      }
    }
  }
  const load = (taskId: string) =>
    new Promise<TaskPathState>((resolve) => {
      if (!pending) {
        const batch = new Map<string, Array<(state: TaskPathState) => void>>()
        pending = batch
        queueMicrotask(() => {
          pending = null
          void flush(batch)
        })
      }
      const waiting = pending.get(taskId) ?? []
      waiting.push(resolve)
      pending.set(taskId, waiting)
    })
  loaders.set(client, load)
  return load
}

/**
 * The root of every task-path query key. A computer connecting invalidates it (the
 * app shell's computer-connect refetch): an `offline` answer read before the local
 * computer enrolled — `retry: false`, and the connect does not change the key —
 * would otherwise stick until the row's version changed.
 */
export const TASK_PATHS_QUERY_ROOT = ['task-paths'] as const

/** The react-query key of one task's paths at one version of its row. */
export function taskPathQueryKey(task: TaskPathSubject): readonly unknown[] {
  return [...TASK_PATHS_QUERY_ROOT, task.id, task.updated_at, task.has_worktree, task.has_base_dir]
}

/**
 * The task's paths. `null` task (not loaded yet) → loading. Offline answers carry the
 * computer that holds them (else the one that made the worktree / the task's own).
 */
export function useTaskPath(task: TaskPathSubject | null | undefined): TaskPathView {
  const client = useClientForTask(task?.id ?? null) as unknown as PathsClient
  const own = hasOwnFolder(task)
  const query = useQuery({
    queryKey: task ? taskPathQueryKey(task) : [...TASK_PATHS_QUERY_ROOT, null],
    queryFn: () => loaderFor(client)(task!.id),
    enabled: !!task && own,
    // A path changes through the task's row (its version is in the key); the row's
    // clock is per second, so an answer also ages out and is re-read on next mount.
    staleTime: 15_000,
    retry: false
  })
  if (!task) return LOADING
  if (!own) return NONE
  if (!query.data) return LOADING
  if (query.data.state === 'offline' && query.data.computerId === null)
    return {
      state: 'offline',
      computerId: task.worktree_computer_id ?? task.computer_id ?? null
    }
  return query.data
}

/**
 * Many tasks' paths at once (a project's task list, the sidebar): one batched read.
 * The map holds the WORKTREE path of each task whose computer answered; a task still
 * loading or away is absent (callers treat it as unknown, never as "no worktree").
 */
export function useTaskWorktreePaths(
  tasks: readonly TaskPathSubject[]
): ReadonlyMap<string, string> {
  // Each task is read through the hub that owns it (the sidebar spans hubs).
  const ambient = useClientForTask(null)
  const withWorktree = tasks.filter((t) => t.has_worktree)
  const results = useQueries({
    queries: withWorktree.map((task) => ({
      queryKey: taskPathQueryKey(task),
      queryFn: () =>
        loaderFor(
          getClientForHub(getHubIdForTask(task.id), ambient as never) as unknown as PathsClient
        )(task.id),
      staleTime: 15_000,
      retry: false
    }))
  })
  const entries: Array<[string, string]> = []
  withWorktree.forEach((task, i) => {
    const data = results[i]?.data
    if (data?.state === 'ok' && data.worktreePath) entries.push([task.id, data.worktreePath])
  })
  // Same answers → the same Map (consumers memoize on it).
  const signature = JSON.stringify(entries)
  return useMemo(() => new Map<string, string>(JSON.parse(signature)), [signature])
}

/** The answer already cached for `task` (event handlers, store callbacks); null = not read. */
export function peekTaskPath(
  queryClient: QueryClient,
  task: TaskPathSubject | null | undefined
): TaskPathState | null {
  if (!task) return null
  if (!hasOwnFolder(task)) return NONE
  return queryClient.getQueryData<TaskPathState>(taskPathQueryKey(task)) ?? null
}

/**
 * "on <computer>": where an offline task's folder is. The computer's name when this
 * hub lists it, else a neutral "another computer" (never throws, never blocks).
 */
export function useTaskPathLocation(view: TaskPathView): string | null {
  const trpc = useTRPC()
  const computerId = view.state === 'offline' ? view.computerId : null
  const computers = useQuery({
    ...trpc.computers.list.queryOptions(),
    enabled: computerId !== null
  })
  if (view.state !== 'offline') return null
  const name = computers.data?.find((c) => c.id === computerId)?.name
  return `on ${name ?? 'another computer'}`
}
