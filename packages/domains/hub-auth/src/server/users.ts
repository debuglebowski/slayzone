import { randomBytes } from 'node:crypto'
import { securityEvent, type SecurityOutcome } from '@slayzone/platform/security-log'
import type { HubRole } from '../shared/types'
import { isDisabled, readRole } from './account'
import type { HubAuth } from './auth'
import { COMPUTER_SERVICE_USER_EMAIL } from './computer-keys'

/**
 * Operator-facing account management for a hub — the server half of
 * `slay hub users add|ls|disable|enable|role`.
 *
 * WHY THIS EXISTS: `emailAndPassword.disableSignUp` is ON (see auth.ts), because
 * `/api/auth/sign-up/email` is necessarily exempt from the bearer gate
 * (`rest-auth.ts` — a client with no token must be able to reach it to get one),
 * which on an internet-facing hub meant anyone who could reach it could
 * self-register into full access. With signup closed, accounts have to come from
 * somewhere: this module, reached over the loopback-only `/api/hub/users` route.
 * A shell on the hub box is the credential, exactly as for
 * `POST /api/computers/join-token`.
 *
 * Shape mirrors `computer-keys.ts` deliberately — both reach through `auth.$context`
 * to better-auth's internal adapter for things the public `auth.api` surface only
 * exposes session-bound. No express here; the route layer owns HTTP.
 *
 * ACCOUNTS ARE NEVER DELETED. A leaver is disabled: the user, account, member and
 * every other row stay, and the data goes at the end of its retention period. Two
 * invariants hold from the first account on: at least one ENABLED human, and at
 * least one ENABLED admin. The guards below refuse any change that breaks either;
 * {@link ensureFirstAdmin} establishes the second on a hub upgraded from before roles.
 *
 * @module hub-auth/users
 */

/** One account, as `slay hub users ls` renders it. */
export interface HubUserRow {
  id: string
  email: string
  name: string
  role: HubRole
  /** ISO-8601 when the account is disabled, else null. */
  disabledAt: string | null
  /** ISO-8601. `user.createdAt` is a Date from the adapter; normalized here. */
  createdAt: string
}

export interface CreateHubUserInput {
  email: string
  /** Display name. Defaults to the email's local part. */
  name?: string
  /** Defaults to `'admin'` when the hub has no enabled admin yet, else `'user'`. */
  role?: HubRole
}

export interface CreatedHubUser {
  id: string
  email: string
  name: string
  role: HubRole
  /**
   * Generated plaintext password. Returned ONCE and never persisted in
   * recoverable form (only its hash reaches the DB) — the caller must show it to
   * the operator or it is lost.
   */
  password: string
}

/**
 * Why `disableHubUser` declined, or 'ok'.
 *  - `protected` — the computer service user (see {@link disableHubUser});
 *  - `last-user` — the last enabled human;
 *  - `last-admin` — the last enabled admin.
 */
export type DisableHubUserResult = 'ok' | 'not-found' | 'protected' | 'last-user' | 'last-admin'

/** Why `enableHubUser` declined, or 'ok'. */
export type EnableHubUserResult = 'ok' | 'not-found' | 'protected'

/** Why `setHubUserRole` declined, or 'ok'. `protected`: the service user is never admin. */
export type SetHubUserRoleResult = 'ok' | 'not-found' | 'protected' | 'last-admin'

export interface DisableHubUserOptions {
  /**
   * Revoke the account's sessions held OUTSIDE hub-auth's database — the hub's
   * scoped web sessions (`web_sessions` in the app DB, which this package cannot
   * reach). Called after the account is flagged and its better-auth sessions are
   * gone.
   */
  revokeExternalSessions?: (userId: string) => Promise<unknown>
}

/**
 * Upper bound on `listUsers`. MUST be explicit: better-auth's adapter factory
 * defaults an absent limit to 100, which would silently truncate the list rather
 * than erroring — an operator auditing accounts would see a short list and have
 * no way to know it was cut.
 */
const LIST_USERS_LIMIT = 1000

/** Audit line for an account command (T-03). Ids, a role and a reason code only —
 *  never the email or the generated password. The acting operator comes from the
 *  request context. */
function auditUser(
  event: 'user.create' | 'user.disable' | 'user.enable' | 'user.role_change',
  outcome: SecurityOutcome,
  userId: string | null,
  detail?: { reason?: string; role?: HubRole }
): void {
  securityEvent({ event, outcome, targetKind: 'user', targetId: userId, detail })
}

/**
 * Generate a password for an operator-created account.
 *
 * 128 bits of entropy, base64url so it survives copy/paste out of a terminal and
 * into a password manager unmangled (no shell-significant characters, no
 * ambiguity about trailing `=`). Same idiom as the join-token secret in
 * `@slayzone/computers/server` join-tokens.ts.
 */
function generatePassword(): string {
  return randomBytes(16).toString('base64url')
}

/** The email as stored: better-auth's adapter lowercases internally, so the
 *  pre-existence check and the insert must agree on one normalized form. */
