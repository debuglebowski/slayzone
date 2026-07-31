import { randomBytes } from 'node:crypto'
import { API_KEY_TABLE_NAME } from '@better-auth/api-key'
import type { HubAuth } from './auth'
import { RUNNER_SERVICE_USER_EMAIL } from './runner-keys'

/**
 * Operator-facing account management for a hub — the server half of
 * `slay hub users add|ls|rm`.
 *
 * WHY THIS EXISTS: `emailAndPassword.disableSignUp` is ON (see auth.ts), because
 * `/api/auth/sign-up/email` is necessarily exempt from the bearer gate
 * (`rest-auth.ts` — a client with no token must be able to reach it to get one),
 * which on an internet-facing hub meant anyone who could reach it could
 * self-register into full access. With signup closed, accounts have to come from
 * somewhere: this module, reached over the loopback-only `/api/hub/users` route.
 * A shell on the hub box is the credential, exactly as for
 * `POST /api/runners/join-token`.
 *
 * Shape mirrors `runner-keys.ts` deliberately — both reach through `auth.$context`
 * to better-auth's internal adapter for things the public `auth.api` surface only
 * exposes session-bound. No express here; the route layer owns HTTP.
 *
 * @module hub-auth/users
 */

/** One account, as `slay hub users ls` renders it. */
export interface HubUserRow {
  id: string
  email: string
  name: string
  /** ISO-8601. `user.createdAt` is a Date from the adapter; normalized here. */
  createdAt: string
}

export interface CreateHubUserInput {
  email: string
  /** Display name. Defaults to the email's local part. */
  name?: string
}

export interface CreatedHubUser {
  id: string
  email: string
  name: string
  /**
   * Generated plaintext password. Returned ONCE and never persisted in
   * recoverable form (only its hash reaches the DB) — the caller must show it to
   * the operator or it is lost.
   */
  password: string
}

/** Why `removeHubUser` declined, or 'ok' when it removed the account. */
export type RemoveHubUserResult = 'ok' | 'not-found' | 'protected' | 'last-user'

/**
 * Upper bound on `listUsers`. MUST be explicit: better-auth's adapter factory
 * defaults an absent limit to 100, which would silently truncate the list rather
 * than erroring — an operator auditing accounts would see a short list and have
 * no way to know it was cut.
 */
const LIST_USERS_LIMIT = 1000

/**
 * The organization plugin's membership table. Rows here are NOT cascaded by
 * `internalAdapter.deleteUser` (which touches only session/account/user), so
 * `removeHubUser` sweeps them itself.
 */
const MEMBER_TABLE_NAME = 'member'

/**
 * Generate a password for an operator-created account.
 *
 * 128 bits of entropy, base64url so it survives copy/paste out of a terminal and
 * into a password manager unmangled (no shell-significant characters, no
 * ambiguity about trailing `=`). Same idiom as the join-token secret in
 * `@slayzone/runners/server` join-tokens.ts.
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
  if (existing) return { error: 'exists' }

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
  // emailVerified: true — a DELIBERATE divergence from sign-up's `false`. This hub
  // configures no mail sender, so a verification mail can never be sent and the
  // account would be permanently unverifiable. Marking an operator-created account
  // verified keeps it usable and stays correct if `requireEmailVerification` is
  // ever switched on. The operator vouched for the address by typing it.
  const created = await ctx.internalAdapter.createUser({ email, name, emailVerified: true })

  await ctx.internalAdapter.linkAccount({
    userId: created.id,
    providerId: 'credential',
    accountId: created.id,
    password: hash
  })

  return { id: created.id, email: created.email, name: created.name, password }
}

/**
 * Every human account on this hub, oldest first.
 *
 * Excludes {@link RUNNER_SERVICE_USER_EMAIL} — the internal identity that owns
 * runner API keys (see runner-keys.ts). It is not a person, was never created by
 * an operator, and must not be presented as removable.
 */
export async function listHubUsers(auth: HubAuth): Promise<HubUserRow[]> {
  const ctx = await auth.$context
  const users = await ctx.internalAdapter.listUsers(LIST_USERS_LIMIT, 0, {
    field: 'createdAt',
    direction: 'asc'
  })
  return users
    .filter((u) => u.email !== RUNNER_SERVICE_USER_EMAIL)
    .map((u) => ({
      id: u.id,
      email: u.email,
      name: u.name,
      createdAt: new Date(u.createdAt).toISOString()
    }))
}

/**
 * Remove an account and everything that references it.
 *
 * Two refusals, both protecting against an unrecoverable state:
 *
 *  - `'protected'` — the runner service user. Its id is the `referenceId` on every
 *    runner API key; deleting it makes the api-key plugin's user lookup fail, which
 *    401s EVERY enrolled runner. Nothing about the request looks dangerous, so the
 *    guard has to live here.
 *  - `'last-user'` — the final human account. With signup disabled there is no path
 *    back: no one could authenticate to the hub, and no one could create an account
 *    except over loopback on the box. Refusing keeps a remote hub recoverable.
 *
 * The cascade is EXPLICIT rather than delegated to `deleteUser`, which touches only
 * session/account/user. `apikey` and `member` rows reference a user and would be
 * left dangling.
 */
export async function removeHubUser(
  auth: HubAuth,
  email: string
): Promise<RemoveHubUserResult> {
  const ctx = await auth.$context
  const normalized = normalizeEmail(email)

  if (normalized === RUNNER_SERVICE_USER_EMAIL) return 'protected'

  const found = await ctx.internalAdapter.findUserByEmail(normalized)
  if (!found) return 'not-found'

  // Count HUMANS, not rows: the service user exists as a user row but is not an
  // account anyone can sign in as, so including it would let the operator delete
  // the true last human and lock the hub.
  const humans = await listHubUsers(auth)
  if (humans.length <= 1) return 'last-user'

  const userId = found.user.id

  // Sessions first: revoke live bearers before anything else, so an in-flight
  // request cannot act with this identity partway through the teardown.
  await ctx.internalAdapter.deleteUserSessions(userId)
  // Column is `referenceId`, not `userId` (api-key plugin's own naming). A human
  // account normally owns no keys, so this is a no-op sweep that keeps the table
  // free of rows pointing at a deleted user.
  await ctx.adapter.deleteMany({
    model: API_KEY_TABLE_NAME,
    where: [{ field: 'referenceId', value: userId }]
  })
  await ctx.adapter.deleteMany({
    model: MEMBER_TABLE_NAME,
    where: [{ field: 'userId', value: userId }]
  })
  await ctx.internalAdapter.deleteAccounts(userId)
  await ctx.internalAdapter.deleteUser(userId)

  return 'ok'
}
