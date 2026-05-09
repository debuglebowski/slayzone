import { useState, useEffect, type ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ReactQueryDevtools } from '@tanstack/react-query-devtools'
import { createTRPCClient, createWSClient, wsLink } from '@trpc/client'
import superjson from 'superjson'
import type { AppRouter } from '../server/router'
import { TRPCProvider, setTrpcVanillaClient } from './trpc'

export type TrpcProviderProps = {
  url: string
  children: ReactNode
}

export function TrpcProvider({ url, children }: TrpcProviderProps): ReactNode {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: { queries: { staleTime: 60_000 } },
      }),
  )
  const [{ wsClient, vanillaClient }] = useState(() => {
    const ws = createWSClient({ url })
    const vanilla = createTRPCClient<AppRouter>({
      links: [wsLink({ client: ws, transformer: superjson })],
    })
    setTrpcVanillaClient(vanilla)
    return { wsClient: ws, vanillaClient: vanilla }
  })

  useEffect(() => {
    return () => {
      wsClient.close()
    }
  }, [wsClient])

  return (
    <QueryClientProvider client={queryClient}>
      <TRPCProvider trpcClient={vanillaClient} queryClient={queryClient}>
        {children}
        {import.meta.env.DEV && <ReactQueryDevtools initialIsOpen={false} />}
      </TRPCProvider>
    </QueryClientProvider>
  )
}
