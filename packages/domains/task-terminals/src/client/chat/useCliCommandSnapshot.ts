import { useQuery } from '@tanstack/react-query'
import type { CliCommandList } from '@slayzone/terminal-contracts'
import { useTRPC } from '../trpc'

/**
 * The chat CLI's slash commands for the `/` menu: the live list from this
 * session's latest `turn-init`, else the last list the CLI advertised in this
 * task's project (a session reports its list only once its first turn starts).
 * `enabled` = the mode's `nativeSlashCommands` capability; off → null.
 */
export function useCliCommandSnapshot({
  taskId,
  mode,
  live,
  enabled
}: {
  taskId: string
  mode: string
  live: CliCommandList | null
  enabled: boolean
}): CliCommandList | null {
  const trpc = useTRPC()
  const { data } = useQuery(
    trpc.chat.getCliSnapshot.queryOptions({ taskId, mode }, { enabled: enabled && !live })
  )
  if (!enabled) return null
  return live ?? data ?? null
}
