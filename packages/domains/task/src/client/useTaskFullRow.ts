import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { TASK_CARD_OMITTED_FIELDS, type Task } from '@slayzone/task-contracts'
import { useTRPC } from './trpc'

/**
 * A task's live row as its page reads it: the board row the app holds (patched on
 * every `tasks-changed`, and where optimistic edits land) for every card field, and
 * the task's own full row (`task.get`) for the page-only fields
 * (`TASK_CARD_OMITTED_FIELDS`).
 *
 * The full row is the authority for those even when the board row carries them: a
 * board of card rows never refreshes them, so a copy that reached the board (an
 * optimistic upsert of a full row) goes stale, while the full row is refreshed by
 * every event naming the task and by every write the page makes.
 */
export function mergeTaskRows(
  board: Task | null | undefined,
  full: Task | null | undefined
): Task | null {
  if (!board) return full ?? null
  if (!full) return board
  const out = { ...full, ...board } as Record<string, unknown>
  const fresh = full as unknown as Record<string, unknown>
  for (const key of TASK_CARD_OMITTED_FIELDS) if (key in full) out[key] = fresh[key]
  return out as unknown as Task
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
