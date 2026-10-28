// What this domain's routers need from their host, injected so the domain never
// imports `@slayzone/api`: the caller's project scope, decided by api's owner gate
// (`owner-gate.ts`, over `access.ts`). api wires this seam at load
// (`api/src/domain-router-deps.ts`).
import type { TrpcContext } from '@slayzone/trpc-server'

export type UsageAnalyticsRouterDeps = {
  /** The ids of the projects the caller may access, or null when nothing is
   *  restricted (a hub without login). */
  ownedProjectIds: (
    ctx: Pick<TrpcContext, 'db' | 'principal' | 'dataRoot'>
  ) => Promise<string[] | null>
}

let deps: UsageAnalyticsRouterDeps | null = null

export function setUsageAnalyticsRouterDeps(next: UsageAnalyticsRouterDeps): void {
  deps = next
}

export function getUsageAnalyticsRouterDeps(): UsageAnalyticsRouterDeps {
  if (!deps)
    throw new Error(
      'usage-analytics router deps not initialized — @slayzone/api wires them when it composes the router'
    )
  return deps
}
