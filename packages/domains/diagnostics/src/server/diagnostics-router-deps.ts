// What the `diagnostics` router needs from its host, injected so this domain never
// imports `@slayzone/api`. Who may access a task, agent session or project is api's
// ownership policy (`access.ts` + `owner-gate.ts`, shared with every router still in
// api), so api wires this seam at load (`api/src/domain-router-deps.ts`).
import type { TrpcContext } from '@slayzone/trpc-server'

/** A resource a diagnostics event can name. */
export type DiagnosticsNamedResource = {
  readonly kind: 'task' | 'session' | 'project'
  readonly id: string
}

/** One request's access decisions, memoized for that request. */
export type DiagnosticsAccessScope = {
  /** False when the hub has no login: every check passes without a query. */
  readonly enforcing: boolean
  /** Every resource allowed (an empty list: true). */
  allowsAll(resources: readonly DiagnosticsNamedResource[]): Promise<boolean>
}

export type DiagnosticsRouterDeps = {
  /** The calling request's access scope (api's `createAccessScope` for its principal). */
  accessScopeFor: (ctx: TrpcContext) => DiagnosticsAccessScope
}

let deps: DiagnosticsRouterDeps | null = null

export function setDiagnosticsRouterDeps(next: DiagnosticsRouterDeps): void {
  deps = next
}

export function getDiagnosticsRouterDeps(): DiagnosticsRouterDeps {
  if (!deps)
    throw new Error(
      'diagnostics router deps not initialized — @slayzone/api wires them when it composes the router'
    )
  return deps
}
