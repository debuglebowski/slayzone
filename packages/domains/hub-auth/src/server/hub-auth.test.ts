import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createHubAuth, type HubAuth, COMPUTER_KEY_PREFIX } from './auth'
import {
  mintComputerApiKey,
  revokeComputerApiKey,
  COMPUTER_SERVICE_USER_EMAIL
} from './computer-keys'
import { createHubUser } from './users'
import { requireApiKey, requireSession, verifyComputerApiKey, verifySession } from './verify'

const EMAIL = 'alice@example.com'

let tmpDir: string
let dbPath: string
let auth: HubAuth
/**
 * Password of the primary test account. Not a constant: public signup is closed
 * (`disableSignUp`), so accounts come from `createHubUser`, which GENERATES the
 * password and returns it once. Captured here in `beforeAll` so every suite below
 * can sign in without depending on another suite having run first.
 */
let password: string

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'hub-auth-test-'))
  dbPath = join(tmpDir, 'hub-auth.sqlite')
  auth = await createHubAuth({
    dbPath,
    baseURL: 'http://127.0.0.1:9999',
    secret: 'hub-auth-test-secret-at-least-32-chars-long'
  })
  const created = await createHubUser(auth, { email: EMAIL, name: 'Alice' })
  if ('error' in created) throw new Error(`test setup: could not create ${EMAIL}`)
  password = created.password
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

describe('sign-in (in-process auth.api)', () => {
  it('signs in the account and returns a session token', async () => {
    const result = await auth.api.signInEmail({ body: { email: EMAIL, password } })
    expect(result.user.email).toBe(EMAIL)
    expect(result.token).toBeTruthy()
  })

  it('rejects a wrong password', async () => {
    await expect(
      auth.api.signInEmail({ body: { email: EMAIL, password: 'wrong-password-123' } })
    ).rejects.toMatchObject({ status: 'UNAUTHORIZED' })
  })

  /**
   * THE regression guard for the whole closed-signup feature. `/api/auth/sign-up/
   * email` is exempt from the hub's bearer gate by necessity (rest-auth.ts), so if
   * `disableSignUp` is ever dropped from auth.ts, an internet-facing hub silently
   * becomes self-registerable by anyone who can reach it. This test is what catches
   * that.
   */
  it('refuses public sign-up — accounts come from createHubUser only', async () => {
    await expect(
      auth.api.signUpEmail({
        body: { email: 'intruder@example.com', password: 'a-perfectly-valid-password', name: 'X' }
      })
    ).rejects.toMatchObject({ status: 'BAD_REQUEST' })
  })
})

