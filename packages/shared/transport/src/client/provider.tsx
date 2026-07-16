import { useState, type ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { TRPCProvider, initTrpcClient } from './trpc'

export type TrpcProviderProps = {
  url: string
  children: ReactNode
}

export function makeQueryClient(): QueryClient {
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
  // Reuse the boot-initialized singleton (one WS shared by React + module-scope
  // getTrpcClient() callers); creates it if boot didn't.
  const [{ client }] = useState(() => initTrpcClient(url))

  return (
    <QueryClientProvider client={queryClient}>
      <TRPCProvider trpcClient={client} queryClient={queryClient}>
        {children}
      </TRPCProvider>
    </QueryClientProvider>
  )
}
