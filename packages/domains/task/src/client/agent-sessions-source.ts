import { useQuery } from '@tanstack/react-query'
import { useSubscription, useTRPC } from '@slayzone/transport/client'
import type {
  TaskSessionRow,
  TaskSessionsSource
} from '@slayzone/task-terminals/client/TaskSessionsSource'

// Re-exported so the composing apps register through task (they depend on task,
// not on task-terminals).
export { registerTaskSessionsSource } from '@slayzone/task-terminals/client/TaskSessionsSource'

/**
 * Every agent session tied to a task's main agent (mode `agentId`), newest
 * first — one entry per distinct provider conversation (`--resume` re-spawns
 * collapse into one). Refetches when `agentSessions.onChanged` fires for THIS
 * task. `enabled` gates both the query and the subscription so a task whose
 * sidebar/button is not shown costs nothing.
 *
 * Task's half of task-terminals' `TaskSessionsSource` contract: task owns the
 * `agentSessions` router and renders `TerminalContainer`, so it injects this.
 */
function useAgentSessions(
  taskId: string,
  agentId: string,
  enabled: boolean
): readonly TaskSessionRow[] {
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

/** Pass to `registerTaskSessionsSource` at app startup (module scope, before any render). */
export const taskSessionsSource: TaskSessionsSource = { useTaskSessions: useAgentSessions }
