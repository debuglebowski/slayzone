/**
 * Operator account management (`users.ts`) against a REAL better-auth instance on
 * a throwaway node:sqlite file — no mocks. The central assertion is that a created
 * account can actually SIGN IN with the returned password: that is what proves the
 * `createUser` + `linkAccount('credential')` pairing replicates better-auth's own
 * sign-up route. A user row without the credential account would look fine in
 * `ls` and be permanently unauthenticatable.
 *
 * Each test gets its OWN auth instance + sqlite file: the `'last-user'` and
 * `'last-admin'` refusals depend on how many accounts exist, so a shared instance
 * would make these tests order-dependent.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { findHubAccount } from './account'
import { createHubAuth, type HubAuth } from './auth'
import { mintComputerApiKey, COMPUTER_SERVICE_USER_EMAIL } from './computer-keys'
import {
  createHubUser,
  disableHubUser,
  enableHubUser,
  listHubUsers,
  setHubUserRole,
  type CreatedHubUser
} from './users'
import { verifyComputerApiKey, verifySession } from './verify'

let tmpDir: string
let dbPath: string
let auth: HubAuth

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'hub-users-test-'))
  dbPath = join(tmpDir, 'hub-auth.sqlite')
  auth = await createHubAuth({
    dbPath,
    baseURL: 'http://127.0.0.1:9999',
    secret: 'hub-auth-test-secret-at-least-32-chars-long'
  })
})

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true })
})

/** Create and assert success, narrowing off the `{ error }` arm. */
async function create(
  email: string,
  name?: string,
  role?: 'admin' | 'user'
): Promise<CreatedHubUser> {
  const result = await createHubUser(auth, {
    email,
    ...(name === undefined ? {} : { name }),
    ...(role === undefined ? {} : { role })
  })
  if ('error' in result) throw new Error(`expected creation to succeed, got ${result.error}`)
  return result
}

const signIn = (email: string, password: string) =>
  auth.api.signInEmail({ body: { email, password } })
const bearer = (token: string) => ({ authorization: `Bearer ${token}` })

/** Row counts per table for one user, straight from the sqlite file. */
function rowsOf(userId: string): Record<string, number> {
  const db = new DatabaseSync(dbPath)
  try {
    const count = (sql: string) => (db.prepare(sql).get(userId) as { n: number }).n
    return {
      user: count('SELECT count(*) AS n FROM user WHERE id = ?'),
      account: count('SELECT count(*) AS n FROM account WHERE userId = ?'),
      member: count('SELECT count(*) AS n FROM member WHERE userId = ?'),
      session: count('SELECT count(*) AS n FROM session WHERE userId = ?')
    }
  } finally {
    db.close()
  }
}

describe('createHubUser', () => {
  it('creates an account that can sign in with the returned password', async () => {
    const created = await create('alice@example.com', 'Alice')
    expect(created.email).toBe('alice@example.com')
    expect(created.name).toBe('Alice')
    expect(created.password).toBeTruthy()

    // THE assertion: proves the credential account row was linked correctly.
    const signIn = await auth.api.signInEmail({
      body: { email: 'alice@example.com', password: created.password }
    })
    expect(signIn.user.email).toBe('alice@example.com')
    expect(signIn.token).toBeTruthy()
  })

  it('rejects the wrong password for a created account', async () => {
    await create('alice@example.com')
    await expect(
      auth.api.signInEmail({ body: { email: 'alice@example.com', password: 'not-the-password' } })
    ).rejects.toMatchObject({ status: 'UNAUTHORIZED' })
  })

  it('defaults the display name to the email local part', async () => {
    const created = await create('bob@example.com')
    expect(created.name).toBe('bob')
  })

  it('generates a password inside better-auth’s configured length bounds', async () => {
    const created = await create('alice@example.com')
    const ctx = await auth.$context
    expect(created.password.length).toBeGreaterThanOrEqual(ctx.password.config.minPasswordLength)
    expect(created.password.length).toBeLessThanOrEqual(ctx.password.config.maxPasswordLength)
  })

  it('generates a distinct password per account', async () => {
    const a = await create('alice@example.com')
    const b = await create('bob@example.com')
    expect(a.password).not.toBe(b.password)
  })

  it('refuses a duplicate email, case-insensitively', async () => {
    await create('alice@example.com')
    expect(await createHubUser(auth, { email: 'Alice@Example.COM' })).toEqual({ error: 'exists' })
  })

  it('normalizes email case and surrounding whitespace on create', async () => {
    const created = await create('  Carol@Example.COM  ')
    expect(created.email).toBe('carol@example.com')
    // Sign-in with the normalized form must work — otherwise the account is
    // unreachable under the address `ls` reports.
    const signIn = await auth.api.signInEmail({
      body: { email: 'carol@example.com', password: created.password }
    })
    expect(signIn.token).toBeTruthy()
  })
})

