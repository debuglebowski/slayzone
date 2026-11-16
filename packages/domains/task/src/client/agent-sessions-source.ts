import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useSubscription } from '@slayzone/transport/client'
import { invalidateSoon } from './coalesced-invalidate'
import { useTRPC } from './trpc'
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
 * collapse into one). Refetches when sessions or prompts change for THIS
 * task. `enabled` gates the query and subscriptions so a task whose
 * sidebar/button is not shown costs nothing.
 *
 * Task's half of task-terminals' `TaskSessionsSource` contract: task owns the
 * `agentSessions` router and renders `TerminalContainer`, so it injects this.
 */
function useAgentSessions(
  taskId: string,
  agentId: string,
  enabled: boolean,
  tabId?: string
): readonly TaskSessionRow[] {
  const trpc = useTRPC()
  const queryClient = useQueryClient()

  const listOptions = trpc.agentSessions.list.queryOptions(
    { taskId, agentId, ...(tabId ? { tabId } : {}) },
    { enabled }
  )
  const query = useQuery(listOptions)
  // One re-read per burst of notices (FU5): both notices of one change, from every
  // mounted list of this query, are one re-read — not one `refetch()` each.
  const listKey = listOptions.queryKey

  useSubscription(
    trpc.agentSessions.onChanged.subscriptionOptions(undefined, {
      enabled,
      onData: (changedTaskId) => {
        if (changedTaskId === taskId) invalidateSoon(queryClient, listKey)
      }
    })
  )

  useSubscription(
    trpc.agentPrompts.onChanged.subscriptionOptions(undefined, {
      enabled,
      onData: (changedTaskId) => {
        if (changedTaskId === taskId) invalidateSoon(queryClient, listKey)
      }
    })
  )

  return query.data ?? []
}

/**
 * Whether the task's sessions cannot be read: the computer holding them is offline
 * (the list answers PRECONDITION_FAILED; robustness plan §9). Shares the list's query.
 */
function useAgentSessionsOffline(
  taskId: string,
  agentId: string,
  enabled: boolean,
  tabId?: string
): boolean {
  const trpc = useTRPC()
  const { error } = useQuery(
    trpc.agentSessions.list.queryOptions(
      { taskId, agentId, ...(tabId ? { tabId } : {}) },
      { enabled }
    )
  )
  return (error as { data?: { code?: string } } | null)?.data?.code === 'PRECONDITION_FAILED'
}

/** Pass to `registerTaskSessionsSource` at app startup (module scope, before any render). */
export const taskSessionsSource: TaskSessionsSource = {
  useTaskSessions: useAgentSessions,
  useTaskSessionsOffline: useAgentSessionsOffline
}
