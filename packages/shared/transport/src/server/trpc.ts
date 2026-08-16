import { initTRPC, TRPCError } from '@trpc/server'
import superjson from 'superjson'
import type { TrpcContext } from './context'
import { getAuthGate } from './app-deps'
import { isPathAllowed } from './scopes'

const t = initTRPC.context<TrpcContext>().create({
  transformer: superjson
})

export const router = t.router
export const middleware = t.middleware
export const mergeRouters = t.mergeRouters

/**
 * Multi-hub auth gate. On a hub that enforces auth (`getAuthGate()` true — set
 * when the hub runs in remote mode, `SLAYZONE_MODE=remote`), a connection with no
 * verified principal is rejected UNAUTHORIZED. When the gate is off (local loopback /
 * non-authed remote — the default), this is a straight pass-through, so every
 * existing procedure is byte-identical to the pre-auth server.
 *
 * The connection is still ACCEPTED at the socket level (see createContext) so
 * the client can reach the open `hub.describe` to discover that login is
 * required; only gated procedures 401.
 */
const authGate = t.middleware(({ ctx, next }) => {
  if (getAuthGate() && !ctx.principal) {
    throw new TRPCError({ code: 'UNAUTHORIZED', message: 'hub requires authentication' })
  }
  return next()
})

/**
 * Capability scope gate — see `scopes.ts` for the full design. Chained AFTER
 * `authGate`, so by the time this runs on an enforcing hub, `ctx.principal` is
 * already guaranteed non-null (a null principal already 401'd above).
 *
 * INERT WHEN THE AUTH GATE ITSELF IS OFF — same short-circuit `authGate` uses,
 * checked FIRST and independently of `ctx.principal`. This is what keeps a
 * local/supervised/e2e hub byte-identical to before scopes existed: no
 * principal, no scopes, no check, full router reachable exactly as today.
 *
 * A `full`-scoped principal (every existing client: desktop, CLI, a co-located
 * `slay` using the bootstrap-owner token) is admitted for EVERY path —
 * `isPathAllowed` short-circuits on `full` before consulting `SCOPE_POLICY` at
 * all, so this is the second byte-identical guarantee for anything that isn't
 * a brand-new scoped session.
 *
 * An UNCLASSIFIED path (not in `SCOPE_POLICY`) is refused even for a scoped
 * principal that would otherwise qualify — `scopes.test.ts` asserts no live
 * path is ever in that state, but the runtime fail-closed exists independently
 * of that test passing.
 */
const scopeGate = t.middleware(({ ctx, next, path }) => {
  if (!getAuthGate()) return next()
  const scopes = ctx.principal?.scopes ?? []
  if (!isPathAllowed(scopes, path)) {
    throw new TRPCError({ code: 'FORBIDDEN', message: `insufficient scope for ${path}` })
  }
  return next()
})

/**
 * Default procedure — auth-gated on an authed hub, then scope-gated. All app
 * routers use this, so both enforcements are automatic + fail-closed (a new
 * procedure is gated by default, and unclassified by default until someone
 * adds it to `SCOPE_POLICY` — see that file's exhaustiveness test).
 */
export const publicProcedure = t.procedure.use(authGate).use(scopeGate)

/**
 * Ungated procedure for pre-auth discovery ONLY (`hub.describe`) — the client
 * must reach it to learn a hub `authRequired`, before it has a token. Use
 * sparingly; anything reachable here is exposed on an authed hub without a
 * principal.
 */
export const openProcedure = t.procedure
