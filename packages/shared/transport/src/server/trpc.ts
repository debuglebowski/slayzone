import { initTRPC, TRPCError } from '@trpc/server'
import superjson from 'superjson'
import type { TrpcContext } from './context'
import { getAuthGate } from './app-deps'

const t = initTRPC.context<TrpcContext>().create({
  transformer: superjson
})

export const router = t.router
export const middleware = t.middleware
export const mergeRouters = t.mergeRouters

/**
 * Multi-hub auth gate. On a hub that enforces auth (`getAuthGate()` true — set
 * only when `SLAYZONE_HUB_AUTH_REQUIRED=1`), a connection with no verified
 * principal is rejected UNAUTHORIZED. When the gate is off (local loopback /
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
 * Default procedure — auth-gated on an authed hub. All app routers use this, so
 * enforcement is automatic + fail-closed (a new procedure is gated by default).
 */
export const publicProcedure = t.procedure.use(authGate)

/**
 * Ungated procedure for pre-auth discovery ONLY (`hub.describe`) — the client
 * must reach it to learn a hub `authRequired`, before it has a token. Use
 * sparingly; anything reachable here is exposed on an authed hub without a
 * principal.
 */
export const openProcedure = t.procedure
