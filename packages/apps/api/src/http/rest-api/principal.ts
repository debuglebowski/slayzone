import type { IncomingMessage } from 'node:http'
import type { RestPrincipal } from './types'

/**
 * The verified principal of one REST request — the `/api/*` twin of tRPC's
 * `ctx.principal`.
 *
 * The hub's bearer gate (`withRestAuth`, apps/hub rest-auth.ts) verifies the
 * credential and binds the result to the request object here; a route handler
 * reads it back with {@link restPrincipalOf}. Keyed on the request object itself
 * (express hands handlers the same `IncomingMessage` the gate saw), in a WeakMap
 * so it dies with the request. Not AsyncLocalStorage: the body parser's stream
 * callbacks do not reliably run inside the gate's async context.
 *
 * Null whenever the gate let the request through without verifying anyone — a
 * hub without login, or a path that is open by design. That null is exactly the
 * "no user attached" case the callers treat as such (e.g. a project with no owner).
 */
const principals = new WeakMap<IncomingMessage, RestPrincipal>()

export function bindRestPrincipal(req: IncomingMessage, principal: RestPrincipal): void {
  principals.set(req, principal)
}

export function restPrincipalOf(req: IncomingMessage): RestPrincipal | null {
  return principals.get(req) ?? null
}
