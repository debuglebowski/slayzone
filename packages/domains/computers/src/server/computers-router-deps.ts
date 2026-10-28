// What the `computers` router needs from its host, injected so this domain never
// imports `@slayzone/api`. Who may manage a computer is api's ownership policy
// (`computer-access.ts` over `access.ts` + `owner-gate.ts`, shared with the REST
// routes and the routers still in api), so api wires this seam at load
// (`api/src/domain-router-deps.ts`).
import type { TrpcContext } from '@slayzone/trpc-server'

/**
 * One request's computer MANAGEMENT decisions (T-19): the owner, or an admin, who
 * sees every computer for management only. Binding work to a computer is not
 * management (that is the owner gate's `computer` check, owner only).
 */
export type ComputerManagerAccess = {
  /** False on a hub without login: every answer is yes, before any query. */
  readonly enforcing: boolean
  /** Whether this request may manage the computer. */
  mayManage(computerId: string): Promise<boolean>
  /** The rows of a computer list this request may see (management view). */
  filterManaged<T extends { id: string }>(rows: readonly T[]): Promise<T[]>
}

export type ComputersRouterDeps = {
  /** The calling request's management access (api's `computer-access.ts` for its
   *  principal and role). */
  managerAccessFor: (
    ctx: Pick<TrpcContext, 'db' | 'principal' | 'dataRoot'>
  ) => ComputerManagerAccess
}

let deps: ComputersRouterDeps | null = null

export function setComputersRouterDeps(next: ComputersRouterDeps): void {
  deps = next
}

export function getComputersRouterDeps(): ComputersRouterDeps {
  if (!deps)
    throw new Error(
      'computers router deps not initialized — @slayzone/api wires them when it composes the router'
    )
  return deps
}
