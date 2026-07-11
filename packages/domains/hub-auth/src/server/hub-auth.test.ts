import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createHubAuth, type HubAuth, RUNNER_KEY_PREFIX } from './auth'
import { mintRunnerApiKey, revokeRunnerApiKey, RUNNER_SERVICE_USER_EMAIL } from './runner-keys'
import { requireApiKey, requireSession, verifyRunnerApiKey, verifySession } from './verify'

const EMAIL = 'alice@example.com'
const PASSWORD = 'super-secret-password-1'

let tmpDir: string
let dbPath: string
let auth: HubAuth

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'hub-auth-test-'))
  dbPath = join(tmpDir, 'hub-auth.sqlite')
  auth = await createHubAuth({
    dbPath,
    baseURL: 'http://127.0.0.1:9999',
    secret: 'hub-auth-test-secret-at-least-32-chars-long'
  })
})

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true })
})

/** Minimal express req/res/next doubles for middleware tests. */
function fakeReqRes(headers: Record<string, string>) {
  const req = { headers } as never
  const state: { statusCode: number | null; body: unknown; nextCalls: unknown[] } = {
    statusCode: null,
    body: null,
    nextCalls: []
  }
  const res = {
    locals: {} as Record<string, unknown>,
    status(code: number) {
      state.statusCode = code
      return this
    },
    json(body: unknown) {
      state.body = body
      return this
    }
  }
  const next = (...args: unknown[]) => {
    state.nextCalls.push(args)
  }
  return { req, res, next, state }
}

describe('migrations', () => {
  it('creates the better-auth schema in its own sqlite file', () => {
    const db = new DatabaseSync(dbPath, { readOnly: true })
    try {
      const rows = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
        .all() as {
        name: string
      }[]
      const tables = rows.map((r) => r.name)
      for (const table of [
        'user',
        'session',
        'account',
        'verification',
        'jwks',
        'organization',
        'member',
        'invitation',
        'apikey'
      ]) {
        expect(tables).toContain(table)
      }
    } finally {
      db.close()
    }
  })

  it('is idempotent — a second createHubAuth on the same file succeeds', async () => {
    const again = await createHubAuth({
      dbPath,
      baseURL: 'http://127.0.0.1:9999',
      secret: 'hub-auth-test-secret-at-least-32-chars-long'
    })
    expect(again.api).toBeDefined()
  })
})

describe('sign-up / sign-in (in-process auth.api)', () => {
  it('signs up a user with email + password', async () => {
    const result = await auth.api.signUpEmail({
      body: { email: EMAIL, password: PASSWORD, name: 'Alice' }
    })
    expect(result.user.email).toBe(EMAIL)
    expect(result.token).toBeTruthy()
  })

  it('signs in the user and returns a session token', async () => {
    const result = await auth.api.signInEmail({
      body: { email: EMAIL, password: PASSWORD }
    })
    expect(result.user.email).toBe(EMAIL)
    expect(result.token).toBeTruthy()
  })

  it('rejects a wrong password', async () => {
    await expect(
      auth.api.signInEmail({ body: { email: EMAIL, password: 'wrong-password-123' } })
    ).rejects.toMatchObject({ status: 'UNAUTHORIZED' })
  })
})

describe('bearer-token verification', () => {
  let token: string

  beforeAll(async () => {
    const result = await auth.api.signInEmail({ body: { email: EMAIL, password: PASSWORD } })
    token = result.token
  })

  it('resolves a session from an Authorization: Bearer header', async () => {
    const session = await auth.api.getSession({
      headers: new Headers({ authorization: `Bearer ${token}` })
    })
    expect(session?.user.email).toBe(EMAIL)
  })

  it('verifySession returns a HubAuthContext (web Headers)', async () => {
    const context = await verifySession(auth, new Headers({ authorization: `Bearer ${token}` }))
    expect(context).not.toBeNull()
    expect(context?.userId).toBeTruthy()
    expect(context?.orgId).toBeNull()
    expect(context?.session.token).toBeTruthy()
  })

  it('verifySession accepts node-style header objects', async () => {
    const context = await verifySession(auth, { authorization: `Bearer ${token}` })
    expect(context?.userId).toBeTruthy()
  })

  it('verifySession returns null for a bogus token', async () => {
    const context = await verifySession(auth, new Headers({ authorization: 'Bearer bogus-token' }))
    expect(context).toBeNull()
  })

  it('requireSession middleware attaches res.locals.hubAuth and calls next', async () => {
    const { req, res, next, state } = fakeReqRes({ authorization: `Bearer ${token}` })
    await requireSession(auth)(req, res as never, next)
    expect(state.nextCalls).toEqual([[]])
    expect((res.locals.hubAuth as { userId: string }).userId).toBeTruthy()
  })

  it('requireSession middleware rejects a missing session with 401', async () => {
    const { req, res, next, state } = fakeReqRes({})
    await requireSession(auth)(req, res as never, next)
    expect(state.statusCode).toBe(401)
    expect(state.nextCalls).toEqual([])
    expect(res.locals.hubAuth).toBeUndefined()
  })
})

