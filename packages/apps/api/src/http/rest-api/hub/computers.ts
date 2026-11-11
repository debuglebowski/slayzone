import type { Express, Request } from 'express'
import {
  getComputer,
  isComputerStateError,
  listComputerTakeovers,
  replaceComputer,
  replaceRefusal,
  revokeComputer,
  unrevokeComputer
} from '@slayzone/computers/server'
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
  const managerOf = (req: Request) => {
    const principal = restPrincipalOf(req)
    const access = {
      ...httpAccessRequest(principal?.userId ?? null),
      authRequired: getAuthGate(),
      role: principal?.role ?? null
    }
    return { principal, mayManage: (id: string) => mayManageComputer(deps.db, access, id) }
  }
  const connected = (): Set<string> =>
    new Set((deps.computers?.getGateway?.()?.listComputers() ?? []).map((r) => r.computerId))

  /**
   * `GET /api/hub/computers/takeovers` — the REST twin of `computers.takeovers`
   * (`slay hub computers takeovers`): computers holding chats the hub assigns to an
   * offline computer, each an offer to replace that one with it. Admin only, as the
   * other `/api/hub/computers` routes; within that, the computers it manages.
   */
  app.get('/api/hub/computers/takeovers', async (req, res) => {
    try {
      const live = connected()
      const data = await listComputerTakeovers(
        {
          db: deps.db,
          isConnected: (id) => live.has(id),
          localComputerId: deps.computers?.localComputerId ?? null,
          mayManage: managerOf(req).mayManage
        },
        deps.computers?.takeoverCandidates?.() ?? []
      )
      res.json({ ok: true, data })
    } catch (err) {
      res.status(500).json({
        ok: false,
        error: 'failed to list takeovers',
        message: err instanceof Error ? err.message : String(err)
      })
    }
  })

  /**
   * `POST /api/hub/computers/replace` `{ id, successorId }` — the REST twin of
   * `computers.replace` (`slay hub computers replace <id> --with <successor>`): the
   * former computer's work moves to its successor (the same machine enrolled again),
   * and its row goes. 409 while the former is connected; 400 for the desktop app's own
   * computer, itself or a revoked successor (`code` names which).
   */
  app.post('/api/hub/computers/replace', async (req, res) => {
    const body = (req.body ?? {}) as { id?: unknown; successorId?: unknown }
    if (
      typeof body.id !== 'string' ||
      !body.id ||
      typeof body.successorId !== 'string' ||
      !body.successorId
    ) {
      res.status(400).json({ ok: false, error: 'send { id, successorId }' })
      return
    }
    const { id, successorId } = body
    try {
      const { principal, mayManage } = managerOf(req)
      for (const which of [id, successorId]) {
        if (!(await mayManage(which)) || !(await getComputer(deps.db, which))) {
          res.status(404).json({ ok: false, error: `no computer with id ${which}` })
          return
        }
      }
      const former = (await getComputer(deps.db, id))!
      const live = connected()
      const refusal = replaceRefusal(
        {
          isConnected: (c) => live.has(c),
          localComputerId: deps.computers?.localComputerId ?? null
        },
        former,
        successorId
      )
      const refuse = (status: number, err: { code: string; message: string }) =>
        res.status(status).json({ ok: false, code: err.code, error: err.message })
      if (refusal) {
        refuse(refusal.code === 'PRECONDITION_FAILED' ? 409 : 400, refusal.error)
        return
      }
      try {
        await replaceComputer(deps.db, { computerId: id, successorId })
      } catch (err) {
        if (isComputerStateError(err)) {
          refuse(400, err)
          return
        }
        throw err
      }
      securityEvent({
        event: 'computer.replace',
        outcome: 'success',
        actor: principal?.userId ?? null,
        ip: peerAddress(req),
        route: routeOf(req.method, req.originalUrl ?? req.url),
        targetKind: 'computer',
        targetId: id,
        detail: { successorId }
      })
      res.json({ ok: true, data: { id, successorId } })
    } catch (err) {
      res.status(500).json({
        ok: false,
        error: 'failed to replace the computer',
        message: err instanceof Error ? err.message : String(err)
      })
    }
  })

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
