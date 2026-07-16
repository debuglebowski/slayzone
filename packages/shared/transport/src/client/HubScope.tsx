import { createContext, useContext, type ReactNode } from 'react'
import { QueryClientProvider } from '@tanstack/react-query'
import { TRPCProvider } from './trpc'
import { useFederation } from './FederationProvider'

/**
 * Multi-hub federation — the inner, per-hub provider.
 *
 * Mounts the given hub's QueryClient + tRPC client (resolved from the
 * FederationProvider registry) so any `useTRPC()` / `useTRPCClient()` rendered
 * inside resolves to THAT hub — nearest provider wins. Wrap a project board or a
 * task tab's content in the HubScope of its owning hub and the whole subtree
 * transparently talks to the right hub with no call-site changes.
 *
 * The active hub id is also exposed via context so hub-aware leaf code (Phase 4:
 * tab persistence, terminal reconcile) can read "which hub am I in" without
 * threading a prop.
 */

const HubIdContext = createContext<string | null>(null)

export type HubScopeProps = {
  hubId: string
  /** Rendered when the hub id is unknown or has no url (e.g. an offline remote
   *  the registry lists but can't resolve). Defaults to nothing. */
  fallback?: ReactNode
  children: ReactNode
}

export function HubScope({ hubId, fallback = null, children }: HubScopeProps): ReactNode {
  const { resolve } = useFederation()
  const resolved = resolve(hubId)
  if (!resolved) return <>{fallback}</>
  return (
    <HubIdContext.Provider value={hubId}>
      <QueryClientProvider client={resolved.queryClient}>
        <TRPCProvider trpcClient={resolved.ws.client} queryClient={resolved.queryClient}>
          {children}
        </TRPCProvider>
      </QueryClientProvider>
    </HubIdContext.Provider>
  )
}

/** The hub id of the nearest HubScope, or null when rendered outside one. */
export function useHubId(): string | null {
  return useContext(HubIdContext)
}
