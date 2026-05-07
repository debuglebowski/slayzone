import { createTRPCReact } from '@trpc/react-query'
import { createTRPCClient, createWSClient, wsLink, type TRPCClient } from '@trpc/client'
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

let _vanillaClient: TRPCClient<AppRouter> | null = null

/** Set by <TrpcProvider> on mount so non-React call sites can reach the same WS link. */
export function setTrpcVanillaClient(client: TRPCClient<AppRouter>): void {
  _vanillaClient = client
}

/** Throws if the renderer hasn't mounted <TrpcProvider> yet. */
export function getTrpcVanillaClient(): TRPCClient<AppRouter> {
  if (!_vanillaClient) {
    throw new Error('tRPC client not initialized — wrap renderer in <TrpcProvider>')
  }
  return _vanillaClient
}
