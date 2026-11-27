import { useQuery } from '@tanstack/react-query'
import { useFederationOrNull, useHubId } from '@slayzone/transport/client'
import type { Task } from '@slayzone/task-contracts'
import { useTRPC } from './trpc'

/**
 * Every task of the board query the app already holds (`task.loadBoardData`) — the one
 * way task UI reads the whole task list.
 *
 * The board is the app's biggest query (every task, MBs) and is patched on each
 * `tasks-changed` event, so a reader must cost O(1) per patch:
 * - A disabled reader (e.g. every inactive tab's palette commands) does not subscribe,
 *   so board patches never reach it. Disabled observers would otherwise still be
 *   notified and recompute their result on each patch.
 * - No `select`: a `select` result is structurally shared against the reader's own
 *   previous result, a deep compare of the whole board. Worse, that merge returns a
 *   fresh copy for every changed row, so the reader's rows permanently stop being the
 *   board's rows and every later patch deep-compares them all. The board is already
 *   structurally shared where it is stored, so `board.tasks` keeps unchanged rows'
 *   identity on its own.
 */
export function useBoardTasks({ enabled }: { enabled: boolean }): Task[] | undefined {
  const trpc = useTRPC()
  // The default hub's board is kept fresh by `tasks-changed` patches (`useTasksData`):
  // never stale, so a reader mounting (each task page, the active tab's palette) does
  // not reload every task. A remote hub's scope holds its own unpatched copy, which
  // refreshes as before.
  const hubId = useHubId()
  const defaultHubId = useFederationOrNull()?.defaultHubId
  const patched = hubId === null || hubId === defaultHubId
  const { data } = useQuery(
    trpc.task.loadBoardData.queryOptions(undefined, {
      enabled,
      subscribed: enabled,
      staleTime: patched ? Infinity : 30_000,
      refetchOnWindowFocus: !patched
    })
  )
  return data?.tasks
}