function normalizeEmail(email: string): string {
  return email.trim().toLowerCase()
}

/**
 * Create an account that can immediately sign in with email + password.
 *
 * Replicates precisely what better-auth's own sign-up route does — `createUser`
 * followed by `linkAccount` with a `'credential'` provider row carrying the
 * password hash. BOTH are required: a user row without the credential account is
 * unauthenticatable, which is the failure mode this pairing exists to avoid (and
 * what `users.test.ts` asserts by signing in with the returned password).
 *
 * Returns `{ error: 'exists' }` rather than throwing on a duplicate: the email
 * column is unique, but a caught constraint violation is not reliably
 * distinguishable from other write failures, so the check is explicit.
 */
export async function createHubUser(
  auth: HubAuth,
  input: CreateHubUserInput
): Promise<CreatedHubUser | { error: 'exists' }> {
  const ctx = await auth.$context
  const email = normalizeEmail(input.email)

  const existing = await ctx.internalAdapter.findUserByEmail(email)
  if (existing) {
    auditUser('user.create', 'failure', null, { reason: 'exists' })
    return { error: 'exists' }
  }

  const password = generatePassword()
  // Fail LOUD if the generated length ever falls outside better-auth's configured
  // bounds: silently minting an account whose password the sign-in route rejects
  // would be a mystery to debug. Only reachable if the config or the generator
  // changes, which is exactly when we want to hear about it.
  const { minPasswordLength, maxPasswordLength } = ctx.password.config
  if (password.length < minPasswordLength || password.length > maxPasswordLength) {
    throw new Error(
      `[hub-auth] generated password length ${password.length} is outside the configured ` +
        `bounds ${minPasswordLength}–${maxPasswordLength} — adjust generatePassword()`
    )
  }

  // Hash BEFORE creating the user, so a hashing failure leaves no orphaned user
  // row behind (same ordering better-auth's sign-up route uses).
  const hash = await ctx.password.hash(password)

  const name = input.name?.trim() || email.split('@')[0]!
  // The first account on a hub with no enabled admin is the admin, so the
  // "at least one enabled admin" invariant holds from the first account on rather
  // than only after the next boot's `ensureFirstAdmin`.
  const role: HubRole =
    input.role ?? ((await listHubUsers(auth)).some(isEnabledAdmin) ? 'user' : 'admin')
  // emailVerified: true — a DELIBERATE divergence from sign-up's `false`. This hub
  // configures no mail sender, so a verification mail can never be sent and the
  // account would be permanently unverifiable. Marking an operator-created account
  // verified keeps it usable and stays correct if `requireEmailVerification` is
  // ever switched on. The operator vouched for the address by typing it.
  const created = await ctx.internalAdapter.createUser({ email, name, emailVerified: true, role })

  await ctx.internalAdapter.linkAccount({
    userId: created.id,
    providerId: 'credential',
    accountId: created.id,
    password: hash
  })

  auditUser('user.create', 'success', created.id, { role })
  return { id: created.id, email: created.email, name: created.name, role, password }
}

/**
 * Every human account on this hub, oldest first.
 *
 * Excludes {@link COMPUTER_SERVICE_USER_EMAIL} — the internal identity that owns
 * computer API keys (see computer-keys.ts). It is not a person, was never created by
 * an operator, is never admin, and must not be presented as an account.
 */
export async function listHubUsers(auth: HubAuth): Promise<HubUserRow[]> {
  const ctx = await auth.$context
  const users = await ctx.internalAdapter.listUsers(LIST_USERS_LIMIT, 0, {
    field: 'createdAt',
    direction: 'asc'
  })
  return users
    .filter((u) => u.email !== COMPUTER_SERVICE_USER_EMAIL)
    .map((u) => {
      const row = u as typeof u & Record<string, unknown>
      return {
        id: u.id,
        email: u.email,
        name: u.name,
        role: readRole(row.role),
        disabledAt: isDisabled(row)
          ? new Date(row.disabledAt as string | Date).toISOString()
          : null,
        createdAt: new Date(u.createdAt).toISOString()
      }
    })
}

const isEnabled = (u: HubUserRow): boolean => u.disabledAt === null
const isEnabledAdmin = (u: HubUserRow): boolean => isEnabled(u) && u.role === 'admin'

/** The human behind an email, with the full human list for the invariant checks;
 *  null when there is no such account. Never the service user (callers refuse it
 *  first). */
async function findHuman(
  auth: HubAuth,
  email: string
): Promise<{ target: HubUserRow; humans: HubUserRow[] } | null> {
  const ctx = await auth.$context
  const found = await ctx.internalAdapter.findUserByEmail(normalizeEmail(email))
  if (!found) return null
  const humans = await listHubUsers(auth)
  const target = humans.find((u) => u.id === found.user.id)
  return target ? { target, humans } : null
}

