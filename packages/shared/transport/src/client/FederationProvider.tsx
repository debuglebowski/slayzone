import { createContext, useContext, useEffect, useMemo, useRef, type ReactNode } from 'react'
import { QueryClient } from '@tanstack/react-query'
import type { HubEntry } from '@slayzone/platform/hub-registry'
import { closeHubClient, getOrCreateHubClient, type RuntimeHubWsClient } from './runtime'
import { makeQueryClient } from './provider'
import { useHubRegistryStore } from './hubRegistryStore'

/**
 * Multi-hub federation — the outer, stable provider.
 *
 * Owns the hub-client registry: for every hub in `hubs` it lazily creates one WS
 * client (via the module-scope registry in runtime.ts) AND one dedicated
 * React-Query QueryClient. A per-hub QueryClient is the load-bearing choice —
 * project/task ids are only unique within a hub's own DB, so isolated caches make
 * cross-hub key collisions structurally impossible; the ~500 existing
 * `useTRPC()` sites need no composite keys.
 *
 * This provider does NOT itself bind a tRPC client — it just holds the registry.
 * A `<HubScope hubId>` inner provider (see HubScope.tsx) is what actually mounts
 * a hub's client + QueryClient so `useTRPC()` inside it resolves to that hub.
 *
 * With a single hub (`[local]`) the default hub reuses the boot singleton, so the
 * whole app under one HubScope('local') is byte-identical to the pre-federation
 * single-client world.
 */

export type ResolvedHub = {
  entry: HubEntry
  /** Router-agnostic: a caller re-types it through its own view's `TypedHubWsClient`. */
  ws: RuntimeHubWsClient
  queryClient: QueryClient
}

type FederationContextValue = {
  hubs: HubEntry[]
  defaultHubId: string
  /** Resolve (get-or-create) the WS client + QueryClient for a hub id. */
  resolve: (hubId: string) => ResolvedHub | null
}

const FederationContext = createContext<FederationContextValue | null>(null)

export type FederationProviderProps = {
  hubs: HubEntry[]
  defaultHubId: string
  /** Appends `?windowId=N` (and any per-hub query) to a hub's ws url. Injected by
   *  the host so this package stays free of window-id plumbing. */
  decorateUrl?: (url: string) => string
  /** Per-hub bearer tokens (hubId → token) for authed remote hubs. Sent as tRPC
   *  connectionParams. Omitted / empty for the local hub → no token frame. */
  tokens?: Record<string, string>
  children: ReactNode
}

export function FederationProvider({
  hubs,
  defaultHubId,
  decorateUrl,
  tokens,
  children
}: FederationProviderProps): ReactNode {
  // QueryClients are created once per hub id and cached across renders — a new
  // QueryClient on every render would drop all cached data + in-flight queries.
  const queryClients = useRef(new Map<string, QueryClient>())

  const value = useMemo<FederationContextValue>(() => {
    const resolve = (hubId: string): ResolvedHub | null => {
      const entry = hubs.find((h) => h.id === hubId)
      if (!entry || !entry.url) return null
      const url = decorateUrl ? decorateUrl(entry.url) : entry.url
      const ws = getOrCreateHubClient({
        id: entry.id,
        url,
        isDefault: entry.id === defaultHubId,
        token: entry.id === defaultHubId ? undefined : tokens?.[entry.id]
      })
      let queryClient = queryClients.current.get(entry.id)
      if (!queryClient) {
        queryClient = makeQueryClient()
        queryClients.current.set(entry.id, queryClient)
      }
      return { entry, ws, queryClient }
    }
    return { hubs, defaultHubId, resolve }
    // decorateUrl is a stable host closure; hubs/defaultHubId/tokens drive re-resolution.
  }, [hubs, defaultHubId, decorateUrl, tokens])

  // A hub that left `hubs` (signed out) takes its socket and its cache with it: the
  // socket would keep reconnecting with a bearer the user gave up, and a later sign-in
  // must not be served the old session's cached rows. Desktop never shrinks `hubs`
  // while running (adding a hub reloads the window, removing one relaunches the app),
  // so there this never fires; the mobile app signs out of one hub of several in place.
  // The default hub is never touched (`closeHubClient` refuses its boot singleton too).
  useEffect(() => {
    const listed = new Set(hubs.map((h) => h.id))
    for (const [hubId, queryClient] of queryClients.current) {
      if (listed.has(hubId) || hubId === defaultHubId) continue
      queryClients.current.delete(hubId)
      queryClient.clear()
      closeHubClient(hubId)
    }
  }, [hubs, defaultHubId])

  return <FederationContext.Provider value={value}>{children}</FederationContext.Provider>
}

/** Registry access — the hub list + default id + resolver. */
export function useFederation(): FederationContextValue {
  const ctx = useContext(FederationContext)
  if (!ctx) throw new Error('useFederation must be used within a FederationProvider')
  return ctx
}

/** Non-throwing read — for surfaces that may render outside federation (fork). */
export function useFederationOrNull(): FederationContextValue | null {
  return useContext(FederationContext)
}

export type FederatedRootProps = {
  /** Appends `?windowId=N` (and any per-hub query) to a hub's ws url. Same
   *  host-injected closure `main.tsx` passes to `FederationProvider` today. */
  decorateUrl?: (url: string) => string
  children: ReactNode
}

/**
 * Boot wires `hubs`/`defaultHubId`/`tokens` into `useHubRegistryStore` once
 * (see `main.tsx`); this component is the seam that turns a later live store
 * update (fresh tokens after a hub sign-in) into an actual re-render of
 * `FederationProvider` — the single `createRoot().render()` call at boot has
 * no other way to receive post-boot updates.
 */
export function FederatedRoot({ decorateUrl, children }: FederatedRootProps): ReactNode {
  const hubs = useHubRegistryStore((s) => s.hubs)
  const defaultHubId = useHubRegistryStore((s) => s.defaultHubId)
  const tokens = useHubRegistryStore((s) => s.tokens)
  return (
    <FederationProvider
      hubs={hubs}
      defaultHubId={defaultHubId}
      decorateUrl={decorateUrl}
      tokens={tokens}
    >
      {children}
    </FederationProvider>
  )
}
