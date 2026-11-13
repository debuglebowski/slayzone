import { useEffect, useEffectEvent } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useSubscription } from '@slayzone/transport/client'
import { useTRPC } from './trpc'
import type { AgentTurnRange } from '../shared/types'

/**
 * Returns all turns of the task's checkout, oldest first — its computer resolves the
 * checkout (§9 Phase 7d: the list names only the task). Re-fetches when
 * `agentTurns.onChanged` fires for that checkout (`worktreePath`, as the client read
 * it from the computer: it only filters the change events), OR when the optional
 * `refreshKey` changes identity (used to retrigger after working tree state
 * changes; server-side filter prunes turns whose files no longer appear in
 * `git status`).
 */
export function useAgentTurns(
  /** The task whose checkout it is (the list's path scope, §9 Phase 7b). */
  taskId: string | null | undefined,
  worktreePath: string | null | undefined,
  refreshKey?: unknown
): AgentTurnRange[] {
  const trpc = useTRPC()
  const norm = (p: string): string => p.replace(/\/+$/, '')

  const options = trpc.agentTurns.list.queryOptions(
    { taskId: taskId ?? '' },
    { enabled: !!worktreePath && !!taskId }
  )
  // Keyed by the checkout too (never sent): a new worktree is a fresh list.
  const query = useQuery({
    ...options,
    queryKey: [...options.queryKey, norm(worktreePath ?? '')] as unknown as typeof options.queryKey
  })

  // External retrigger: refetch when refreshKey identity changes. react-query
  // dedups against the in-flight mount fetch, so the initial run is a no-op.
  // An Effect Event: a worktreePath change alone re-keys the query, not this.
  const refetchForKey = useEffectEvent(() => {
    if (worktreePath) void query.refetch()
  })
  useEffect(() => refetchForKey(), [refreshKey])

  useSubscription(
    trpc.agentTurns.onChanged.subscriptionOptions(undefined, {
      enabled: !!worktreePath,
      onData: ({ worktreePath: changedPath }) => {
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
