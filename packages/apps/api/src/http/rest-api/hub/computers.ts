import type { Express } from 'express'
import { getComputer, revokeComputer, unrevokeComputer } from '@slayzone/computers/server'
import { peerAddress, routeOf, securityEvent } from '@slayzone/platform/security-log'
import { getAuthGate } from '@slayzone/trpc-server'
import { mayManageComputer } from '../../../computer-access'
import { httpAccessRequest } from '../../owner-scope'
import { restPrincipalOf } from '../principal'
import type { RestApiDeps } from '../types'

/**
 * REST: `PATCH /api/hub/computers` `{ id, revoked: true | false }` — revoke a computer,
 * or undo it, behind `slay hub computers revoke|unrevoke`. The REST twin of
 * `computers.revokeComputer` / `computers.unrevoke` for callers with no tRPC client: the
 * CLI, and a break-glass session (apps/hub break-glass.ts), which only REST admits.
 *
 * ADMIN ONLY (`REST_ADMIN_POLICY`, T-15), behind the hub's bearer gate like every other
 * `/api/*` route. Within that, T-19's management rule decides (`computer-access.ts`
 * `mayManageComputer`: for an admin, any existing computer, unowned included); a computer
 * it does not cover is 404, as the owner gates answer. Revoking is management, never use:
 * the caller gains nothing on the computer (O-6).
 *
 * Revoking also drops the live connection: the computer would otherwise keep working
 * until it reconnects (with a key the hub then refuses — `revoked_at` is checked on every
 * hello), as disabling its owner does (user-access.ts). Revoked is the reversible state:
 * rows, bindings and grants are kept. The id travels in the body, like `/api/hub/users`'
 * email. One `computer.revoke` / `computer.unrevoke` line, actor from the request.
 */
export function registerHubComputersRoute(app: Express, deps: RestApiDeps): void {
  app.patch('/api/hub/computers', async (req, res) => {
    const body = (req.body ?? {}) as { id?: unknown; revoked?: unknown }
    if (typeof body.id !== 'string' || !body.id || typeof body.revoked !== 'boolean') {
      res.status(400).json({ ok: false, error: 'send { id, revoked: true | false }' })
      return
    }
    const id = body.id
    try {
      const principal = restPrincipalOf(req)
      const manages = await mayManageComputer(
        deps.db,
        {
          ...httpAccessRequest(principal?.userId ?? null),
          authRequired: getAuthGate(),
          role: principal?.role ?? null
        },
        id
      )
      if (!manages || !(await getComputer(deps.db, id))) {
        res.status(404).json({ ok: false, error: `no computer with id ${id}` })
        return
      }
      if (body.revoked) {
        await revokeComputer(deps.db, id)
        deps.computers?.getGateway?.()?.disconnect?.(id, 'computer revoked')
      } else {
        await unrevokeComputer(deps.db, id)
      }
      securityEvent({
        event: body.revoked ? 'computer.revoke' : 'computer.unrevoke',
        outcome: 'success',
        // Explicit: a handler can run outside the gate's async context (admin-routes.ts).
        actor: principal?.userId ?? null,
        ip: peerAddress(req),
        route: routeOf(req.method, req.originalUrl ?? req.url),
        targetKind: 'computer',
        targetId: id
      })
      res.json({ ok: true, data: { id, revoked: body.revoked } })
    } catch (err) {
      res.status(500).json({
        ok: false,
        error: 'failed to change the computer',
        message: err instanceof Error ? err.message : String(err)
      })
    }
  })
}
