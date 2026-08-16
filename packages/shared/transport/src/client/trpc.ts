import { createTRPCContext } from '@trpc/tanstack-react-query'
import { createTRPCClient, createWSClient, wsLink, type TRPCLink } from '@trpc/client'
import superjson from 'superjson'
import { connectDeadlineLink } from './connectDeadlineLink'
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
  /**
   * Multi-hub auth: bearer token sent as tRPC `connectionParams` on (re)connect.
   * The hub reads it in createContext and verifies it only when it advertises
   * `authRequired` (remote hubs). Omitted / undefined for the local loopback hub
   * → no connectionParams frame → byte-identical to the pre-auth client.
   */
  token?: string
  /**
   * Override how long an operation may wait for this hub's socket to open
   * before it fails as unreachable (see `connectDeadlineLink`). Tests pass a
   * short one; callers otherwise take the default.
   */
  connectDeadlineMs?: number
}

// Vanilla (non-React) client — used by the provider boot and by e2e via
// window.getTrpcVanillaClient(). Shape: client.<router>.<proc>.query/mutate(input).
export function createTrpcWsClient(opts: CreateTrpcClientOpts) {
  const wsClient = createWSClient({
    url: opts.url,
    // Only attach connectionParams when a token is present — an absent token
    // keeps the connect frame identical to the untokened (local) path.
    ...(opts.token ? { connectionParams: async () => ({ token: opts.token as string }) } : {})
  })
  return {
    wsClient,
    client: createTRPCClient<AppRouter>({
      links: [
        ...(opts.links ?? []),
        // AFTER the caller's links (the fork's mojo link resolves browser ops
        // locally and must not be gated on a WS that isn't part of its path),
        // and immediately BEFORE the terminating wsLink — everything it guards
        // is an operation actually bound for this socket.
        connectDeadlineLink({
          connectionState: wsClient.connectionState,
          deadlineMs: opts.connectDeadlineMs,
          hubUrl: opts.url
        }),
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
 *
 * `opts.token` is the same bearer `createTrpcWsClient`/`getOrCreateHubClient`
 * already accept — omitted by every existing caller (desktop's default hub is
 * always loopback-trusted; the fork's standalone sidecar has auth off), so
 * this is additive and byte-identical for them. The web shell is the first
 * caller that MUST supply one: its hub enforces auth unconditionally
 * (`hubAuthRequired = !supervised`), so its boot sequence pre-initializes this
 * singleton with the scoped session token BEFORE `renderer-app`'s `mountApp()`
 * makes its own (now cache-hit, since this call already won) `initTrpcClient`
 * call.
 */
export function initTrpcClient(
  url: string,
  opts?: { links?: TRPCLink<AppRouter>[]; token?: string }
): {
  client: TrpcVanillaClient
  wsClient: ReturnType<typeof createTrpcWsClient>['wsClient']
} {
  if (!vanillaClientSingleton || !wsClientSingleton) {
    // First call wins (boot, before React mounts) — it decides the link stack;
    // TrpcProvider's later initTrpcClient(url) reuses this same singleton.
    const created = createTrpcWsClient({ url, links: opts?.links, token: opts?.token })
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

// ---------------------------------------------------------------------------
// Multi-hub federation: a keyed registry of per-hub WS clients.
//
// The client can connect to several full-data hubs at once (see FederationProvider
// / HubScope). Each hub gets its OWN WS connection here; the React layer pairs
// each with its own QueryClient so cross-hub cache keys can never collide.
//
// The DEFAULT (local) hub's entry reuses the boot singleton above, so the huge
// existing surface — module-scope getTrpcClient() callers + the pre-React
// prefetch in main.tsx — stays on exactly one WS shared with the React tree.
// With a single hub this registry holds one entry === today's singleton, so the
// whole thing is byte-identical until a second hub is added.
// ---------------------------------------------------------------------------

export type HubWsClient = {
  id: string
  url: string
  /** The token this socket was OPENED with. `connectionParams` is sent once per
   *  connect, so a later token is only reachable by rebuilding — see below. */
  token?: string
  client: TrpcVanillaClient
  wsClient: ReturnType<typeof createTrpcWsClient>['wsClient']
}

const hubClients = new Map<string, HubWsClient>()

/**
 * Idempotently get/create the WS client for a hub id. The default hub routes
 * through `initTrpcClient` so its client IS the boot singleton (module-scope
 * getTrpcClient() coherence); non-default hubs get a fresh dedicated WS.
 *
 * A cached entry is returned as-is even if `url` differs — a hub's url only
 * changes via a relaunch-gated config edit today, so live re-pointing is out of
 * scope (Phase 5 handles add/remove through a fresh boot).
 *
 * A changed TOKEN is different, and must rebuild: signing in to a hub is only
 * reachable AFTER that hub has been added, and adding it already opened this
 * socket untokened. Returning the cached client there stranded the hub
 * permanently unauthenticated — `HubsSettingsTab.signIn()` pushes the fresh
 * token into the registry precisely so no relaunch is needed, and this cache was
 * quietly discarding it. Latent until client auth became mandatory on every
 * non-supervised hub; before that an untokened socket still worked.
 */
export function getOrCreateHubClient(opts: {
  id: string
  url: string
  isDefault?: boolean
  links?: TRPCLink<AppRouter>[]
  /** Bearer token for a remote (authed) hub. Omitted for the local hub. */
  token?: string
}): HubWsClient {
  const cached = hubClients.get(opts.id)
  // The default hub is the boot singleton and carries no token — never rebuild
  // it, or every module-scope getTrpcClient() caller would keep a dead socket.
  if (cached && (opts.isDefault || cached.token === opts.token)) return cached
  if (cached) cached.wsClient.close()
  const created = opts.isDefault
    ? initTrpcClient(opts.url, { links: opts.links })
    : createTrpcWsClient({ url: opts.url, links: opts.links, token: opts.token })
  const entry: HubWsClient = {
    id: opts.id,
    url: opts.url,
    ...(opts.token ? { token: opts.token } : {}),
    client: created.client,
    wsClient: created.wsClient
  }
  hubClients.set(opts.id, entry)
  return entry
}

export function getHubClient(id: string): HubWsClient | null {
  return hubClients.get(id) ?? null
}

/** Every hub client created so far (default + any federated remotes). Used by
 *  cross-hub fan-out (e.g. the terminal-state reconcile unions all hubs' live
 *  session lists). Order is insertion order (default hub first). */
export function listHubClients(): HubWsClient[] {
  return [...hubClients.values()]
}

/** Test-only: drop all registered hub clients (does not touch the singleton). */
export function _resetHubClients(): void {
  hubClients.clear()
}
