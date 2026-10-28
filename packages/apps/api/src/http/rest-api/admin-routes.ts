import type { Express, NextFunction, Request, Response } from 'express'
import { peerAddress, routeOf } from '@slayzone/platform/security-log'
import { ADMIN_ONLY, REST_ADMIN_POLICY, roleAllows, type AccessClass } from '../../admin-policy'
import { auditAdminDenied } from '@slayzone/trpc-server'
import { restPrincipalOf } from './principal'

/**
 * The account-role gate (T-15) for `/api/*`, applied PER ROUTE AT REGISTRATION:
 * {@link withAdminGate} wraps the express app that every `register*Route` receives,
 * so each `app.get/post/put/patch/delete(path, …)` gets a guard for exactly
 * `METHOD path` — the key `REST_ADMIN_POLICY` classifies. No route can be added
 * without passing through it, and no second matcher can drift from express's own
 * (`/api/tasks/search` vs `/api/tasks/:id` resolve exactly as express resolves them).
 *
 * The guard reads the principal the hub's bearer gate bound to the request
 * (`restPrincipalOf`). None bound = nothing to check: a hub without login (the
 * desktop app's), or a path the bearer gate does not verify — open by design, or one
 * that verifies its caller itself (`/api/hub/users`, `/api/computers/join-token`),
 * which then also checks the role itself.
 *
 * @module transport/rest-api/admin-routes
 */

const ROUTE_METHODS: ReadonlySet<string> = new Set(['get', 'post', 'put', 'patch', 'delete'])

/** `REST_ADMIN_POLICY`'s key for a registration. */
export function restRouteKey(method: string, path: string): string {
  return `${method.toUpperCase()} ${path}`
}

/**
 * 403 `{ ok: false, error, code: 'ADMIN_ONLY' }` (the REST switch-refusal shape) and
 * one `authz.denied` line when a non-admin account calls an `admin` route, or one
 * nobody classified (fail closed).
 */
export function adminRouteGuard(
  key: string,
  policy: Readonly<Record<string, AccessClass>> = REST_ADMIN_POLICY
): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    const principal = restPrincipalOf(req)
    if (!principal || roleAllows(policy[key], principal.role)) {
      next()
      return
    }
    // Explicit actor/ip/route: a handler can run outside the gate's async context.
    auditAdminDenied({
      actor: principal.userId,
      ip: peerAddress(req),
      route: routeOf(req.method, req.originalUrl ?? req.url),
      detail: { status: 403 }
    })
    res.status(403).json({ ok: false, error: `${key} needs a hub admin account`, code: ADMIN_ONLY })
  }
}

/**
 * The app every REST route is registered on, with {@link adminRouteGuard} put in
 * front of each route's handlers. A route registered with anything but a string path
 * throws at boot: it could not be classified.
 */
export function withAdminGate(
  app: Express,
  policy: Readonly<Record<string, AccessClass>> = REST_ADMIN_POLICY
): Express {
  return new Proxy(app, {
    get(target, prop, receiver) {
      const value: unknown = Reflect.get(target, prop, receiver)
      if (typeof prop !== 'string' || !ROUTE_METHODS.has(prop) || typeof value !== 'function') {
        return value
      }
      return (path: unknown, ...handlers: unknown[]) => {
        // `app.get('name')` with no handler is express's settings getter, not a route.
        if (handlers.length === 0) return value.call(target, path)
        if (typeof path !== 'string') {
          throw new Error(`REST route ${prop.toUpperCase()} must use a string path (role gate)`)
        }
        return value.call(
          target,
          path,
          adminRouteGuard(restRouteKey(prop, path), policy),
          ...handlers
        )
      }
    }
  })
}
