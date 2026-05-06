import { useState, useEffect, type ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createWSClient, wsLink } from '@trpc/client'
import superjson from 'superjson'
import { trpc } from './trpc'

export type TrpcProviderProps = {
  url: string
  children: ReactNode
}

export function TrpcProvider({ url, children }: TrpcProviderProps): ReactNode {
  const [queryClient] = useState(() => new QueryClient())
  const [{ wsClient, trpcClient }] = useState(() => {
    const ws = createWSClient({ url })
    return {
      wsClient: ws,
      trpcClient: trpc.createClient({
        links: [wsLink({ client: ws, transformer: superjson })],
      }),
    }
  })

  useEffect(() => {
    return () => {
      wsClient.close()
    }
  }, [wsClient])

  return (
    <trpc.Provider client={trpcClient} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </trpc.Provider>
  )
}
