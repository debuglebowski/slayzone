import { initTRPC, TRPCError } from '@trpc/server'
import superjson from 'superjson'
import { peerAddress, runWithSecurityContext, securityEvent } from '@slayzone/platform/security-log'
import {
  assertHubLocalExecEnabled,
  isHubSwitchedOffError
} from '@slayzone/platform/hub-switch-refusal'
import type { TrpcContext } from './context'
import { getAuthGate } from './app-deps'
import { isPathAllowed } from './scopes'
import { ADMIN_ONLY, roleAllows, TRPC_ADMIN_POLICY } from './admin-policy'
import { adminOnlyTrpcError, isAdminOnlyError } from './admin-gate'

const t = initTRPC.context<TrpcContext>().create({
  transformer: superjson,
  // A hub-switch refusal carries its stable code (`HUB_PROCESSES_DISABLED`, …) to the
  // client as `data.appCode`; every other error keeps its shape exactly.
  errorFormatter: ({ shape, error }) => ({
    ...shape,
    data: {
      ...shape.data,
      ...(isHubSwitchedOffError(error.cause) ? { appCode: error.cause.code } : {}),
      // A role refusal (T-15) carries `ADMIN_ONLY` the same way.
      ...(isAdminOnlyError(error.cause) ? { appCode: ADMIN_ONLY } : {})
    }
  })
})

export const router = t.router
export const middleware = t.middleware
export const mergeRouters = t.mergeRouters

/**
 * Who is calling, for the audit lines this call writes (T-03). Runs first, so the
 * gate refusals below and every hub → computer call the procedure makes further
 * down (`computer.pty.spawn`, …) carry the caller's user id, peer address and
 * procedure path. A no-op for behavior: it only sets the async context.
 */
const securityContext = t.middleware(({ ctx, next, path }) =>
  runWithSecurityContext(
    { actor: ctx.principal?.userId ?? null, ip: peerAddress(ctx.req), route: `trpc ${path}` },
    () => next()
  )
)

/** One `authz.denied` line for a gate refusal; actor/ip/route come from the context. */
function auditDenied(path: string, detail: Record<string, unknown>): void {
  securityEvent({
    event: 'authz.denied',
    outcome: 'denied',
    targetKind: 'procedure',
    targetId: path,
    detail
  })
}

/**
 * Multi-hub auth gate. On a hub that enforces auth (`getAuthGate()` true — set
 * when the hub requires login, `SLAYZONE_HUB_REQUIRE_LOGIN=1`), a connection with no
 * verified principal is rejected UNAUTHORIZED. When the gate is off (login not
 * required — the default, and the desktop app's hub), this is a straight pass-through, so every
 * existing procedure is byte-identical to the pre-auth server.
 *
 * The connection is still ACCEPTED at the socket level (see createContext) so
 * the client can reach the open `hub.describe` to discover that login is
 * required; only gated procedures 401.
 */
const authGate = t.middleware(({ ctx, next, path }) => {
  if (getAuthGate() && !ctx.principal) {
    auditDenied(path, { reason: 'unauthenticated' })
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
    auditDenied(path, { reason: 'scope', scopes })
    throw new TRPCError({ code: 'FORBIDDEN', message: `insufficient scope for ${path}` })
  }
  return next()
})

/**
 * Account-role gate (T-15) — see `admin-policy.ts`. A non-admin account calling an
 * `admin` procedure (or an unclassified one: fail closed) gets FORBIDDEN with
 * `data.appCode: 'ADMIN_ONLY'` and one `authz.denied` line.
 *
 * Inert when the auth gate is off, exactly like the scope gate: the desktop app's
 * own hub (`SLAYZONE_HUB_REQUIRE_LOGIN=0`) has no principal and no role, so it keeps
 * full access. On an enforcing hub `authGate` already refused a null principal.
 *
 * Runs before the scope gate: both refuse with FORBIDDEN, and either order admits
 * exactly the calls that pass both.
 */
const adminGate = t.middleware(({ ctx, next, path }) => {
  if (!getAuthGate()) return next()
  if (!roleAllows(TRPC_ADMIN_POLICY[path], ctx.principal?.role ?? 'user')) {
    throw adminOnlyTrpcError(path)
  }
  return next()
})

/**
 * Work a hub switch turned off (`SLAYZONE_HUB_ENABLE_PROCESSES=0`, …) is refused by
 * a chokepoint deep in a domain, which audits and throws `HubSwitchedOffError`.
 * Surface it as FORBIDDEN with the same message wherever it was thrown, instead of
 * the INTERNAL_SERVER_ERROR an unknown throw becomes.
 */
const switchRefusal = t.middleware(async ({ next }) => {
  const result = await next()
  if (!result.ok && isHubSwitchedOffError(result.error.cause)) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: result.error.cause.message,
      cause: result.error.cause
    })
  }
  return result
})

/**
 * Default procedure — auth-gated on an authed hub, then role- and scope-gated. All app
 * routers use this, so both enforcements are automatic + fail-closed (a new
 * procedure is gated by default, and unclassified by default until someone
 * adds it to `SCOPE_POLICY` — see that file's exhaustiveness test).
 */
export const publicProcedure = t.procedure
  .use(securityContext)
  .use(authGate)
  .use(adminGate)
  .use(scopeGate)
  .use(switchRefusal)

/**
 * A procedure that works on the hub's OWN disk — git, `gh` probes, the OS opener,
 * project files — with no computer route (the git panel today). Refused up front,
 * with the same FORBIDDEN + `NO_COMPUTER_CONNECTED` a refusal deeper down gets, when
 * `SLAYZONE_HUB_ENABLE_PROCESSES=0` (T-06): such a hub never touches project data.
 * Up front because several of these helpers swallow errors into a default (`false`,
 * `[]`), which would hide the refusal from the client. The exec seams refuse too, so
 * a caller that skips this gate still spawns nothing.
 */
export const hubLocalProcedure = publicProcedure.use(({ next, path }) => {
  assertHubLocalExecEnabled({ op: path })
  return next()
})

/**
 * Ungated procedure for pre-auth discovery ONLY (`hub.describe`) — the client
 * must reach it to learn a hub `authRequired`, before it has a token. Use
 * sparingly; anything reachable here is exposed on an authed hub without a
 * principal.
 */
export const openProcedure = t.procedure.use(securityContext)
