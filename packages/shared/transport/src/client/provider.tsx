import { useState, useEffect, type ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { TRPCProvider, createTrpcWsClient } from './trpc'

export type TrpcProviderProps = {
  url: string
  children: ReactNode
}

function makeQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        // Baseline dedup window (replaces the old IPC dedup hashFn). Heavy reads
        // (worktree/git) override per-query; mutations invalidate explicitly.
        staleTime: 5_000,
        // Keep focus refetch ON — reproduces the legacy useVisibleInterval
        // catch-up tick that pollers relied on. Do NOT disable globally.
        refetchOnWindowFocus: true,
        retry: false
      }
    }
  })
}

export function TrpcProvider({ url, children }: TrpcProviderProps): ReactNode {
  const [queryClient] = useState(makeQueryClient)
  const [{ wsClient, client }] = useState(() => createTrpcWsClient({ url }))

  useEffect(() => {
    return () => {
      wsClient.close()
    }
  }, [wsClient])

  return (
    <QueryClientProvider client={queryClient}>
      <TRPCProvider trpcClient={client} queryClient={queryClient}>
        {children}
      </TRPCProvider>
    </QueryClientProvider>
  )
}
