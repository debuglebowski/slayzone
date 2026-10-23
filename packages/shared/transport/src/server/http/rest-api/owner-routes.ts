import type { Express, NextFunction, Request, Response } from 'express'
import type { SlayzoneDb } from '@slayzone/platform'
import { peerAddress, routeOf, runWithSecurityContext } from '@slayzone/platform/security-log'
import { createAccessScope, type AccessScope } from '../../access'
import { REST_ADMIN_POLICY, type AccessClass } from '../../admin-policy'
import { getAuthGate } from '../../app-deps'
import {
  DENY_RESPONSE,
  REST_OWNER_POLICY,
  type HttpOutputFilter,
  type HttpOwnerRule
} from '../../http-owner-policy'
import { isOwnerQuestion } from '../../owner-policy'
import {
  auditOwnerDenied,
  firstDeniedRef,
  httpAccessRequest,
  runInOwnerScope,
  type DeniedRef
} from '../owner-scope'
import { restRouteKey } from './admin-routes'
import { restPrincipalOf } from './principal'

/**
 * The owner gate (T-18) for `/api/*`, applied PER ROUTE AT REGISTRATION exactly like
 * T-15's role gate (`admin-routes.ts`): {@link withOwnerGate} wraps the app every
 * `register*Route` receives, so each route gets {@link ownerRouteGuard} for its own
 * `METHOD path` — the key `REST_OWNER_POLICY` marks — right after the role guard.
 *
 * On a hub with login, for a `user` or `admin` route (T-106: the admin role manages,
 * it never reads another user's content — an admin's automation request on another
 * user's project is decided like anyone's):
 *
 *   before the handler  every id the request names (params, query, body; per the
 *                       policy) must be the caller's: someone else's, missing or
 *                       ownerless answers 404 `{ ok: false, error: 'Not found' }` —
 *                       never 403, a refusal must not say the thing exists — with one
 *                       `authz.denied` line. A route nobody marked is refused (fail
 *                       closed, 403 + audit).
 *   the handler         runs with the caller carried in: the security context (who
 *                       caused its refresh pings, so T-17's stream filter attributes
 *                       them) and the request's access scope, which `resolve.ts` reads
 *                       so an id prefix or a project name only ever matches the
 *                       caller's rows.
 *   after the handler   a list (`output`) is cut to what the caller may access.
 *
 * Inert without login (`getAuthGate()` false — the desktop app's hub): the guard calls
 * `next()` before reading anything and each handler runs as it was registered.
 *
 * @module transport/rest-api/owner-routes
 */

const ROUTE_METHODS: ReadonlySet<string> = new Set(['get', 'post', 'put', 'patch', 'delete'])

/** The scope a guarded request runs under (read by the handler wrapper). */
const requestScopes = new WeakMap<Request, AccessScope>()

function notFound(res: Response): void {
  if (!res.headersSent) res.status(404).json({ ok: false, error: 'Not found' })
}

/** `res.json` through `filter`: a list cut, or a whole response refused. */
function filterJson(
  req: Request,
  res: Response,
  key: string,
  filter: HttpOutputFilter,
  scope: AccessScope,
  actor: string
): void {
  const send = res.json.bind(res)
  res.json = ((body: unknown) => {
    // Error bodies carry nothing to cut; only a success is filtered.
    if (res.statusCode >= 400) return send(body)
    void filter(body, scope).then(
      (out) => {
        if (out === DENY_RESPONSE) {
          auditOwnerDenied({
            target: key,
            reason: 'not_owner',
            actor,
            ip: peerAddress(req),
            route: routeOf(req.method, req.originalUrl ?? req.url),
            status: 404
          })
          notFound(res)
          return
        }
        send(out)
      },
      () => {
        // A filter that throws sends nothing it could not decide (fail closed).
        if (!res.headersSent) res.status(500).json({ ok: false, error: 'Internal error' })
      }
    )
    return res
  }) as Response['json']
}