/**
 * Disable an account: it keeps every row (user, account, member, everything) and can
 * no longer get or use a session. Sets `disabledAt` first — from then on the session
 * guard refuses a new session and verification refuses an existing one — then
 * revokes the better-auth sessions and, through `opts`, the hub's web sessions.
 * Disabling a disabled account re-runs the revocation and keeps the original time.
 *
 * Refusals, each protecting against an unrecoverable state:
 *  - `'protected'` — the computer service user. Its id is the `referenceId` on every
 *    computer API key; it has no sessions to stop, and flagging it would read as
 *    "computers are disabled". Nothing about the request looks dangerous, so the
 *    guard has to live here.
 *  - `'last-user'` — the last enabled human. With signup disabled no one could sign
 *    in again, and no one could create an account except over loopback on the box.
 *  - `'last-admin'` — the last enabled admin.
 */
export async function disableHubUser(
  auth: HubAuth,
  email: string,
  opts: DisableHubUserOptions = {}
): Promise<DisableHubUserResult> {
  if (normalizeEmail(email) === COMPUTER_SERVICE_USER_EMAIL) {
    auditUser('user.disable', 'denied', null, { reason: 'protected' })
    return 'protected'
  }
  const found = await findHuman(auth, email)
  if (!found) {
    auditUser('user.disable', 'failure', null, { reason: 'not_found' })
    return 'not-found'
  }
  const { target, humans } = found
  const ctx = await auth.$context

  if (isEnabled(target)) {
    // Count HUMANS, not rows: the service user is a user row nobody signs in as, so
    // counting it would let the operator disable the true last human.
    if (humans.filter(isEnabled).length <= 1) {
      auditUser('user.disable', 'denied', target.id, { reason: 'last_user' })
      return 'last-user'
    }
    if (target.role === 'admin' && humans.filter(isEnabledAdmin).length <= 1) {
      auditUser('user.disable', 'denied', target.id, { reason: 'last_admin' })
      return 'last-admin'
    }
    await ctx.internalAdapter.updateUser(target.id, { disabledAt: new Date() })
  }

  await ctx.internalAdapter.deleteUserSessions(target.id)
  await opts.revokeExternalSessions?.(target.id)

  auditUser('user.disable', 'success', target.id)
  return 'ok'
}

/** Enable a disabled account: it can sign in again. Its old sessions stay revoked. */
export async function enableHubUser(auth: HubAuth, email: string): Promise<EnableHubUserResult> {
  if (normalizeEmail(email) === COMPUTER_SERVICE_USER_EMAIL) {
    auditUser('user.enable', 'denied', null, { reason: 'protected' })
    return 'protected'
  }
  const found = await findHuman(auth, email)
  if (!found) {
    auditUser('user.enable', 'failure', null, { reason: 'not_found' })
    return 'not-found'
  }
  const ctx = await auth.$context
  await ctx.internalAdapter.updateUser(found.target.id, { disabledAt: null })
  auditUser('user.enable', 'success', found.target.id)
  return 'ok'
}

/**
 * Set an account's role. Refuses to demote the last enabled admin, and the service
 * user in either direction (it is never admin). Nothing enforces the role yet.
 */
export async function setHubUserRole(
  auth: HubAuth,
  email: string,
  role: HubRole
): Promise<SetHubUserRoleResult> {
  if (normalizeEmail(email) === COMPUTER_SERVICE_USER_EMAIL) {
    auditUser('user.role_change', 'denied', null, { reason: 'protected', role })
    return 'protected'
  }
  const found = await findHuman(auth, email)
  if (!found) {
    auditUser('user.role_change', 'failure', null, { reason: 'not_found', role })
    return 'not-found'
  }
  const { target, humans } = found
  if (role === 'user' && isEnabledAdmin(target) && humans.filter(isEnabledAdmin).length <= 1) {
    auditUser('user.role_change', 'denied', target.id, { reason: 'last_admin', role })
    return 'last-admin'
  }
  const ctx = await auth.$context
  await ctx.internalAdapter.updateUser(target.id, { role })
  auditUser('user.role_change', 'success', target.id, { role })
  return 'ok'
}

/**
 * Boot step (from `createHubAuth`): a hub that has enabled humans but no enabled
 * admin makes its OLDEST enabled human admin, with one `user.role_change` line
 * (reason `first_admin`). In practice this acts once — on the first boot after the
 * `role` column was added — because from then on `createHubUser` and the guards
 * above keep an enabled admin. A hub with no humans is left alone. Returns the
 * promoted user's id, or null when nothing changed.
 */
export async function ensureFirstAdmin(auth: HubAuth): Promise<string | null> {
  const enabled = (await listHubUsers(auth)).filter(isEnabled)
  if (enabled.length === 0 || enabled.some(isEnabledAdmin)) return null
  const first = enabled[0]!
  const ctx = await auth.$context
  await ctx.internalAdapter.updateUser(first.id, { role: 'admin' })
  auditUser('user.role_change', 'success', first.id, { reason: 'first_admin', role: 'admin' })
  return first.id
}
