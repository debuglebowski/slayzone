import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { CliCommandDetails, CliCommandList } from '@slayzone/terminal-contracts'
import { useTRPC } from '../trpc'

/**
 * The chat CLI's slash commands for the `/` menu: the live list from this
 * session's latest `turn-init`, else the last list the CLI advertised in this
 * task's project (a session reports its list only once its first turn starts).
 * Descriptions + argument hints (the CLI's `initialize` reply) come live from
 * this session, else from the project's stored ones.
 * `enabled` = the mode's `nativeSlashCommands` capability; off → null.
 */
export function useCliCommandSnapshot({
  taskId,
  mode,
  live,
  liveDetails = null,
  enabled
}: {
  taskId: string
  mode: string
  live: CliCommandList | null
  liveDetails?: CliCommandDetails | null
  enabled: boolean
}): CliCommandList | null {
  const trpc = useTRPC()
  const { data: stored } = useQuery(
    trpc.chat.getCliSnapshot.queryOptions({ taskId, mode }, { enabled: enabled && !live })
  )
  const { data: storedDetails } = useQuery(
    trpc.chat.getCliCommandDetails.queryOptions(
      { taskId, mode },
      { enabled: enabled && !liveDetails }
    )
  )
  const list = enabled ? (live ?? stored ?? null) : null
  const details = liveDetails ?? storedDetails ?? null
  // One object per (list, details) pair: the composer's sources memoize on it.
  return useMemo(
    () => (list && details && list.details !== details ? { ...list, details } : list),
    [list, details]
  )
}
