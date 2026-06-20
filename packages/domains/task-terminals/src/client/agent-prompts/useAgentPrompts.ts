import { useQuery } from '@tanstack/react-query'
import { useSubscription, useTRPC } from '@slayzone/transport/client'

/**
 * User prompts sent to a task's main agent (mode `agentId`), oldest first.
 * Refetches when `agentPrompts.onChanged` fires for THIS task. `enabled` gates
 * both the query and the subscription so closed sidebars cost nothing.
 *
 * Return row shape is inferred from the `agentPrompts.list` tRPC procedure
 * (`AgentPrompt` from @slayzone/agent-turns) — no explicit type import needed.
 */
export function useAgentPrompts(taskId: string, agentId: string, enabled: boolean) {
  const trpc = useTRPC()

  const query = useQuery(
    trpc.agentPrompts.list.queryOptions({ taskId, agentId }, { enabled })
  )

  useSubscription(
    trpc.agentPrompts.onChanged.subscriptionOptions(undefined, {
      enabled,
      onData: (changedTaskId) => {
        if (changedTaskId === taskId) void query.refetch()
      }
    })
  )

  return query.data ?? []
}