describe('listHubUsers', () => {
  it('is empty on a fresh hub', async () => {
    expect(await listHubUsers(auth)).toEqual([])
  })

  it('lists accounts oldest first', async () => {
    await create('alice@example.com')
    await create('bob@example.com')
    expect((await listHubUsers(auth)).map((u) => u.email)).toEqual([
      'alice@example.com',
      'bob@example.com'
    ])
  })

  it('excludes the internal computer service user', async () => {
    // Minting a computer key lazily creates the service user, so this is the state
    // any hub with an enrolled computer is really in.
    await mintComputerApiKey(auth, { computerId: 'computer-1', name: 'ci-computer' })
    await create('alice@example.com')

    const listed = await listHubUsers(auth)
    expect(listed.map((u) => u.email)).toEqual(['alice@example.com'])
    expect(listed.some((u) => u.email === COMPUTER_SERVICE_USER_EMAIL)).toBe(false)

    // It still EXISTS — it is hidden from the operator, not deleted.
    const ctx = await auth.$context
    expect(await ctx.internalAdapter.findUserByEmail(COMPUTER_SERVICE_USER_EMAIL)).not.toBeNull()
  })

  it('reports role and disabledAt', async () => {
    await create('alice@example.com')
    await create('bob@example.com')
    await disableHubUser(auth, 'bob@example.com')
    const [alice, bob] = await listHubUsers(auth)
    expect(alice).toMatchObject({ role: 'admin', disabledAt: null })
    expect(bob!.role).toBe('user')
    expect(bob!.disabledAt).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/)
  })

  it('reports createdAt as an ISO-8601 string', async () => {
    await create('alice@example.com')
    const [row] = await listHubUsers(auth)
    expect(row!.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/)
  })
})

describe('roles', () => {
  it('makes the first account on a hub admin, later ones user', async () => {
    expect((await create('alice@example.com')).role).toBe('admin')
    expect((await create('bob@example.com')).role).toBe('user')
    expect((await create('carol@example.com', undefined, 'admin')).role).toBe('admin')
  })

  it('makes the next account admin again when no enabled admin is left', async () => {
    // Only reachable by editing the DB: the guards keep an enabled admin.
    await create('alice@example.com')
    const db = new DatabaseSync(dbPath)
    db.prepare("UPDATE user SET role = 'user'").run()
    db.close()
    expect((await create('bob@example.com')).role).toBe('admin')
  })

  it('honours an explicit role on the first account', async () => {
    expect((await create('alice@example.com', undefined, 'user')).role).toBe('user')
  })

  it('a user cannot set their own role or disabled flag through /update-user', async () => {
    await create('alice@example.com')
    const bob = await create('bob@example.com')
    const { token } = await signIn('bob@example.com', bob.password)
    // (A disabled user holds no session to clear their own flag with.)
    for (const body of [{ role: 'admin' }, { disabledAt: new Date() }]) {
      await expect(
        auth.api.updateUser({ headers: new Headers(bearer(token)), body: body as never })
      ).rejects.toMatchObject({ body: { code: 'FIELD_NOT_ALLOWED' } })
    }
    expect(await findHubAccount(auth, bob.id)).toEqual({
      userId: bob.id,
      role: 'user',
      disabled: false
    })
  })

  it('the session principal carries the role', async () => {
    const alice = await create('alice@example.com')
    const bob = await create('bob@example.com')
    const a = await signIn('alice@example.com', alice.password)
    const b = await signIn('bob@example.com', bob.password)
    expect((await verifySession(auth, bearer(a.token)))!.role).toBe('admin')
    expect((await verifySession(auth, bearer(b.token)))!.role).toBe('user')
  })
})

