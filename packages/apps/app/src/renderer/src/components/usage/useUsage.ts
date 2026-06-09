import { useCallback } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTRPC, useTRPCClient } from '@slayzone/transport/client'

const POLL_INTERVAL = 5 * 60_000

export function useUsage() {
  const trpc = useTRPC()
  const trpcClient = useTRPCClient()
  const queryClient = useQueryClient()

  // Background poll — only while the window is visible (no background refetch),
  // mirroring the old useVisibleInterval(runOnVisible) behavior. The non-forced
  // input lets the main process serve its cached usage on the interval ticks.
  const query = useQuery(
    trpc.app.usage.fetch.queryOptions(
      {},
      { refetchInterval: POLL_INTERVAL, refetchIntervalInBackground: false }
    )
  )

  // Manual refresh. force=true bypasses the main-process cache; the fresh result
  // is written back into the query cache so the UI updates without a second
  // fetch. Errors are swallowed — stale data is fine.
  const refresh = useCallback(
    async (force?: boolean) => {
      try {
        if (force) {
          const result = await trpcClient.app.usage.fetch.query({ force: true })
          queryClient.setQueryData(trpc.app.usage.fetch.queryKey({}), result)
        } else {
          await query.refetch()
        }
      } catch {
        // silent — stale data is fine
      }
    },
    [trpcClient, queryClient, trpc, query]
  )

  return { data: query.data ?? [], loading: query.isLoading, refresh }
}
