import { createTRPCReact } from '@trpc/react-query'
import { createTRPCClient, createWSClient, wsLink } from '@trpc/client'
import superjson from 'superjson'
import type { AppRouter } from '../server/router'

export const trpc = createTRPCReact<AppRouter>()

export type CreateTrpcClientOpts = {
  url: string
}

export function createTrpcWsClient(opts: CreateTrpcClientOpts) {
  const wsClient = createWSClient({ url: opts.url })
  return {
    wsClient,
    client: createTRPCClient<AppRouter>({
      links: [wsLink({ client: wsClient, transformer: superjson })],
    }),
  }
}
