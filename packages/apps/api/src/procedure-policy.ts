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
import { TRPCError } from '@trpc/server'
import { setProcedurePolicy } from '@slayzone/trpc-server'
import { isPathAllowed } from '@slayzone/transport/scopes'
import { TRPC_ADMIN_POLICY } from './admin-policy'
import { checkOwnership, ownedResult } from './owner-gate'
import { confineTaskFileCall } from './task-file-confinement'
import { getAuthGate } from '@slayzone/trpc-server'
import { TRPC_OWNER_POLICY, resourcesIn } from './owner-policy'
import { assertNotMoving, MOVE_LOCK_EXEMPT, TaskMovingError } from './move-lock'

setProcedurePolicy({
  scopeAllows: isPathAllowed,
  adminClassOf: (path) => TRPC_ADMIN_POLICY[path],
  ownerCheck: async (req) => {
    const check = await checkOwnership(req)
    // After the owner gate: the `files` scope's task confinement (inert without login).
    if (getAuthGate()) {
      await confineTaskFileCall({
        db: req.ctx.db,
        scopes: req.ctx.principal?.scopes ?? [],
        path: req.path,
        getRawInput: req.getRawInput
      })
    }
    return check ? (data) => ownedResult(check, data) : null
  },
  // The move lock (move-lock.ts): the resources the owner rule lists, login or not.
  moveLockCheck: async (req) => {
    const rule = TRPC_OWNER_POLICY[req.path]
    if (!rule || MOVE_LOCK_EXEMPT.has(req.path)) return
    try {
      await assertNotMoving(req.ctx.db, resourcesIn(await req.getRawInput(), rule))
    } catch (err) {
      if (err instanceof TaskMovingError)
        throw new TRPCError({ code: 'PRECONDITION_FAILED', message: err.message, cause: err })
      throw err
    }
  }
})