describe('runner API keys (create / verify / revoke)', () => {
  it('mints, verifies, and revokes a runner key', async () => {
    const minted = await mintRunnerApiKey(auth, { runnerId: 'runner-1', name: 'ci-runner' })
    expect(minted.key.startsWith(RUNNER_KEY_PREFIX)).toBe(true)
    expect(minted.keyId).toBeTruthy()
    expect(minted.runnerId).toBe('runner-1')

    const principal = await verifyRunnerApiKey(auth, minted.key)
    expect(principal).toEqual({ runnerId: 'runner-1', keyId: minted.keyId })

    const verified = await auth.api.verifyApiKey({ body: { key: minted.key } })
    expect(verified.valid).toBe(true)

    const revoked = await revokeRunnerApiKey(auth, minted.keyId)
    expect(revoked).toBe(true)

    expect(await verifyRunnerApiKey(auth, minted.key)).toBeNull()
    const afterRevoke = await auth.api.verifyApiKey({ body: { key: minted.key } })
    expect(afterRevoke.valid).toBe(false)
  })

  it('revoking an unknown key returns false', async () => {
    expect(await revokeRunnerApiKey(auth, 'no-such-key-id')).toBe(false)
  })

  it('rejects keys that carry no runner metadata', async () => {
    const ctx = await auth.$context
    const serviceUser = await ctx.internalAdapter.findUserByEmail(RUNNER_SERVICE_USER_EMAIL)
    expect(serviceUser).not.toBeNull()
    const plain = await auth.api.createApiKey({
      body: { name: 'not-a-runner-key', userId: serviceUser!.user.id }
    })
    expect(await verifyRunnerApiKey(auth, plain.key)).toBeNull()
  })

  it('requireApiKey middleware attaches res.locals.runner and calls next', async () => {
    const minted = await mintRunnerApiKey(auth, { runnerId: 'runner-2', name: 'mw-runner' })
    const { req, res, next, state } = fakeReqRes({ 'x-api-key': minted.key })
    await requireApiKey(auth)(req, res as never, next)
    expect(state.nextCalls).toEqual([[]])
    expect(res.locals.runner).toEqual({ runnerId: 'runner-2', keyId: minted.keyId })
  })

  it('requireApiKey middleware rejects missing and invalid keys with 401', async () => {
    const missing = fakeReqRes({})
    await requireApiKey(auth)(missing.req, missing.res as never, missing.next)
    expect(missing.state.statusCode).toBe(401)
    expect(missing.state.nextCalls).toEqual([])

    const invalid = fakeReqRes({ 'x-api-key': `${RUNNER_KEY_PREFIX}not-a-real-key` })
    await requireApiKey(auth)(invalid.req, invalid.res as never, invalid.next)
    expect(invalid.state.statusCode).toBe(401)
    expect(invalid.state.nextCalls).toEqual([])
  })
})

describe('organization create + member add', () => {
  it('creates an organization and adds a second member (server-side)', async () => {
    const owner = await auth.api.signUpEmail({
      body: { email: 'owner@example.com', password: PASSWORD, name: 'Owner' }
    })
    const org = await auth.api.createOrganization({
      body: { name: 'SlayZone Hub', slug: 'slayzone-hub', userId: owner.user.id }
    })
    expect(org?.id).toBeTruthy()
    expect(org?.slug).toBe('slayzone-hub')

    const invitee = await auth.api.signUpEmail({
      body: { email: 'member@example.com', password: PASSWORD, name: 'Member' }
    })
    const member = await auth.api.addMember({
      body: { userId: invitee.user.id, organizationId: org!.id, role: 'member' }
    })
    expect(member?.organizationId).toBe(org!.id)
    expect(member?.userId).toBe(invitee.user.id)
    expect(member?.role).toBe('member')
  })
})
