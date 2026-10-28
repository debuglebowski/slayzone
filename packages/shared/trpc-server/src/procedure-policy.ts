/**
 * The per-procedure policy the gate chain in `trpc.ts` enforces, injected by the
 * composition.
 *
 * WHY INJECTED. The three tables a gate consults — `SCOPE_POLICY` (capability
 * scope), `TRPC_ADMIN_POLICY` (account role) and `TRPC_OWNER_POLICY` (ownership) —
 * each name EVERY router's paths, and ownership is decided against every domain's
 * rows (`@slayzone/api`'s `access.ts`). That is composition data: it can only live
 * where all routers are known, i.e. `@slayzone/api`. This package sits BELOW the
 * domains (so a domain can build its router from these builders without depending
 * on `api`), so it holds the mechanism and api registers the data at load time —
 * `@slayzone/api`'s `procedure-policy.ts`, imported by `router.ts`, so an
 * `appRouter` cannot exist without it.
 *
 * INERT WITHOUT LOGIN. Every gate checks `getAuthGate()` first and never reads the
 * policy when it is off (the desktop app's own hub), so there the chain needs no
 * registration at all and is byte-identical to before.
 *
 * FAIL CLOSED. On a hub with login and nothing registered, {@link procedurePolicy}
 * throws, so every gated call fails (INTERNAL_SERVER_ERROR) instead of running
 * unchecked.
 *
 * @module trpc-server/procedure-policy
 */
import type { AccessClass } from './access-class'
import type { TrpcContext } from './context'
import type { Scope } from './scope'

/** What the owner gate passes to {@link ProcedurePolicy.ownerCheck}. */
export interface OwnerCheckRequest {
  ctx: TrpcContext
  path: string
  type: 'query' | 'mutation' | 'subscription'
  getRawInput: () => Promise<unknown>
}

/**
 * Applied to a successful handler result: the part of it the caller may see (a list
 * cut to the caller's rows, a subscription wrapped to decide each event).
 */
export type OwnedResultFilter = (data: unknown) => Promise<unknown>

export interface ProcedurePolicy {
  /** The scope gate: may a principal holding `scopes` call `path`? (`isPathAllowed`) */
  scopeAllows(scopes: readonly Scope[], path: string): boolean
  /** The role gate: the procedure's class; `undefined` = unclassified (admin only). */
  adminClassOf(path: string): AccessClass | undefined
  /**
   * The owner gate, before the handler: throws the refusal, or returns the filter for
   * the result, or null when there is nothing to enforce for this call.
   */
  ownerCheck(req: OwnerCheckRequest): Promise<OwnedResultFilter | null>
}

let registered: ProcedurePolicy | null = null

/** Called once by the composition (`@slayzone/api`). A later call replaces it. */
export function setProcedurePolicy(policy: ProcedurePolicy): void {
  registered = policy
}

/** The registered policy. Throws when none is: a gate must not run unchecked. */
export function procedurePolicy(): ProcedurePolicy {
  if (!registered) {
    throw new Error(
      'tRPC procedure policy not registered: import the composition (@slayzone/api router.ts) before serving'
    )
  }
  return registered
}
