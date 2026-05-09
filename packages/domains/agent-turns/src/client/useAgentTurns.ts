import { useEffect } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useSubscription } from '@trpc/tanstack-react-query'
import { useTRPC } from '@slayzone/transport/client'
import type { AgentTurnRange } from '../shared/types'

/**
 * Returns all turns for the given worktree path, oldest first. Re-fetches
 * when the `agent-turns.onChanged` tRPC subscription emits for the same
 * path, OR when the optional `refreshKey` changes identity (used to
 * retrigger after working tree state changes — server-side filter prunes
 * turns whose files no longer appear in `git status`).
 */
export function useAgentTurns(
  worktreePath: string | null | undefined,
  refreshKey?: unknown,
): AgentTurnRange[] {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const enabled = !!worktreePath

  const { data: turns = [] } = useQuery(
    trpc.agentTurns.list.queryOptions(
      { worktreePath: worktreePath ?? '' },
      { enabled },
    ),
  )

  // Identity change of `refreshKey` forces a refetch.
  useEffect(() => {
    if (!worktreePath) return
    queryClient.invalidateQueries({
      queryKey: trpc.agentTurns.list.queryKey({ worktreePath }),
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey])

  useSubscription(
    trpc.agentTurns.onChanged.subscriptionOptions(undefined, {
      onData: (changedPath) => {
        if (!worktreePath) return
        const norm = (p: string) => p.replace(/\/+$/, '')
        if (norm(changedPath) === norm(worktreePath)) {
          queryClient.invalidateQueries({
            queryKey: trpc.agentTurns.list.queryKey({ worktreePath }),
          })
        }
      },
    }),
  )

  return turns
}
