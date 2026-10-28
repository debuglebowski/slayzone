/**
 * The runtime half of the account-role gate (T-15); the classification is
 * `access-class.ts` (tables: `@slayzone/api`'s `admin-policy.ts`). One refusal shape for every surface: a stable code
 * ({@link ADMIN_ONLY}) and one `authz.denied` audit line with
 * `detail.reason: 'not_admin'` (the reason `/api/hub/users` already writes).
 *
 * @module trpc-server/admin-gate
 */
import { TRPCError } from '@trpc/server'
import { securityEvent } from '@slayzone/platform/security-log'
import { ADMIN_ONLY } from './access-class'
import { getAuthGate } from './auth-gate'
import type { TrpcContext } from './context'

/** The cause of a role refusal; tRPC's error formatter turns it into `data.appCode`. */
export class AdminOnlyError extends Error {
  readonly code = ADMIN_ONLY

  constructor(readonly target: string) {
    super(`${target} needs a hub admin account`)
    this.name = 'AdminOnlyError'
  }
}

/** `instanceof`, plus a structural fallback for an error from another module copy. */
export function isAdminOnlyError(err: unknown): err is AdminOnlyError {
  if (err instanceof AdminOnlyError) return true
  return (
    err instanceof Error &&
    err.name === 'AdminOnlyError' &&
    (err as { code?: unknown }).code === ADMIN_ONLY
  )
}

/** The audit line for a role refusal. Actor, ip and route come from the context
 *  unless given (a REST route runs outside it, see `@slayzone/api`'s `admin-routes.ts`). */
export function auditAdminDenied(opts: {
  targetKind?: 'procedure' | null
  targetId?: string | null
  actor?: string | null
  ip?: string | null
  route?: string | null
  detail?: Record<string, unknown>
}): void {
  securityEvent({
    event: 'authz.denied',
    outcome: 'denied',
    targetKind: opts.targetKind ?? null,
    targetId: opts.targetId ?? null,
    actor: opts.actor,
    ip: opts.ip,
    route: opts.route,
    detail: { reason: 'not_admin', code: ADMIN_ONLY, ...opts.detail }
  })
}

/** Audit, then the tRPC error a refused procedure throws. */
export function adminOnlyTrpcError(path: string): TRPCError {
  auditAdminDenied({ targetKind: 'procedure', targetId: path })
  return new TRPCError({
    code: 'FORBIDDEN',
    message: `${path} needs a hub admin account`,
    cause: new AdminOnlyError(path)
  })
}

/**
 * For a `CONDITIONAL_ADMIN` handler (`@slayzone/api`'s `admin-policy.ts`): does the role matter for this call, and
 * is the caller not an admin? False on a hub without login (no principal, nothing
 * to check — the desktop app's hub), the same short-circuit as the gate.
 */
export function callerIsNotAdmin(ctx: Pick<TrpcContext, 'principal'>): boolean {
  return getAuthGate() && ctx.principal?.role !== 'admin'
}
