import { securityEvent } from '@slayzone/platform/security-log'
import { BREAK_GLASS_EMAIL, isBreakGlassEmail, OPERATOR_PROVISIONED } from './account'
import type { HubAuth } from './auth'
import { type DisableHubUserOptions, type HubUserRow, listHubUsers } from './users'

/**
 * The break-glass account (owner decisions O-9, O-23): the identity an emergency session
 * acts as when an operator gets into a hub whose sign-in is down. The hub (apps/hub
 * `break-glass.ts`) owns the grant, the session and its lifetime; this module owns the
 * account row.
 *
 * ONE SYNTHETIC ACCOUNT, `break-glass@hub.slayzone.local`, not a session for an existing
 * admin: it owns no project, computer or setting, so admin rights through it reach no
 * content (O-6) and closing it touches nobody's own sessions; every line it causes names
 * it; and an account that may itself be the problem (stolen, the one to disable) is never
 * the one the emergency path signs in as.
 *
 * NO CREDENTIAL. The row has no `account` row at all — no password, no Entra identity —
 * so nothing but the hub's own grant can act as it, whatever the password switch says.
 *
 * ADMIN ONLY WHILE OPEN. {@link openBreakGlassAccount} enables it with role `admin` (the
 * one exception to O-4, decided in O-23); {@link closeBreakGlassAccounts} disables it,
 * makes it `user` again and revokes everything it holds. users.ts refuses to change it
 * any other way and never counts it as a human or an admin, so an emergency session can
 * never disable the hub's last real admin on the strength of being one itself.
 *
 * Closing also catches break-glass v1's temporary password accounts (T-10,
 * `break-glass-<day>-<hex>@…`), recognised by address, so a hub upgraded with one still
 * enabled closes it at its next boot.
 *
 * @module hub-auth/break-glass
 */

export { BREAK_GLASS_EMAIL, isBreakGlassEmail } from './account'

const BREAK_GLASS_NAME = 'Break-glass (emergency admin)'

/** The break-glass accounts that are still enabled (v2's and any v1 left), oldest first. */
export async function listOpenBreakGlassAccounts(auth: HubAuth): Promise<HubUserRow[]> {
  return (await listHubUsers(auth)).filter(
    (u) => u.disabledAt === null && isBreakGlassEmail(u.email)
  )
}

/**
 * Enable the break-glass account as `admin`, creating it on first use. One line: a
 * `user.create` (first use) or `user.enable`, each `{ role: 'admin', reason:
 * 'break_glass' }`. Not refused with password sign-in off or on an Entra hub: the account
 * has no credential, and the hub's grant is the only way to act as it.
 */
export async function openBreakGlassAccount(auth: HubAuth): Promise<{ userId: string }> {
  const ctx = await auth.$context
  const found = await ctx.internalAdapter.findUserByEmail(BREAK_GLASS_EMAIL)
  if (!found) {
    const created = await ctx.internalAdapter.createUser(
      {
        email: BREAK_GLASS_EMAIL,
        name: BREAK_GLASS_NAME,
        emailVerified: true,
        role: 'admin'
      },
      OPERATOR_PROVISIONED
    )
    securityEvent({
      event: 'user.create',
      outcome: 'success',
      targetKind: 'user',
      targetId: created.id,
      detail: { role: 'admin', reason: 'break_glass' }
    })
    return { userId: created.id }
  }
  await ctx.internalAdapter.updateUser(found.user.id, { disabledAt: null, role: 'admin' })
  securityEvent({
    event: 'user.enable',
    outcome: 'success',
    targetKind: 'user',
    targetId: found.user.id,
    detail: { role: 'admin', reason: 'break_glass' }
  })
  return { userId: found.user.id }
}

/**
 * Close every enabled break-glass account: disable it, make it `user`, revoke its
 * better-auth sessions and (through `opts`) what it holds outside hub-auth. Keeps every
 * row. One `user.disable` success line each (`reason: break_glass_closed`). Returns the
 * closed ids.
 *
 * Unlike `disableHubUser` it never refuses: a break-glass account is temporary by
 * definition and counts as no human and no admin.
 */
export async function closeBreakGlassAccounts(
  auth: HubAuth,
  opts: DisableHubUserOptions = {}
): Promise<string[]> {
  const ctx = await auth.$context
  const closed: string[] = []
  for (const account of await listOpenBreakGlassAccounts(auth)) {
    await ctx.internalAdapter.updateUser(account.id, { disabledAt: new Date(), role: 'user' })
    await ctx.internalAdapter.deleteUserSessions(account.id)
    await opts.revokeExternalSessions?.(account.id)
    securityEvent({
      event: 'user.disable',
      outcome: 'success',
      targetKind: 'user',
      targetId: account.id,
      detail: { reason: 'break_glass_closed' }
    })
    closed.push(account.id)
  }
  return closed
}