/** The guard for one route. */
export function ownerRouteGuard(
  key: string,
  db: SlayzoneDb,
  policy: Readonly<Record<string, HttpOwnerRule>> = REST_OWNER_POLICY,
  classes: Readonly<Record<string, AccessClass>> = REST_ADMIN_POLICY
): (req: Request, res: Response, next: NextFunction) => Promise<void> {
  return async (req, res, next) => {
    if (!getAuthGate()) return next()
    // `open` routes are T-15's: no owner question. Every other one is.
    if (!isOwnerQuestion(classes[key])) return next()
    const principal = restPrincipalOf(req)
    const audit = (
      reason: 'not_owner' | 'owner_unclassified' | 'no_principal',
      denied?: DeniedRef,
      status = 404
    ) =>
      auditOwnerDenied({
        target: key,
        reason,
        actor: principal?.userId ?? null,
        ip: peerAddress(req),
        route: routeOf(req.method, req.originalUrl ?? req.url),
        denied,
        status
      })
    const rule = policy[key]
    if (!rule) {
      audit('owner_unclassified', undefined, 403)
      res.status(403).json({ ok: false, error: `${key} has no owner rule (http-owner-policy.ts)` })
      return
    }
    // The hub's bearer gate admits no `/api/*` user route without one; fail closed.
    // The exception names no user content: a route that verifies its caller itself
    // (`/api/hub/users`, `/api/computers/join-token`: the bearer gate binds no
    // principal there, see apps/hub rest-auth.ts `SELF_GUARDED`).
    if (!principal) {
      if (rule.mark === 'no-owned-input') return next()
      audit('no_principal')
      notFound(res)
      return
    }
    const scope = createAccessScope(db, httpAccessRequest(principal.userId))
    if (rule.ids && rule.ids.length > 0) {
      const denied = await firstDeniedRef(db, scope, rule.ids, {
        params: req.params,
        query: req.query,
        body: req.body
      })
      if (denied) {
        audit('not_owner', denied)
        notFound(res)
        return
      }
    }
    requestScopes.set(req, scope)
    if (rule.output) filterJson(req, res, key, rule.output, scope, principal.userId)
    next()
  }
}

type Handler = (req: Request, res: Response, next: NextFunction) => unknown

/**
 * A route handler run with the caller carried in (see the module doc). The context is
 * entered around EACH handler, not once in the guard: a body parser's stream callbacks
 * do not keep an async context, so one set before it would be gone by the handler.
 */
function carried(handler: unknown): unknown {
  if (typeof handler !== 'function') return handler
  const h = handler as Handler
  return (req: Request, res: Response, next: NextFunction) => {
    if (!getAuthGate()) return h(req, res, next)
    const principal = restPrincipalOf(req)
    if (!principal) return h(req, res, next)
    const run = () => h(req, res, next)
    const scope = requestScopes.get(req)
    return runWithSecurityContext(
      {
        actor: principal.userId,
        ip: peerAddress(req),
        route: routeOf(req.method, req.originalUrl ?? req.url)
      },
      () => (scope ? runInOwnerScope(scope, run) : run())
    )
  }
}

/**
 * The app every REST route is registered on, with {@link ownerRouteGuard} put in front
 * of each route's handlers and each handler carried (see {@link carried}). Stack it on
 * the role gate's app (`withAdminGate`), so the order per route is role, owner, route.
 */
export function withOwnerGate(
  app: Express,
  db: SlayzoneDb,
  policy: Readonly<Record<string, HttpOwnerRule>> = REST_OWNER_POLICY,
  classes: Readonly<Record<string, AccessClass>> = REST_ADMIN_POLICY
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
          throw new Error(`REST route ${prop.toUpperCase()} must use a string path (owner gate)`)
        }
        return value.call(
          target,
          path,
          ownerRouteGuard(restRouteKey(prop, path), db, policy, classes),
          ...handlers.map(carried)
        )
      }
    }
  })
}