describe('bearer-token verification', () => {
  let token: string

  beforeAll(async () => {
    const result = await auth.api.signInEmail({ body: { email: EMAIL, password } })
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

describe('computer API keys (create / verify / revoke)', () => {
  it('mints, verifies, and revokes a computer key', async () => {
    const minted = await mintComputerApiKey(auth, { computerId: 'computer-1', name: 'ci-computer' })
    expect(minted.key.startsWith(COMPUTER_KEY_PREFIX)).toBe(true)
    expect(minted.keyId).toBeTruthy()
    expect(minted.computerId).toBe('computer-1')

    const principal = await verifyComputerApiKey(auth, minted.key)
    expect(principal).toEqual({ computerId: 'computer-1', keyId: minted.keyId })

    const verified = await auth.api.verifyApiKey({ body: { key: minted.key } })
    expect(verified.valid).toBe(true)

    const revoked = await revokeComputerApiKey(auth, minted.keyId)
    expect(revoked).toBe(true)

    expect(await verifyComputerApiKey(auth, minted.key)).toBeNull()
    const afterRevoke = await auth.api.verifyApiKey({ body: { key: minted.key } })
    expect(afterRevoke.valid).toBe(false)
  })

  it('revoking an unknown key returns false', async () => {
    expect(await revokeComputerApiKey(auth, 'no-such-key-id')).toBe(false)
  })

  /**
   * THE regression guard for computer impersonation.
   *
   * `POST /api/auth/api-key/create` is mounted by the apiKey plugin under
   * `/api/auth/`, is authenticated by an ordinary user SESSION, and accepts
   * arbitrary `metadata` because the hub sets `enableMetadata: true`. When
   * `verifyComputerApiKey` resolved computer identity from `metadata.computerId`
   * alone, any account holder could mint a key naming ANY computer — including
   * another user's — and authenticate on `/computers` as that computer. Computers
   * execute arbitrary code, so that is RCE in the victim's OS account.
   *
   * The fix authenticates on `referenceId` (who the key belongs to), which the
   * plugin sets from the session for a client request and which `mintComputerApiKey`
   * sets to the computer service user. Metadata is attacker-controlled;
   * `referenceId` is not.
   */
  it('refuses a session-minted key that merely CLAIMS a computerId', async () => {
    const legit = await mintComputerApiKey(auth, {
      computerId: 'computer-victim',
      name: 'victim-computer'
    })
    // Sanity: the real key works, so the rejection below is meaningful.
    expect(await verifyComputerApiKey(auth, legit.key)).toEqual({
      computerId: 'computer-victim',
      keyId: legit.keyId
    })

    // An ordinary account holder, signed in, forging the victim's computerId.
    const attacker = await createHubUser(auth, { email: 'attacker@example.com' })
    if ('error' in attacker) throw new Error(`could not create attacker: ${attacker.error}`)
    const session = await auth.api.signInEmail({
      body: { email: attacker.email, password: attacker.password }
    })
    const forged = await auth.api.createApiKey({
      headers: new Headers({ authorization: `Bearer ${session.token}` }),
      body: { name: 'forged', metadata: { computerId: 'computer-victim' } }
    })
    expect(forged.key).toBeTruthy()

    // The forged key is a VALID api key — better-auth is happy with it. What must
    // not happen is it resolving to a computer principal.
    const rawValid = await auth.api.verifyApiKey({ body: { key: forged.key } })
    expect(rawValid.valid).toBe(true)
    expect(await verifyComputerApiKey(auth, forged.key)).toBeNull()
  })

  it('verifies the same computer key far more than 10 times (no verify rate limit)', async () => {
    // Regression: the api-key plugin rate-limits KEY VERIFICATION to 10 requests
    // per 24h by default (`rateLimit.maxRequests = 10`, `timeWindow = 86400000`),
    // and every computer reconnect verifies its key once. So the 11th reconnect in a
    // day was denied → `verifyComputerApiKey` → null → the gateway answered `hello`
    // with -32002 → the computer's re-enroll fallback burned its single-use join
    // token → fatal exit, bricked until an operator re-enrolled it. Hub restarts,
    // laptop sleep and network flaps trivially exceed 10 reconnects in a day.
    //
    // The limit also protects nothing: `validateApiKey` LOOKS THE KEY UP FIRST and
    // only then evaluates the limit, so an unknown key never reaches it. It can
    // only throttle the legitimate holder — a machine credential that is either
    // valid or not. 30 here is well past the old ceiling of 10.
    const minted = await mintComputerApiKey(auth, {
      computerId: 'computer-reconnect',
      name: 'flappy'
    })
    for (let i = 1; i <= 30; i += 1) {
      const principal = await verifyComputerApiKey(auth, minted.key)
      expect(principal, `verify #${i} should still succeed`).toEqual({
        computerId: 'computer-reconnect',
        keyId: minted.keyId
      })
    }
  })

  it('heals a key already exhausted under the old default (upgrade path)', async () => {
    // The limit values are ALSO persisted per key at mint time, so an install that
    // upgrades carries keys with `rateLimitEnabled=1, requestCount=10`. Those must
    // recover from the config change alone — no re-enrollment, no data migration.
    // `evaluateRateLimit` checks the global `opts.rateLimit.enabled === false`
    // BEFORE the per-key flag, which is what makes this work; asserted here so a
    // plugin upgrade that reorders those checks fails loudly instead of silently
    // re-bricking every existing computer.
    const minted = await mintComputerApiKey(auth, {
      computerId: 'computer-upgraded',
      name: 'old-key'
    })
    const raw = new DatabaseSync(dbPath)
    raw.exec(
      `UPDATE apikey SET rateLimitEnabled = 1, rateLimitMax = 10, rateLimitTimeWindow = 86400000,
       requestCount = 10, lastRequest = '${new Date().toISOString()}' WHERE id = '${minted.keyId}'`
    )
    raw.close()

    expect(await verifyComputerApiKey(auth, minted.key)).toEqual({
      computerId: 'computer-upgraded',
      keyId: minted.keyId
    })
  })

  it('rejects keys that carry no computer metadata', async () => {
    const ctx = await auth.$context
    const serviceUser = await ctx.internalAdapter.findUserByEmail(COMPUTER_SERVICE_USER_EMAIL)
    expect(serviceUser).not.toBeNull()
    const plain = await auth.api.createApiKey({
      body: { name: 'not-a-computer-key', userId: serviceUser!.user.id }
    })
    expect(await verifyComputerApiKey(auth, plain.key)).toBeNull()
  })

  it('requireApiKey middleware attaches res.locals.computer and calls next', async () => {
    const minted = await mintComputerApiKey(auth, { computerId: 'computer-2', name: 'mw-computer' })
    const { req, res, next, state } = fakeReqRes({ 'x-api-key': minted.key })
    await requireApiKey(auth)(req, res as never, next)
    expect(state.nextCalls).toEqual([[]])
    expect(res.locals.computer).toEqual({ computerId: 'computer-2', keyId: minted.keyId })
  })

  it('requireApiKey middleware rejects missing and invalid keys with 401', async () => {
    const missing = fakeReqRes({})
    await requireApiKey(auth)(missing.req, missing.res as never, missing.next)
    expect(missing.state.statusCode).toBe(401)
    expect(missing.state.nextCalls).toEqual([])

    const invalid = fakeReqRes({ 'x-api-key': `${COMPUTER_KEY_PREFIX}not-a-real-key` })
    await requireApiKey(auth)(invalid.req, invalid.res as never, invalid.next)
    expect(invalid.state.statusCode).toBe(401)
    expect(invalid.state.nextCalls).toEqual([])
  })
})

describe('organization create + member add', () => {
  it('creates an organization and adds a second member (server-side)', async () => {
    const owner = await createHubUser(auth, { email: 'owner@example.com', name: 'Owner' })
    if ('error' in owner) throw new Error('could not create the org owner')
    const org = await auth.api.createOrganization({
      body: { name: 'SlayZone Hub', slug: 'slayzone-hub', userId: owner.id }
    })
    expect(org?.id).toBeTruthy()
    expect(org?.slug).toBe('slayzone-hub')

    const invitee = await createHubUser(auth, { email: 'member@example.com', name: 'Member' })
    if ('error' in invitee) throw new Error('could not create the invitee')
    const member = await auth.api.addMember({
      body: { userId: invitee.id, organizationId: org!.id, role: 'member' }
    })
    expect(member?.organizationId).toBe(org!.id)
    expect(member?.userId).toBe(invitee.id)
    expect(member?.role).toBe('member')
  })
})
