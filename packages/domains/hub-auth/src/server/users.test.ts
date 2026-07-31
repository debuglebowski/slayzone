/**
 * Operator account management (`users.ts`) against a REAL better-auth instance on
 * a throwaway node:sqlite file — no mocks. The central assertion is that a created
 * account can actually SIGN IN with the returned password: that is what proves the
 * `createUser` + `linkAccount('credential')` pairing replicates better-auth's own
 * sign-up route. A user row without the credential account would look fine in
 * `ls` and be permanently unauthenticatable.
 *
 * Each `describe` gets its OWN auth instance + sqlite file: `removeHubUser`'s
 * `'last-user'` refusal depends on how many accounts exist, so a shared instance
 * would make these tests order-dependent.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createHubAuth, type HubAuth } from './auth'
import { mintRunnerApiKey, RUNNER_SERVICE_USER_EMAIL } from './runner-keys'
import { createHubUser, listHubUsers, removeHubUser, type CreatedHubUser } from './users'
import { verifyRunnerApiKey, verifySession } from './verify'

let tmpDir: string
let auth: HubAuth

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'hub-users-test-'))
  auth = await createHubAuth({
    dbPath: join(tmpDir, 'hub-auth.sqlite'),
    baseURL: 'http://127.0.0.1:9999',
    secret: 'hub-auth-test-secret-at-least-32-chars-long'
  })
})

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true })
})

/** Create and assert success, narrowing off the `{ error }` arm. */
async function create(email: string, name?: string): Promise<CreatedHubUser> {
  const result = await createHubUser(auth, name === undefined ? { email } : { email, name })
  if ('error' in result) throw new Error(`expected creation to succeed, got ${result.error}`)
  return result
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

  it('excludes the internal runner service user', async () => {
    // Minting a runner key lazily creates the service user, so this is the state
    // any hub with an enrolled runner is really in.
    await mintRunnerApiKey(auth, { runnerId: 'runner-1', name: 'ci-runner' })
    await create('alice@example.com')

    const listed = await listHubUsers(auth)
    expect(listed.map((u) => u.email)).toEqual(['alice@example.com'])
    expect(listed.some((u) => u.email === RUNNER_SERVICE_USER_EMAIL)).toBe(false)

    // It still EXISTS — it is hidden from the operator, not deleted.
    const ctx = await auth.$context
    expect(await ctx.internalAdapter.findUserByEmail(RUNNER_SERVICE_USER_EMAIL)).not.toBeNull()
  })

  it('reports createdAt as an ISO-8601 string', async () => {
    await create('alice@example.com')
    const [row] = await listHubUsers(auth)
    expect(row!.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/)
  })
})

describe('removeHubUser', () => {
  it('removes an account once another human remains', async () => {
    const alice = await create('alice@example.com')
    await create('bob@example.com')

    expect(await removeHubUser(auth, 'alice@example.com')).toBe('ok')
    expect((await listHubUsers(auth)).map((u) => u.email)).toEqual(['bob@example.com'])
    await expect(
      auth.api.signInEmail({ body: { email: 'alice@example.com', password: alice.password } })
    ).rejects.toMatchObject({ status: 'UNAUTHORIZED' })
  })

  it('revokes the removed account’s live sessions', async () => {
    const alice = await create('alice@example.com')
    await create('bob@example.com')
    const signIn = await auth.api.signInEmail({
      body: { email: 'alice@example.com', password: alice.password }
    })
    // Sanity: the bearer works before removal, so its later failure is meaningful.
    expect(await verifySession(auth, { authorization: `Bearer ${signIn.token}` })).not.toBeNull()

    expect(await removeHubUser(auth, 'alice@example.com')).toBe('ok')

    expect(await verifySession(auth, { authorization: `Bearer ${signIn.token}` })).toBeNull()
  })

  it('matches the email case-insensitively', async () => {
    await create('alice@example.com')
    await create('bob@example.com')
    expect(await removeHubUser(auth, 'ALICE@example.com')).toBe('ok')
    expect((await listHubUsers(auth)).map((u) => u.email)).toEqual(['bob@example.com'])
  })

  it('returns not-found for an unknown email', async () => {
    await create('alice@example.com')
    await create('bob@example.com')
    expect(await removeHubUser(auth, 'nobody@example.com')).toBe('not-found')
  })

  it('refuses the last remaining human account', async () => {
    await create('alice@example.com')
    expect(await removeHubUser(auth, 'alice@example.com')).toBe('last-user')
    expect((await listHubUsers(auth)).map((u) => u.email)).toEqual(['alice@example.com'])
  })

  it('counts humans only — the service user does not unlock the last-user refusal', async () => {
    // Two USER ROWS exist here (alice + the runner service identity), but only one
    // human. Counting rows instead of humans would let the operator delete alice
    // and leave the hub with no way to authenticate.
    await mintRunnerApiKey(auth, { runnerId: 'runner-1', name: 'ci-runner' })
    await create('alice@example.com')
    expect(await removeHubUser(auth, 'alice@example.com')).toBe('last-user')
  })

  it('refuses the runner service user, leaving runner keys working', async () => {
    const minted = await mintRunnerApiKey(auth, { runnerId: 'runner-1', name: 'ci-runner' })
    await create('alice@example.com')
    await create('bob@example.com')

    expect(await removeHubUser(auth, RUNNER_SERVICE_USER_EMAIL)).toBe('protected')

    // The point of the refusal: every enrolled runner would 401 if this identity
    // were deleted, because its id is the referenceId on each runner API key.
    expect(await verifyRunnerApiKey(auth, minted.key)).toEqual({
      runnerId: 'runner-1',
      keyId: minted.keyId
    })
  })

  it('leaves other accounts’ sessions intact', async () => {
    const alice = await create('alice@example.com')
    const bob = await create('bob@example.com')
    const bobSignIn = await auth.api.signInEmail({
      body: { email: 'bob@example.com', password: bob.password }
    })

    expect(await removeHubUser(auth, 'alice@example.com')).toBe('ok')

    expect(await verifySession(auth, { authorization: `Bearer ${bobSignIn.token}` })).not.toBeNull()
    // And bob can still sign in fresh.
    const again = await auth.api.signInEmail({
      body: { email: 'bob@example.com', password: bob.password }
    })
    expect(again.token).toBeTruthy()
    expect(alice.password).not.toBe(bob.password)
  })

  it('allows re-creating a removed account', async () => {
    await create('alice@example.com')
    await create('bob@example.com')
    expect(await removeHubUser(auth, 'alice@example.com')).toBe('ok')

    const recreated = await create('alice@example.com')
    const signIn = await auth.api.signInEmail({
      body: { email: 'alice@example.com', password: recreated.password }
    })
    expect(signIn.token).toBeTruthy()
  })
})
