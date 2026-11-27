import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { Task } from '@slayzone/task-contracts'
import { useTRPC } from './trpc'

/**
 * A task's live row as its page reads it: the board row the app holds (patched on
 * every `tasks-changed`, and where optimistic edits land) for every field it
 * carries, and the task's own full row (`task.get`) for the rest.
 *
 * The board may carry only what a card shows (descriptions, provider config and
 * panel state are the page's alone): the full row supplies those. A board row
 * that carries every field is returned as it is — no copy, so memoized readers
 * keep its identity.
 */
export function mergeTaskRows(
  board: Task | null | undefined,
  full: Task | null | undefined
): Task | null {
  if (!board) return full ?? null
  if (!full) return board
  for (const key in full) {
    if (!(key in board)) return { ...full, ...board }
  }
  return board
}

/**
 * The task's full row (`task.get`) on the enclosing hub: seeded from what the page
 * loaded with (`initial`), never refetched on focus or mount, refreshed by the one
 * `tasks-changed` refresh (`refreshTaskScopedQueries` lists `task.get`).
 */
export function useTaskFullRow(taskId: string, initial: Task | null | undefined): Task | undefined {
  const trpc = useTRPC()
  const { data } = useQuery(
    trpc.task.get.queryOptions(
      { id: taskId },
      {
        initialData: initial ?? undefined,
        staleTime: Infinity,
        refetchOnWindowFocus: false
      }
    )
  )
  return useMemo(() => (data ?? undefined) as Task | undefined, [data])
}
