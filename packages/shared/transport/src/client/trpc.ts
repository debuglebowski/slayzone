import { createTRPCContext } from '@trpc/tanstack-react-query'
import { createTRPCClient, createWSClient, wsLink, type TRPCLink } from '@trpc/client'
import superjson from 'superjson'
import type { AppRouter } from '../server/router'

// New TanStack React Query integration (replaces classic createTRPCReact).
// Components: `const trpc = useTRPC()` then `useQuery(trpc.x.queryOptions(...))`,
// `useMutation(trpc.x.mutationOptions(...))`, `useSubscription(trpc.x.subscriptionOptions(...))`.
export const { TRPCProvider, useTRPC, useTRPCClient } = createTRPCContext<AppRouter>()

// Type-only re-export so out-of-package callers (e.g. the Chromium fork's
// browser-over-mojo terminating link) can type a `TRPCLink<AppRouter>` without
// reaching into the server entrypoint.
export type { AppRouter }

export type CreateTrpcClientOpts = {
  url: string
  /**
   * Extra links PREPENDED before the terminating wsLink. A link may short-circuit
   * an operation (resolve it locally) and pass everything else through via
   * `next(op)`. The Chromium fork uses this to resolve `app.browser.*` against the
   * native mojo host instead of the (stubbed) standalone sidecar. Electron callers
   * omit it → identical wsLink-only behavior.
   */
  links?: TRPCLink<AppRouter>[]
}

// Vanilla (non-React) client — used by the provider boot and by e2e via
// window.getTrpcVanillaClient(). Shape: client.<router>.<proc>.query/mutate(input).
export function createTrpcWsClient(opts: CreateTrpcClientOpts) {
  const wsClient = createWSClient({ url: opts.url })
  return {
    wsClient,
    client: createTRPCClient<AppRouter>({
      links: [
        ...(opts.links ?? []),
        wsLink({ client: wsClient, transformer: superjson })
      ]
    })
  }
}

export type TrpcVanillaClient = ReturnType<typeof createTrpcWsClient>['client']

// Module-scope singleton of the SAME client React uses (set by TrpcProvider on
// mount). Lets non-React module-scope code (zustand stores, etc.) call tRPC
// without a hook: `getTrpcClient().router.proc.query(input)`. Throws if accessed
// before the provider has connected — callers running at app boot (before port
// discovery) must guard or stay on the bridge.
let vanillaClientSingleton: TrpcVanillaClient | null = null
let wsClientSingleton: ReturnType<typeof createTrpcWsClient>['wsClient'] | null = null

export function _setTrpcClientSingleton(client: TrpcVanillaClient | null): void {
  vanillaClientSingleton = client
}

/**
 * Idempotently create + register the singleton tRPC client. Call this once at
 * boot (before React mounts / before any module-scope getTrpcClient() use), and
 * again inside TrpcProvider — the second call reuses the first, so there is one
 * WS connection shared by React and non-React callers.
 */
export function initTrpcClient(
  url: string,
  opts?: { links?: TRPCLink<AppRouter>[] }
): {
  client: TrpcVanillaClient
  wsClient: ReturnType<typeof createTrpcWsClient>['wsClient']
} {
  if (!vanillaClientSingleton || !wsClientSingleton) {
    // First call wins (boot, before React mounts) — it decides the link stack;
    // TrpcProvider's later initTrpcClient(url) reuses this same singleton.
    const created = createTrpcWsClient({ url, links: opts?.links })
    vanillaClientSingleton = created.client
    wsClientSingleton = created.wsClient
  }
  return { client: vanillaClientSingleton, wsClient: wsClientSingleton }
}

export function getTrpcClient(): TrpcVanillaClient {
  if (!vanillaClientSingleton) {
    throw new Error('tRPC client not ready — getTrpcClient() called before initTrpcClient()')
  }
  return vanillaClientSingleton
}
