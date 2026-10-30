/**
 * The computers of the hub whose `HubScope` this runs in, live: `computers.list`,
 * loaded again whenever the hub says a computer connected or dropped
 * (`computers.onStatusChange` carries only the id) — desktop's Settings → Connections
 * rule. Changes of who runs what arrive as `notify.onTasksChanged` (the board).
 */
import { useSubscription } from '@slayzone/transport/client'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTRPC } from '../trpc'
import type { HubComputer } from './hub-computers'

const NONE: HubComputer[] = []

export interface HubComputers {
  computers: HubComputer[]
  /** The first load is under way. */
  pending: boolean
  /** Why the last load failed; null = it didn't. */
  error: string | null
}

export function useHubComputers(): HubComputers {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const list = useQuery(trpc.computers.list.queryOptions())
  useSubscription(
    trpc.computers.onStatusChange.subscriptionOptions(undefined, {
      onData: () => void queryClient.invalidateQueries(trpc.computers.list.queryFilter())
    })
  )
  return {
    computers: list.data ?? NONE,
    pending: list.isPending,
    error: list.error ? list.error.message : null
  }
}