describe('setHubUserRole', () => {
  it('promotes and demotes', async () => {
    await create('alice@example.com')
    const bob = await create('bob@example.com')
    expect(await setHubUserRole(auth, 'BOB@example.com', 'admin')).toBe('ok')
    expect((await findHubAccount(auth, bob.id))!.role).toBe('admin')
    expect(await setHubUserRole(auth, 'bob@example.com', 'user')).toBe('ok')
    expect((await findHubAccount(auth, bob.id))!.role).toBe('user')
  })

  it('refuses to demote the last enabled admin', async () => {
    const alice = await create('alice@example.com')
    await create('bob@example.com')
    expect(await setHubUserRole(auth, 'alice@example.com', 'user')).toBe('last-admin')
    expect((await findHubAccount(auth, alice.id))!.role).toBe('admin')
  })

  it('a disabled admin does not count as the remaining admin', async () => {
    await create('alice@example.com')
    await create('bob@example.com', undefined, 'admin')
    await create('carol@example.com')
    expect(await disableHubUser(auth, 'bob@example.com')).toBe('ok')
    expect(await setHubUserRole(auth, 'alice@example.com', 'user')).toBe('last-admin')
  })

  it('refuses the computer service user in both directions', async () => {
    await mintComputerApiKey(auth, { computerId: 'computer-1', name: 'ci-computer' })
    await create('alice@example.com')
    expect(await setHubUserRole(auth, COMPUTER_SERVICE_USER_EMAIL, 'admin')).toBe('protected')
    expect(await setHubUserRole(auth, COMPUTER_SERVICE_USER_EMAIL, 'user')).toBe('protected')
  })

  it('returns not-found for an unknown email', async () => {
    await create('alice@example.com')
    expect(await setHubUserRole(auth, 'nobody@example.com', 'admin')).toBe('not-found')
  })
})

