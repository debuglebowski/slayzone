import { useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useSubscription, useTRPC } from '@slayzone/transport/client'
import type { AgentTurnRange } from '../shared/types'

/**
 * Returns all turns for the given worktree path, oldest first. Re-fetches
 * when `agentTurns.onChanged` fires for the same path, OR when the optional
 * `refreshKey` changes identity (used to retrigger after working tree state
 * changes; server-side filter prunes turns whose files no longer appear in
 * `git status`).
 */
export function useAgentTurns(
  worktreePath: string | null | undefined,
  refreshKey?: unknown
): AgentTurnRange[] {
  const trpc = useTRPC()
  const norm = (p: string): string => p.replace(/\/+$/, '')

  const query = useQuery(
    trpc.agentTurns.list.queryOptions(
      { worktreePath: worktreePath ?? '' },
      { enabled: !!worktreePath }
    )
  )

  // External retrigger: refetch when refreshKey identity changes. react-query
  // dedups against the in-flight mount fetch, so the initial run is a no-op.
  useEffect(() => {
    if (worktreePath) void query.refetch()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey])

  useSubscription(
    trpc.agentTurns.onChanged.subscriptionOptions(undefined, {
      enabled: !!worktreePath,
      onData: (changedPath) => {
        // Strict equality after trailing-slash normalization. Avoids false
        // positives from suffix-match when two worktree paths share a tail.
        if (worktreePath && norm(changedPath) === norm(worktreePath)) {
          void query.refetch()
        }
      }
    })
  )

  return query.data ?? []
}
