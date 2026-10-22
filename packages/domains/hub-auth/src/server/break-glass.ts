import { randomBytes } from 'node:crypto'
import { securityEvent } from '@slayzone/platform/security-log'
import type { HubAuth } from './auth'
import {
  type CreatedHubUser,
  createHubUser,
  type DisableHubUserOptions,
  type HubUserRow,
  listHubUsers
} from './users'

/**
 * Break-glass accounts (owner decision O-9): how the operator of a hub with Entra
 * sign-in gets in while Entra is down.
 *
 * The operator, on the VM, sets `SLAYZONE_HUB_ENABLE_PASSWORD=1` and restarts. The hub
 * (apps/hub `break-glass.ts`) then creates ONE temporary password account with
 * {@link createBreakGlassAccount} and leaves its credentials in a 0600 file under ROOT.
 * Reverting to `0` and restarting closes it: {@link closeBreakGlassAccounts} disables
 * every break-glass account and revokes its sessions. No HTTP route reaches either
 * function — the shell on the box is the authority, as for the bootstrap owner.
 *
 * Why not `slay hub users add` on the box: on a hub with Entra sign-in that route
 * needs an admin bearer, which only an Entra admin can get, and not while Entra is
 * down. Opening it to loopback callers instead would open it to the internet behind a
 * same-box reverse proxy (see transport `hub/users.ts`).
 *
 * The account is `user`, never `admin`: on a hub with Entra sign-in admin comes only
 * from the Entra app role (O-4), and `demoteNonEntraAdmins` would undo it at the next
 * boot anyway.
 *
 * Accounts are recognised by their address (`break-glass-…@hub.slayzone.local`), so a
 * closing boot finds them whether or not the file is still there.
 *
 * @module hub-auth/break-glass
 */

const BREAK_GLASS_DOMAIN = 'hub.slayzone.local'
const BREAK_GLASS_EMAIL = /^break-glass-[0-9a-z-]+@hub\.slayzone\.local$/

/** Whether `email` is a break-glass account's address. */
export function isBreakGlassEmail(email: string): boolean {
  return BREAK_GLASS_EMAIL.test(email.trim().toLowerCase())
}

/** The break-glass accounts that are still enabled, oldest first. */
export async function listOpenBreakGlassAccounts(auth: HubAuth): Promise<HubUserRow[]> {
  return (await listHubUsers(auth)).filter(
    (u) => u.disabledAt === null && isBreakGlassEmail(u.email)
  )
}

/**
 * Create a break-glass account: role `user`, a generated password, a fresh address
 * (`break-glass-<yyyymmdd>-<random>@hub.slayzone.local`, so an earlier, disabled one
 * never collides). One `user.create` success line with `reason: break_glass`. Refused
 * like any account with a password when password sign-in is off (`HUB_PASSWORD_DISABLED`).
 */
export async function createBreakGlassAccount(
  auth: HubAuth,
  now: Date = new Date()
): Promise<CreatedHubUser> {
  const day = now.toISOString().slice(0, 10).replaceAll('-', '')
  const email = `break-glass-${day}-${randomBytes(3).toString('hex')}@${BREAK_GLASS_DOMAIN}`
  const created = await createHubUser(
    auth,
    { email, name: 'Break-glass (temporary)', role: 'user' },
    { reason: 'break_glass' }
  )
  if ('error' in created) throw new Error(`[hub-auth] break-glass account: ${created.error}`)
  return created
}

/**
 * Close every enabled break-glass account: disable it, revoke its better-auth sessions
 * and (through `opts`) its web sessions. Keeps every row. One `user.disable` success
 * line each (`reason: break_glass_closed`). Returns the closed ids.
 *
 * Unlike `disableHubUser` it does not refuse the last enabled account: a break-glass
 * account is temporary by definition, it cannot sign in with password sign-in off, and
 * its sessions must not outlive the break-glass window.
 */
export async function closeBreakGlassAccounts(
  auth: HubAuth,
  opts: DisableHubUserOptions = {}
): Promise<string[]> {
  const ctx = await auth.$context
  const closed: string[] = []
  for (const account of await listOpenBreakGlassAccounts(auth)) {
    await ctx.internalAdapter.updateUser(account.id, { disabledAt: new Date() })
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
