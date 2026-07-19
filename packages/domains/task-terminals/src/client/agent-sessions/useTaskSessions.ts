import { useQuery } from '@tanstack/react-query'
import { useSubscription, useTRPC } from '@slayzone/transport/client'

/**
 * Every agent session tied to a task's main agent (mode `agentId`), newest
 * first — one entry per distinct provider conversation (`--resume` re-spawns
 * collapse into one). Refetches when `agentSessions.onChanged` fires for THIS
 * task. `enabled` gates both the query and the subscription so a task whose
 * sidebar/button is not shown costs nothing.
 *
 * Return row shape is inferred from the `agentSessions.list` tRPC procedure
 * (`TaskSessionSummary` from @slayzone/task/server) — no explicit type import.
 */
export function useTaskSessions(taskId: string, agentId: string, enabled: boolean) {
  const trpc = useTRPC()

  const query = useQuery(trpc.agentSessions.list.queryOptions({ taskId, agentId }, { enabled }))

  useSubscription(
    trpc.agentSessions.onChanged.subscriptionOptions(undefined, {
      enabled,
      onData: (changedTaskId) => {
        if (changedTaskId === taskId) void query.refetch()
      }
    })
  )

  return query.data ?? []
}
