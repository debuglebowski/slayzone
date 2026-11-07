/**
 * Views backed by a computer (git panel, processes, AI config, agent turns, test
 * panel, usage, the file editor and workspace picker, terminal settings probes)
 * answer "connect a computer" while none is there — on the desktop, the seconds
 * between boot and the local computer enrolling. When a computer connects, every
 * such query refetches, so no view stays stuck on that answer. `onStatusChange`
 * sends no snapshot: a connect that landed before the subscription started is
 * caught by refetching once it starts.
 */
import { useQueryClient } from '@tanstack/react-query'
import { noteComputerConnected, useSubscription } from '@slayzone/transport/client'
import { retryFailedGitWatches } from '@slayzone/worktrees/hooks'
import { useTRPC } from '../trpc'

/** The tRPC namespaces (or single procedures) whose answers come from a computer. */
export const COMPUTER_BACKED_QUERIES = [
  'worktrees',
  'processes',
  'aiConfig',
  'agentTurns',
  'testPanel',
  'usageAnalytics',
  'fileEditor',
  'workspace',
  'pty.testExecutionContext',
  'pty.agentsTest'
] as const

export type ComputerBackedQuery = (typeof COMPUTER_BACKED_QUERIES)[number]

interface Invalidator {
  invalidateQueries(filter: { queryKey: readonly unknown[] }): Promise<unknown>
}

/** The `computers.onStatusChange` handlers: on a connect (or the start), refetch them all. */
export function computerConnectRefetcher(
  client: Invalidator,
  keyOf: (query: ComputerBackedQuery) => readonly unknown[]
): {
  onStarted(): void
  onData(change: { computerId: string; connected: boolean }): void
} {
  const refetchAll = (): void => {
    for (const q of COMPUTER_BACKED_QUERIES) void client.invalidateQueries({ queryKey: keyOf(q) })
  }
  return {
    onStarted: refetchAll,
    onData: (change) => {
      if (change.connected) refetchAll()
    }
  }
}

/** `trpc.<a>.<b>` for a dotted query path. */
function pathKeyOf(trpc: unknown, query: string): readonly unknown[] {
  let node = trpc as Record<string, unknown>
  for (const seg of query.split('.')) node = node[seg] as Record<string, unknown>
  return (node as unknown as { pathKey(): readonly unknown[] }).pathKey()
}

/** Mounted once by the app shell. */
export function useComputerConnectRefetch(): void {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const refetch = computerConnectRefetcher(queryClient, (q) => pathKeyOf(trpc, q))
  useSubscription(
    trpc.computers.onStatusChange.subscriptionOptions(undefined, {
      // Subscriptions refused before then (the file editor's watch) start again too.
      onStarted: () => {
        refetch.onStarted()
        noteComputerConnected()
        retryFailedGitWatches()
      },
      onData: (change) => {
        refetch.onData(change)
        if (!change.connected) return
        noteComputerConnected()
        // The git panel's watches refused before then (they poll meanwhile).
        retryFailedGitWatches()
      }
    })
  )
}
