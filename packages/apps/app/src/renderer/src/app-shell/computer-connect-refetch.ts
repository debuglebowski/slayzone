/**
 * Views backed by a computer (git panel, processes, AI config, agent turns, test
 * panel, usage) answer "connect a computer" while none is there — on the desktop,
 * the seconds between boot and the local computer enrolling. When a computer
 * connects, every such query refetches, so no view stays stuck on that answer.
 */
import { useQueryClient } from '@tanstack/react-query'
import { useSubscription } from '@slayzone/transport/client'
import { useTRPC } from '../trpc'

/** The tRPC namespaces whose answers come from a computer. */
export const COMPUTER_BACKED_NAMESPACES = [
  'worktrees',
  'processes',
  'aiConfig',
  'agentTurns',
  'testPanel',
  'usageAnalytics'
] as const

export type ComputerBackedNamespace = (typeof COMPUTER_BACKED_NAMESPACES)[number]

interface Invalidator {
  invalidateQueries(filter: { queryKey: readonly unknown[] }): Promise<unknown>
}

/** The `computers.onStatusChange` handler: on a connect, refetch them all. */
export function computerConnectRefetcher(
  client: Invalidator,
  keyOf: (namespace: ComputerBackedNamespace) => readonly unknown[]
): (change: { computerId: string; connected: boolean }) => void {
  return (change) => {
    if (!change.connected) return
    for (const ns of COMPUTER_BACKED_NAMESPACES)
      void client.invalidateQueries({ queryKey: keyOf(ns) })
  }
}

/** Mounted once by the app shell. */
export function useComputerConnectRefetch(): void {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  useSubscription(
    trpc.computers.onStatusChange.subscriptionOptions(undefined, {
      onData: computerConnectRefetcher(queryClient, (ns) => trpc[ns].pathKey())
    })
  )
}