describe('disableHubUser', () => {
  /** alice (admin) and bob (user, signed in); returns bob and his bearer. */
  async function twoUsers(): Promise<{ bob: CreatedHubUser; token: string }> {
    await create('alice@example.com')
    const bob = await create('bob@example.com')
    const { token } = await signIn('bob@example.com', bob.password)
    return { bob, token }
  }

  it('keeps every row of the account and revokes its sessions', async () => {
    const { bob, token } = await twoUsers()
    // A membership row, as the organization plugin writes it.
    await auth.api.createOrganization({
      headers: new Headers(bearer(token)),
      body: { name: 'Team', slug: 'team' }
    })
    await signIn('bob@example.com', bob.password)
    expect(rowsOf(bob.id)).toEqual({ user: 1, account: 1, member: 1, session: 2 })

    expect(await disableHubUser(auth, 'bob@example.com')).toBe('ok')

    expect(rowsOf(bob.id)).toEqual({ user: 1, account: 1, member: 1, session: 0 })
    expect(await verifySession(auth, bearer(token))).toBeNull()
    expect(await findHubAccount(auth, bob.id)).toEqual({
      userId: bob.id,
      role: 'user',
      disabled: true
    })
  })

  it('blocks password sign-in with ACCOUNT_DISABLED and creates no session', async () => {
    const { bob } = await twoUsers()
    expect(await disableHubUser(auth, 'bob@example.com')).toBe('ok')
    await expect(signIn('bob@example.com', bob.password)).rejects.toMatchObject({
      status: 'FORBIDDEN',
      body: { code: 'ACCOUNT_DISABLED' }
    })
    expect(rowsOf(bob.id).session).toBe(0)
    // A wrong password still answers like any wrong password.
    await expect(signIn('bob@example.com', 'not-the-password')).rejects.toMatchObject({
      status: 'UNAUTHORIZED'
    })
  })

  it('revokes the sessions held outside hub-auth through the callback', async () => {
    const { bob } = await twoUsers()
    const revoked: string[] = []
    const result = await disableHubUser(auth, 'bob@example.com', {
      revokeExternalSessions: async (userId) => {
        // Called after the flag landed, so nothing can mint a new one meanwhile.
        expect((await findHubAccount(auth, userId))!.disabled).toBe(true)
        revoked.push(userId)
      }
    })
    expect(result).toBe('ok')
    expect(revoked).toEqual([bob.id])
  })

  it('verification refuses a session that exists for a disabled account', async () => {
    // A session created in the instant before the flag landed: simulated by
    // flagging the row directly, without the revocation sweep.
    const { token } = await twoUsers()
    const db = new DatabaseSync(dbPath)
    db.prepare("UPDATE user SET disabledAt = ? WHERE email = 'bob@example.com'").run(
      new Date().toISOString()
    )
    db.close()
    expect(await verifySession(auth, bearer(token))).toBeNull()
  })

  it('leaves other accounts’ sessions intact', async () => {
    const alice = await create('alice@example.com')
    await create('bob@example.com')
    const a = await signIn('alice@example.com', alice.password)
    expect(await disableHubUser(auth, 'bob@example.com')).toBe('ok')
    expect(await verifySession(auth, bearer(a.token))).not.toBeNull()
  })

  it('is idempotent and keeps the original time', async () => {
    await twoUsers()
    expect(await disableHubUser(auth, 'bob@example.com')).toBe('ok')
    const first = (await listHubUsers(auth))[1]!.disabledAt
    expect(await disableHubUser(auth, 'Bob@Example.com')).toBe('ok')
    expect((await listHubUsers(auth))[1]!.disabledAt).toBe(first)
  })

  it('refuses the last enabled human', async () => {
    await create('alice@example.com')
    expect(await disableHubUser(auth, 'alice@example.com')).toBe('last-user')
    // A disabled second human does not unlock it.
    await create('bob@example.com')
    expect(await disableHubUser(auth, 'bob@example.com')).toBe('ok')
    expect(await disableHubUser(auth, 'alice@example.com')).toBe('last-user')
  })

  it('counts humans only — the service user does not unlock the last-user refusal', async () => {
    await mintComputerApiKey(auth, { computerId: 'computer-1', name: 'ci-computer' })
    await create('alice@example.com')
    expect(await disableHubUser(auth, 'alice@example.com')).toBe('last-user')
  })

  it('refuses the last enabled admin', async () => {
    const alice = await create('alice@example.com')
    await create('bob@example.com')
    expect(await disableHubUser(auth, 'alice@example.com')).toBe('last-admin')
    expect((await findHubAccount(auth, alice.id))!.disabled).toBe(false)
    // With a second admin, the first can go.
    expect(await setHubUserRole(auth, 'bob@example.com', 'admin')).toBe('ok')
    expect(await disableHubUser(auth, 'alice@example.com')).toBe('ok')
  })

  it('refuses the computer service user, leaving computer keys working', async () => {
    const minted = await mintComputerApiKey(auth, { computerId: 'computer-1', name: 'ci-computer' })
    await create('alice@example.com')
    await create('bob@example.com')
    expect(await disableHubUser(auth, COMPUTER_SERVICE_USER_EMAIL)).toBe('protected')
    expect(await verifyComputerApiKey(auth, minted.key)).toEqual({
      computerId: 'computer-1',
      keyId: minted.keyId
    })
  })

  it('returns not-found for an unknown email', async () => {
    await twoUsers()
    expect(await disableHubUser(auth, 'nobody@example.com')).toBe('not-found')
  })
})

describe('enableHubUser', () => {
  it('restores sign-in; the old sessions stay revoked', async () => {
    await create('alice@example.com')
    const bob = await create('bob@example.com')
    const old = await signIn('bob@example.com', bob.password)
    expect(await disableHubUser(auth, 'bob@example.com')).toBe('ok')

    expect(await enableHubUser(auth, 'BOB@example.com')).toBe('ok')

    expect(await verifySession(auth, bearer(old.token))).toBeNull()
    const again = await signIn('bob@example.com', bob.password)
    expect(await verifySession(auth, bearer(again.token))).not.toBeNull()
    expect((await listHubUsers(auth))[1]!.disabledAt).toBeNull()
  })

  it('refuses the computer service user and unknown emails', async () => {
    await mintComputerApiKey(auth, { computerId: 'computer-1', name: 'ci-computer' })
    await create('alice@example.com')
    expect(await enableHubUser(auth, COMPUTER_SERVICE_USER_EMAIL)).toBe('protected')
    expect(await enableHubUser(auth, 'nobody@example.com')).toBe('not-found')
  })
})
