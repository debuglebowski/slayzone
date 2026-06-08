import { createTRPCContext } from '@trpc/tanstack-react-query'
import { createTRPCClient, createWSClient, wsLink } from '@trpc/client'
import superjson from 'superjson'
import type { AppRouter } from '../server/router'

// New TanStack React Query integration (replaces classic createTRPCReact).
// Components: `const trpc = useTRPC()` then `useQuery(trpc.x.queryOptions(...))`,
// `useMutation(trpc.x.mutationOptions(...))`, `useSubscription(trpc.x.subscriptionOptions(...))`.
export const { TRPCProvider, useTRPC, useTRPCClient } = createTRPCContext<AppRouter>()

export type CreateTrpcClientOpts = {
  url: string
}

// Vanilla (non-React) client — used by the provider boot and by e2e via
// window.getTrpcVanillaClient(). Shape: client.<router>.<proc>.query/mutate(input).
export function createTrpcWsClient(opts: CreateTrpcClientOpts) {
  const wsClient = createWSClient({ url: opts.url })
  return {
    wsClient,
    client: createTRPCClient<AppRouter>({
      links: [wsLink({ client: wsClient, transformer: superjson })]
    })
  }
}
