// What the `app.usage` router needs from its host: the provider HTTP fetch (Electron
// `net.fetch`). Members of api's `AppDeps` (built from `UsageHost`, so there is one
// contract); api wires this seam at load to read its registry live on every call
// (`api/src/domain-router-deps.ts`). This domain never imports `@slayzone/api`.
import type { ProviderUsage, UsageProviderConfig, UsageWindow } from '@slayzone/terminal-contracts'

export type UsageHost = {
  /** Providers are resolved from ctx.db by the caller — usage is an Electron
   *  `net.fetch` over rows that live in the database, so each half runs where it
   *  belongs instead of dragging a DB handle onto the host. */
  usageFetch: (
    providers: {
      customRows: { id: string; label: string; usage_config: string }[]
      builtinEnabled: Record<string, boolean>
    },
    force?: boolean
  ) => Promise<ProviderUsage[]>
  usageTest: (
    config: UsageProviderConfig
  ) => Promise<{ ok: boolean; windows?: UsageWindow[]; error?: string }>
}

export type UsageRouterDeps = {
  /** The host, read on every call (the registry may be set late). */
  getHost: () => UsageHost
}

let deps: UsageRouterDeps | null = null

export function setUsageRouterDeps(next: UsageRouterDeps): void {
  deps = next
}

export function getUsageHost(): UsageHost {
  if (!deps)
    throw new Error(
      'usage router deps not initialized — @slayzone/api wires them when it composes the router'
    )
  return deps.getHost()
}
