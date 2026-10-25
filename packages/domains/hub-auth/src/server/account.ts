/**
 * Account state on the better-auth `user` row (T-08): `role` and `disabledAt`,
 * declared as `user.additionalFields` in auth.ts, read here.
 *
 * OWN COLUMNS, NOT better-auth's `admin` plugin: the plugin ships impersonation (a
 * read path into another user's session, which the hub must never have) and 14
 * extra `/api/auth/admin/*` endpoints. The names follow the plugin (`role`, values
 * `admin`/`user`), so switching to it later is a data migration only
 * (`disabledAt` → `banned`).
 *
 * Disabled accounts are stopped at two places:
 *   - {@link refuseDisabledSessions} — when a session is CREATED (the one door);
 *   - `verifySession` (verify.ts) and the hub's web-session resolvers, via
 *     {@link findHubAccount} — when one is USED, so a session that somehow exists
 *     for a disabled account (created in the instant before the flag landed) is
 *     still refused.
 *
 * @module hub-auth/account
 */
import { securityEvent } from '@slayzone/platform/security-log'
import type { UserProvisioningSource } from 'better-auth'
import { APIError } from 'better-auth/api'
import type { HubRole } from '../shared/types'
import type { HubAuth } from './auth'

/** Error code of a session request for a disabled account. */
export const ACCOUNT_DISABLED_CODE = 'ACCOUNT_DISABLED'

/**
 * Provisioning source (better-auth's `createUser` 2nd argument) of every account the hub
 * creates itself — `slay hub users add`, break-glass, the computer service user —
 * as opposed to a sign-in. better-auth reads it only for `user.validateUserInfo`, which
 * the hub does not set; `admin` is the method better-auth's own admin plugin passes.
 */
export const OPERATOR_PROVISIONED: UserProvisioningSource = { method: 'admin' }

/** A stored role, read fail-safe: anything but exactly `'admin'` is `'user'`. A row
 *  from before the column existed reads NULL. */
export function readRole(value: unknown): HubRole {
  return value === 'admin' ? 'admin' : 'user'
}

/** True when the row's `disabledAt` is set. */
export function isDisabled(user: Record<string, unknown>): boolean {
  return user.disabledAt !== null && user.disabledAt !== undefined
}

/**
 * The break-glass account's address (./break-glass.ts): ONE synthetic account, disabled
 * whenever no break-glass session is open. `.local` is reserved (RFC 6762), so no
 * mailbox and no Entra identity can hold it.
 */
export const BREAK_GLASS_EMAIL = 'break-glass@hub.slayzone.local'

/** Break-glass v1's temporary password accounts (T-10): `break-glass-<day>-<hex>@…`. */
const LEGACY_BREAK_GLASS_EMAIL = /^break-glass-[0-9a-z-]+@hub\.slayzone\.local$/

/**
 * Whether `email` is a break-glass account's: v2's, or one v1 left behind. Such an
 * account is managed by break-glass alone — users.ts refuses to disable, enable or
 * re-role it and never counts it as a human or an admin.
 */
export function isBreakGlassEmail(email: string): boolean {
  const normalized = email.trim().toLowerCase()
  return normalized === BREAK_GLASS_EMAIL || LEGACY_BREAK_GLASS_EMAIL.test(normalized)
}

/** What a session check needs to know about the account behind it. */
export interface HubAccount {
  userId: string
  role: HubRole
  disabled: boolean
}

/** The account behind a user id, or null when no such user exists. */
export async function findHubAccount(auth: HubAuth, userId: string): Promise<HubAccount | null> {
  const ctx = await auth.$context
  const user = (await ctx.internalAdapter.findUserById(userId)) as Record<string, unknown> | null
  if (!user) return null
  return { userId, role: readRole(user.role), disabled: isDisabled(user) }
}

/**
 * `databaseHooks.session.create.before` — the one door. Every session better-auth
 * creates is a row written by `internalAdapter.createSession`, which runs this hook
 * first: password sign-in, the web login (it signs in in-process), and every other
 * route that mints one (OAuth callback, device code, email verification). A
 * disabled account gets no row: the hook throws, the endpoint answers 403
 * `ACCOUNT_DISABLED`, and the attempt is one `auth.signin` denied line.
 *
 * The user is read through `findUser`, not the hook's own context, because that
 * context is null for a session created outside an endpoint, and the check must not
 * depend on how the caller got here.
 */
export function refuseDisabledSessions(
  findUser: (userId: string) => Promise<Record<string, unknown> | null>
) {
  return async (session: { userId?: unknown }, ctx: { path?: string } | null): Promise<void> => {
    const userId = typeof session.userId === 'string' ? session.userId : null
    if (!userId) return
    const user = await findUser(userId)
    if (!user || !isDisabled(user)) return
    securityEvent({
      event: 'auth.signin',
      outcome: 'denied',
      actor: null,
      targetKind: 'user',
      targetId: userId,
      detail: { reason: 'account_disabled', endpoint: ctx?.path ?? null }
    })
    throw APIError.from('FORBIDDEN', {
      message: 'This account is disabled',
      code: ACCOUNT_DISABLED_CODE
    })
  }
}
