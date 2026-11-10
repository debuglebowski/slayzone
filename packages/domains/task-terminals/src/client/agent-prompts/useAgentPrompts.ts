import { useQuery } from '@tanstack/react-query'
import { useSubscription } from '@slayzone/transport/client'
import { useTRPC } from '../trpc'

/**
 * User prompts sent to a task's main agent (mode `agentId`) — or, with
 * `agentId` undefined, to every agent of the task (terminal + chat) — oldest
 * first. Refetches when `agentPrompts.onChanged` fires for THIS task. `enabled`
 * gates both the query and the subscription so closed sidebars cost nothing.
 *
 * Return row shape is inferred from the `agentPrompts.list` tRPC procedure
 * (`AgentPrompt` from @slayzone/agent-turns) — no explicit type import needed.
 */
export function useAgentPrompts(taskId: string, agentId: string | undefined, enabled: boolean) {
  return useAgentPromptsState(taskId, agentId, enabled).prompts
}

/**
 * The prompts and whether they cannot be read: they live only on the computer
 * running the task's agents (robustness plan §9), and the list answers
 * PRECONDITION_FAILED while that computer is offline (the hub keeps no copy).
 */
export function useAgentPromptsState(
  taskId: string,
  agentId: string | undefined,
  enabled: boolean
) {
  const trpc = useTRPC()

  const { data, error, refetch } = useQuery(
    trpc.agentPrompts.list.queryOptions({ taskId, agentId }, { enabled })
  )

  useSubscription(
    trpc.agentPrompts.onChanged.subscriptionOptions(undefined, {
      enabled,
      onData: (changedTaskId) => {
        if (changedTaskId === taskId) void refetch()
      }
    })
  )

  const offline =
    (error as { data?: { code?: string } } | null)?.data?.code === 'PRECONDITION_FAILED'
  return { prompts: data ?? [], offline }
}
