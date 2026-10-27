/**
 * Which `settings.set` writes need a hub admin (T-15): the hub-wide keys. Per-user
 * keys (view state, layout, filters) stay writable by every user, or nobody could
 * save their own UI state.
 *
 * And which a scoped session may make at all (#164): the scope gate is per
 * procedure and admits `settings.set` for `tasks`, so the per-key half is here — a
 * scoped credential writes only its own (`user`) keys, whatever the account's role.
 *
 * @module transport/server/routers/settings-admin
 */
import { TRPCError } from '@trpc/server'
import { securityEvent } from '@slayzone/platform/security-log'
import { settingScope } from '@slayzone/settings/server'
import { adminOnlyTrpcError, callerIsNotAdmin } from '../admin-gate'
import { getAuthGate } from '../app-deps'
import type { TrpcContext } from '../context'
import { publicProcedure } from '../trpc'

/**
 * Whether writing `key` needs a hub admin: every key that is not one user's own.
 * `internal` keys are included: the settings service refuses them to everyone
 * anyway, and the refusal should not depend on that.
 */
export function settingWriteNeedsAdmin(key: string): boolean {
  return settingScope(key) !== 'user'
}

/**
 * A scoped (non-`full`) principal on a hub that enforces scopes — the scope gate's
 * own condition (`trpc.ts`). Null otherwise.
 */
function scopedPrincipal(ctx: TrpcContext): NonNullable<TrpcContext['principal']> | null {
  const p = ctx.principal
  return getAuthGate() && p && !p.scopes.includes('full') ? p : null
}

/** Audit, then the scope gate's refusal, naming the key. */
function scopeTrpcError(path: string, key: string, scopes: readonly string[]): TRPCError {
  securityEvent({
    event: 'authz.denied',
    outcome: 'denied',
    targetKind: 'procedure',
    targetId: path,
    detail: { reason: 'scope', setting: key, scopes }
  })
  return new TRPCError({ code: 'FORBIDDEN', message: `insufficient scope for ${path} (${key})` })
}

/**
 * `publicProcedure` plus the key checks, for `settings.set`: a scoped session writes
 * only `user` keys; a non-admin account writes no hub-wide one. Reads the raw input
 * because it runs before the router's own `.input()` parser; a malformed input is
 * left for that parser to reject.
 */
export const settingsWriteProcedure = publicProcedure.use(
  async ({ ctx, path, getRawInput, next }) => {
    const scoped = scopedPrincipal(ctx)
    if (scoped || callerIsNotAdmin(ctx)) {
      const key = ((await getRawInput()) as { key?: unknown } | undefined)?.key
      if (typeof key === 'string' && settingWriteNeedsAdmin(key)) {
        if (scoped) throw scopeTrpcError(path, key, scoped.scopes)
        throw adminOnlyTrpcError(path)
      }
    }
    return next()
  }
)
