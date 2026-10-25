import { useEffect } from 'react'
import { useQueryClient, type Query, type QueryClient } from '@tanstack/react-query'

/**
 * The per-task queries an open task tab reads, refreshed from ONE place.
 *
 * Every open tab used to hold its own `notify.onTasksChanged` subscription per
 * hook (tags, sub-tasks, artifacts), so one task write made ~5 refetches × every
 * open tab — 255 queries per event with 51 tabs, whether or not the write
 * touched those tasks, and whether or not the tab was on screen. Now the app's
 * single subscription (useTasksData) calls `refreshTaskScopedQueries`:
 *
 * - scoped to the tasks the event names (plus their parents, whose sub-task
 *   lists show them), or every task when the event's scope is unknown;
 * - a tab that is on screen refetches at once, exactly as before;
 * - a HIDDEN tab's queries are only marked stale, and refetch the moment the tab
 *   is revealed (`useTaskScopedQueriesFreshOnReveal`) — what the user sees is
 *   never older than before, hidden work is just not done until it is seen.
 *
 * Queries are matched by tRPC path + the input field naming the task, so this
 * works on any hub's QueryClient (keys carry no client identity).
 */
const TASK_SCOPED_INPUT: Record<string, string> = {
  'tags.getForTask': 'taskId',
  'task.getSubTasks': 'parentId',
  'artifacts.getByTask': 'taskId',
  'artifacts.foldersGetByTask': 'taskId'
}

/** The task a per-task query belongs to, or null for any other query. */
export function taskIdOfScopedQuery(queryKey: readonly unknown[]): string | null {
  const [path, meta] = queryKey
  if (!Array.isArray(path)) return null
  const field = TASK_SCOPED_INPUT[path.join('.')]
  if (!field) return null
  const input = (meta as { input?: unknown } | undefined)?.input
  if (typeof input !== 'object' || input === null) return null
  const id = (input as Record<string, unknown>)[field]
  return typeof id === 'string' && id ? id : null
}

/** Task ids whose tab is mounted but not on screen. */
const hiddenTaskIds = new Set<string>()
/** Hidden tabs whose queries went stale while hidden: refetch on reveal. */
const staleWhileHidden = new Set<string>()

/**
 * Refresh the per-task queries of `taskIds` (null = every task). Visible tasks
 * refetch now; hidden ones are marked stale and refetch on reveal.
 */
export function refreshTaskScopedQueries(
  queryClient: QueryClient,
  taskIds: readonly string[] | null
): Promise<void> {
  const wanted = taskIds ? new Set(taskIds) : null
  const matches = (q: Query): string | null => {
    const id = taskIdOfScopedQuery(q.queryKey)
    return id !== null && (wanted === null || wanted.has(id)) ? id : null
  }
  let anyHidden = false
  for (const q of queryClient.getQueryCache().getAll()) {
    const id = matches(q)
    if (id !== null && hiddenTaskIds.has(id)) {
      staleWhileHidden.add(id)
      anyHidden = true
    }
  }
  const hiddenDone = anyHidden
    ? queryClient.invalidateQueries({
        predicate: (q) => {
          const id = matches(q)
          return id !== null && hiddenTaskIds.has(id)
        },
        refetchType: 'none'
      })
    : Promise.resolve()
  const visibleDone = queryClient.invalidateQueries({
    predicate: (q) => {
      const id = matches(q)
      return id !== null && !hiddenTaskIds.has(id)
    }
  })
  return Promise.all([hiddenDone, visibleDone]).then(() => undefined)
}

/**
 * Register a task tab's visibility. While hidden, refreshes of its per-task
 * queries are deferred; on reveal, any that went stale refetch at once.
 */
export function useTaskScopedQueriesFreshOnReveal(
  taskId: string | null | undefined,
  isVisible: boolean
): void {
  const queryClient = useQueryClient()
  useEffect(() => {
    if (!taskId) return
    if (!isVisible) {
      hiddenTaskIds.add(taskId)
      return () => {
        hiddenTaskIds.delete(taskId)
      }
    }
    if (staleWhileHidden.delete(taskId)) {
      void queryClient.refetchQueries({
        predicate: (q) => taskIdOfScopedQuery(q.queryKey) === taskId,
        type: 'active'
      })
    }
    return undefined
  }, [taskId, isVisible, queryClient])
}

/** Test seam. */
export function __resetTaskScopedQueriesForTest(): void {
  hiddenTaskIds.clear()
  staleWhileHidden.clear()
}
