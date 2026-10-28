/**
 * Registers the composition's per-procedure tables with the gate chain in
 * `@slayzone/trpc-server` (see its `procedure-policy.ts` for why they are injected):
 *
 *   scope  `SCOPE_POLICY`       (`@slayzone/transport/scopes`, via `isPathAllowed`)
 *   role   `TRPC_ADMIN_POLICY`  (`admin-policy.ts`)
 *   owner  `TRPC_OWNER_POLICY`  (`owner-policy.ts`, decided by `owner-gate.ts`)
 *
 * Side-effect module, imported by `router.ts`: an `appRouter` cannot exist without
 * it. The lookups read the tables live (tests add stand-in entries).
 *
 * @module api/procedure-policy
 */
import { setProcedurePolicy } from '@slayzone/trpc-server'
import { isPathAllowed } from '@slayzone/transport/scopes'
import { TRPC_ADMIN_POLICY } from './admin-policy'
import { checkOwnership, ownedResult } from './owner-gate'

setProcedurePolicy({
  scopeAllows: isPathAllowed,
  adminClassOf: (path) => TRPC_ADMIN_POLICY[path],
  ownerCheck: async (req) => {
    const check = await checkOwnership(req)
    return check ? (data) => ownedResult(check, data) : null
  }
})
