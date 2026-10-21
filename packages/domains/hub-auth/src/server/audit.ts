/**
 * Security audit lines for hub-auth (T-03): better-auth's sign-in, sign-out,
 * sessions and password change, plus the operator account commands in `users.ts`.
 *
 * Two better-auth seams, both wired in `auth.ts`:
 *   - `hooks.after` ({@link auditAuthResponse}) — runs after an ENDPOINT, for HTTP
 *     requests and in-process `auth.api.*` calls alike (the web-login route signs in
 *     in-process). A thrown `APIError` arrives as `ctx.context.returned`, so the
 *     failure code is readable here. Sign-in and password change are logged here.
 *   - `databaseHooks.session` ({@link auditDatabaseHooks}) — runs per session ROW
 *     created or deleted, whatever caused it: sign-in, sign-out, revoke-session(s),
 *     `disableHubUser`'s sweep, or the cleanup of an expired row found on lookup. The
 *     endpoint context, when there is one, says which.
 *
 * A sign-in refused because the account is disabled is logged once, by the session
 * guard in `account.ts` (outcome `denied`), not again here.
 *
 * The client address and route come from the request context the hub's REST gate
 * sets (`runWithSecurityContext`); better-auth itself is handed none.
 *
 * Never logged: the email (a failed attempt carries `subjectRef`, a keyed hash of
 * it), the password, the session token. Shapes are read structurally — a better-auth
 * upgrade that reshapes them degrades a field to null rather than breaking a sign-in;
 * re-check against the installed version on upgrade (1.6.23 at the time of writing).
 *
 * @module hub-auth/audit
 */
import { createHmac } from 'node:crypto'
import { securityEvent, type SecurityOutcome } from '@slayzone/platform/security-log'
import { createAuthMiddleware } from 'better-auth/api'
import { ACCOUNT_DISABLED_CODE } from './account'

const asRecord = (v: unknown): Record<string, unknown> | undefined =>
  typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : undefined

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null)

/** A thrown `APIError`'s short code (`INVALID_EMAIL_OR_PASSWORD`), or null on success. */
function failureCode(returned: unknown): string | null {
  const r = asRecord(returned)
  if (!r || typeof r.statusCode !== 'number' || r.statusCode < 400) return null
  return (str(asRecord(r.body)?.code) ?? str(r.status) ?? 'ERROR').slice(0, 80)
}

/**
 * A stable, non-reversible handle for an email address, so repeated failures against
 * one account correlate without writing the address. HMAC, not a bare hash: an
 * unkeyed hash of an email is reversed by guessing addresses. Keyed with the hub's
 * auth secret, so references differ between hubs.
 */
export function subjectRef(secret: string, email: string): string {
  return createHmac('sha256', secret).update(email.trim().toLowerCase()).digest('hex').slice(0, 16)
}

/** The endpoints whose outcome is logged here; anything else passes untouched. */
const PASSWORD_PATHS = new Set(['/change-password', '/set-password', '/reset-password'])

/** `hooks.after`: one line per sign-in or password change. Never throws, never alters the response. */
export const auditAuthResponse = createAuthMiddleware(async (ctx) => {
  try {
    const path = ctx.path ?? ''
    const context = ctx.context as unknown as Record<string, unknown>
    const failure = failureCode(context.returned)
    const outcome: SecurityOutcome = failure ? 'failure' : 'success'
    if (path === '/sign-in/email') {
      // Already logged as denied by the session guard (account.ts).
      if (failure === ACCOUNT_DISABLED_CODE) return
      const email = str(asRecord(ctx.body)?.email)
      securityEvent({
        event: 'auth.signin',
        outcome,
        actor: failure ? null : str(asRecord(asRecord(context.newSession)?.user)?.id),
        detail: failure
          ? {
              method: 'password',
              reason: failure,
              subjectRef: email ? subjectRef(String(context.secret ?? ''), email) : null
            }
          : { method: 'password' }
      })
      return
    }
    if (PASSWORD_PATHS.has(path)) {
      securityEvent({
        event: 'auth.password.change',
        outcome,
        actor: str(asRecord(asRecord(context.session)?.user)?.id) ?? undefined,
        targetKind: 'user',
        detail: failure ? { endpoint: path, reason: failure } : { endpoint: path }
      })
    }
  } catch {
    // An audit line must never fail a sign-in.
  }
})

interface SessionRow {
  id?: unknown
  userId?: unknown
  expiresAt?: unknown
}

const expired = (row: SessionRow): boolean => {
  const at = row.expiresAt instanceof Date ? row.expiresAt : new Date(String(row.expiresAt))
  return !Number.isNaN(at.getTime()) && at.getTime() <= Date.now()
}

/** `databaseHooks`: one line per session row created or deleted. */
export const auditDatabaseHooks = {
  session: {
    create: {
      after: async (session: SessionRow): Promise<void> => {
        securityEvent({
          event: 'auth.session.create',
          outcome: 'success',
          actor: str(session.userId),
          targetKind: 'session',
          targetId: str(session.id)
        })
      }
    },
    delete: {
      after: async (session: SessionRow, ctx: { path?: string } | null): Promise<void> => {
        const userId = str(session.userId)
        const target = { targetKind: 'session' as const, targetId: str(session.id) }
        if (ctx?.path === '/sign-out') {
          securityEvent({ event: 'auth.signout', outcome: 'success', actor: userId, ...target })
        } else if (expired(session)) {
          // Housekeeping of a row that had already stopped working, not a revocation.
          securityEvent({
            event: 'auth.session.expire',
            outcome: 'success',
            actor: null,
            ...target,
            detail: { userId }
          })
        } else {
          // Who revoked it comes from the request context (the user, or the
          // operator of `slay hub users disable`).
          securityEvent({
            event: 'auth.session.revoke',
            outcome: 'success',
            ...target,
            detail: { userId, endpoint: ctx?.path ?? null }
          })
        }
      }
    }
  }
}
