import { useState, useEffect, type ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createTRPCClient, createWSClient, wsLink } from '@trpc/client'
import superjson from 'superjson'
import type { AppRouter } from '../server/router'
import { trpc, setTrpcVanillaClient } from './trpc'

export type TrpcProviderProps = {
  url: string
  children: ReactNode
}

export function TrpcProvider({ url, children }: TrpcProviderProps): ReactNode {
  const [queryClient] = useState(() => new QueryClient())
  const [{ wsClient, trpcClient, vanillaClient }] = useState(() => {
    const ws = createWSClient({ url })
    const links = [wsLink({ client: ws, transformer: superjson })]
    const vanilla = createTRPCClient<AppRouter>({ links })
    setTrpcVanillaClient(vanilla)
    return {
      wsClient: ws,
      trpcClient: trpc.createClient({ links }),
      vanillaClient: vanilla,
    }
  })

  useEffect(() => {
    return () => {
      wsClient.close()
    }
  }, [wsClient])

  // Reference vanillaClient to keep it alive across renders.
  void vanillaClient

  return (
    <trpc.Provider client={trpcClient} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </trpc.Provider>
  )
}
