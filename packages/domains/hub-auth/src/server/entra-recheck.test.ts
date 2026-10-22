/**
 * The Entra re-check (T-12) against a REAL better-auth instance with Entra sign-in and a
 * FAKE Entra reached through the injected `fetch`: a token endpoint that checks the
 * hub's client assertion and answers each refresh however the case needs, and the
 * tenant's key set. Nothing here talks to Microsoft.
 *
 * Covers: a refusal (`invalid_grant`, `unassigned`) revokes the account's sessions and
 * keeps the account enabled; an outage (network, timeout, 503) or a hub-side error keeps
 * them, audited once per outage; a changed app role updates `role`, the last admin
 * included; the rotated refresh token is stored encrypted; only signed-in, enabled
 * accounts are asked; a sign-in during the request wins over the refusal.
 */
import { generateKeyPairSync, type KeyObject } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setSecurityLogSink } from '@slayzone/platform/security-log'
import { decryptOAuthToken, setTokenUtil } from 'better-auth/oauth2'
import type { AuthContext } from 'better-auth'
import { exportJWK, jwtVerify, SignJWT } from 'jose'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createHubAuth, type HubAuth } from './auth'
import {
  ENTRA_ADMIN_ROLE,
  ENTRA_PROVIDER_ID,
  ENTRA_USER_ROLE,
  type EntraSsoConfig,
  entraAccountId
} from './entra'
import { createEntraRecheck, type EntraRecheckOptions } from './entra-recheck'
import { listHubUsers } from './users'

const TENANT = '11111111-2222-3333-4444-555555555555'
const CLIENT_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
const AUTHORITY = 'https://login.fake-entra.test'
const TOKEN_URL = `${AUTHORITY}/${TENANT}/oauth2/v2.0/token`
const KEYS_URL = `${AUTHORITY}/${TENANT}/discovery/v2.0/keys`

const hubKeys = generateKeyPairSync('rsa', { modulusLength: 2048 })
const entraKeys = generateKeyPairSync('rsa', { modulusLength: 2048 })
const strangerKeys = generateKeyPairSync('rsa', { modulusLength: 2048 })

const cfg: EntraSsoConfig = {
  tenantId: TENANT,
  clientId: CLIENT_ID,
  credential: { privateKey: hubKeys.privateKey, thumbprintS256: 'test-thumbprint' },
  requireMfa: true,
  authority: AUTHORITY
}

/** How the fake answers the next refreshes (one entry per request; the last repeats). */
type Answer =
  | {
      kind: 'tokens'
      /** `null`: no `roles` claim at all. */
      roles?: string[] | null
      oid?: string
      rotate?: string | null
      signWith?: KeyObject
    }
  | { kind: 'error'; status: number; error: string; description?: string }
  | { kind: 'network' }
  | { kind: 'timeout' }

class FakeEntra {
  answers: Answer[] = [{ kind: 'tokens' }]
  readonly refreshes: Array<{ refreshToken: string; form: Record<string, string> }> = []
  keyFetches = 0
  /** Runs while a refresh is "in flight" — before the answer is sent. */
  onRequest: (() => Promise<void>) | null = null
  private counter = 0

  readonly fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input instanceof Request ? input.url : input)
    if (url === KEYS_URL) {
      this.keyFetches++
      const jwk = await exportJWK(entraKeys.publicKey)
      return Response.json({ keys: [{ ...jwk, kid: 'k1', use: 'sig', alg: 'RS256' }] })
    }
    if (url !== TOKEN_URL || init?.method !== 'POST') return new Response('no', { status: 404 })
    const form = Object.fromEntries(new URLSearchParams(String(init.body)))
    // What Entra checks: the hub's signed assertion, never a secret.
    if (form.client_secret !== undefined) throw new Error('a client secret was sent')
    await jwtVerify(form.client_assertion ?? '', hubKeys.publicKey, {
      audience: TOKEN_URL,
      issuer: CLIENT_ID,
      subject: CLIENT_ID
    })
    this.refreshes.push({ refreshToken: form.refresh_token ?? '', form })
    await this.onRequest?.()
    const answer = this.answers.length > 1 ? this.answers.shift()! : this.answers[0]!
    switch (answer.kind) {
      case 'network':
        throw new TypeError('fetch failed')
      case 'timeout':
        throw new DOMException('The operation was aborted due to timeout', 'TimeoutError')
      case 'error':
        return Response.json(
          { error: answer.error, error_description: answer.description ?? '' },
          { status: answer.status }
        )
      case 'tokens': {
        const now = Math.floor(Date.now() / 1000)
        const oid = answer.oid ?? this.oidOf.get(form.refresh_token ?? '') ?? 'unknown'
        const idToken = await new SignJWT({
          tid: TENANT,
          oid,
          ...(answer.roles === null ? {} : { roles: answer.roles ?? [ENTRA_USER_ROLE] }),
          preferred_username: `${oid}@normain.test`
        })
          .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
          .setIssuer(`${AUTHORITY}/${TENANT}/v2.0`)
          .setAudience(CLIENT_ID)
          .setIssuedAt(now)
          .setExpirationTime(now + 3600)
          .sign(answer.signWith ?? entraKeys.privateKey)
        const rotate = answer.rotate === undefined ? `rt-rotated-${++this.counter}` : answer.rotate
        if (rotate) this.oidOf.set(rotate, this.oidOf.get(form.refresh_token ?? '') ?? oid)
        return Response.json({
          token_type: 'Bearer',
          access_token: 'at',
          expires_in: 3600,
          id_token: idToken,
          ...(rotate ? { refresh_token: rotate } : {})
        })
      }
    }
  }) as typeof fetch

  /** Whose refresh token is whose: the identity Entra answers for. */
  readonly oidOf = new Map<string, string>()
}

let tmpDir: string
let auth: HubAuth
let entra: FakeEntra
let audit: Array<Record<string, unknown>>
let logs: string[]
let externalRevoked: string[]
let roleChanges: Array<[string, string]>
let externalLive: Set<string>

const tokenCtx = async (): Promise<AuthContext> => (await auth.$context) as unknown as AuthContext

tmpDir = mkdtempSync(join(tmpdir(), 'hub-auth-recheck-test-'))
let dbCounter = 0

beforeEach(async () => {
  auth = await createHubAuth({
    dbPath: join(tmpDir, `auth-${++dbCounter}.sqlite`),
    baseURL: 'http://127.0.0.1:9999',
    secret: 'hub-auth-recheck-test-secret-at-least-32-chars',
    sso: cfg
  })
  entra = new FakeEntra()
  audit = []
  logs = []
  externalRevoked = []
  roleChanges = []
  externalLive = new Set()
  setSecurityLogSink((line) => audit.push(JSON.parse(line) as Record<string, unknown>))
})

afterEach(() => setSecurityLogSink())
afterAll(() => rmSync(tmpDir, { recursive: true, force: true }))

function recheck(overrides: Partial<EntraRecheckOptions> = {}) {
  return createEntraRecheck(auth, {
    cfg,
    fetch: entra.fetch,
    hasExternalSession: async (userId) => externalLive.has(userId),
    revokeExternal: async (userId) => {
      externalRevoked.push(userId)
    },
    onRoleChange: (userId, role) => {
      roleChanges.push([userId, role])
    },
    log: (m) => logs.push(m),
    ...overrides
  })
}

/** An account as an Entra sign-in leaves it: user, Entra account with an encrypted
 *  refresh token, and (unless `signedIn: false`) a live session. */
async function entraUser(
  oid: string,
  opts: { role?: 'admin' | 'user'; signedIn?: boolean; refreshToken?: string | null } = {}
): Promise<{ userId: string; accountId: string }> {
  const ctx = await auth.$context
  const user = await ctx.internalAdapter.createUser({
    email: `${oid}@normain.test`,
    name: oid,
    emailVerified: true,
    role: opts.role ?? 'user'
  })
  const accountId = entraAccountId(oid, TENANT)
  const rt = opts.refreshToken === undefined ? `rt-${oid}` : opts.refreshToken
  if (rt) entra.oidOf.set(rt, oid)
  await ctx.internalAdapter.linkAccount({
    userId: user.id,
    providerId: ENTRA_PROVIDER_ID,
    accountId,
    ...(rt ? { refreshToken: (await setTokenUtil(rt, await tokenCtx())) as string } : {})
  })
  if (opts.signedIn !== false) await ctx.internalAdapter.createSession(user.id)
  return { userId: user.id, accountId }
}

const liveSessions = async (userId: string): Promise<number> =>
  (await (await auth.$context).internalAdapter.listSessions(userId)).length

async function storedRefreshToken(accountId: string): Promise<string | null> {
  const ctx = await auth.$context
  const row = await ctx.internalAdapter.findAccountByProviderId(accountId, ENTRA_PROVIDER_ID)
  return row?.refreshToken ? await decryptOAuthToken(row.refreshToken, await tokenCtx()) : null
}

const recheckLines = () => audit.filter((l) => l.event === 'auth.sso.recheck')

describe('a definite refusal revokes', () => {
  it('invalid_grant: sessions revoked (both classes), the account stays enabled, one denied line', async () => {
    const a = await entraUser('oid-a')
    entra.answers = [
      {
        kind: 'error',
        status: 400,
        error: 'invalid_grant',
        description: 'AADSTS50057: User disabled'
      }
    ]
    const report = await recheck().run()

    expect(report.outcomes).toEqual([
      { userId: a.userId, result: 'revoked', reason: 'invalid_grant' }
    ])
    expect(await liveSessions(a.userId)).toBe(0)
    expect(externalRevoked).toEqual([a.userId])
    const users = await listHubUsers(auth)
    expect(users.find((u) => u.id === a.userId)?.disabledAt).toBeNull()
    expect(await storedRefreshToken(a.accountId)).toBe('rt-oid-a') // the row is kept
    expect(entra.refreshes[0]?.refreshToken).toBe('rt-oid-a')
    expect(entra.refreshes[0]?.form.grant_type).toBe('refresh_token')
    expect(recheckLines()).toEqual([
      expect.objectContaining({
        outcome: 'denied',
        level: 'warn',
        targetKind: 'user',
        targetId: a.userId,
        detail: { reason: 'invalid_grant', aadsts: 'AADSTS50057' }
      })
    ])
    expect(audit.some((l) => l.event === 'auth.session.revoke')).toBe(true)
    expect(JSON.stringify(audit)).not.toContain('rt-oid-a')
  })

  it('interaction_required and consent_required are refusals too', async () => {
    for (const error of ['interaction_required', 'consent_required']) {
      const a = await entraUser(`oid-${error}`)
      entra.answers = [{ kind: 'error', status: 400, error }]
      const report = await recheck().run()
      expect(report.outcomes.find((o) => o.userId === a.userId)).toMatchObject({
        result: 'revoked',
        reason: error
      })
    }
  })

  it('a verified ID token whose roles hold neither app role (unassigned) revokes', async () => {
    const a = await entraUser('oid-a')
    entra.answers = [{ kind: 'tokens', roles: ['SomeOther.Role'] }]
    const report = await recheck().run()
    expect(report.outcomes).toEqual([{ userId: a.userId, result: 'revoked', reason: 'unassigned' }])
    expect(await liveSessions(a.userId)).toBe(0)
  })

  it('an ID token with no roles claim at all is no information: kept, role unchanged', async () => {
    const a = await entraUser('oid-a', { role: 'admin' })
    entra.answers = [{ kind: 'tokens', roles: null }]
    const report = await recheck().run()
    expect(report.outcomes).toEqual([
      { userId: a.userId, result: 'ok', role: 'admin', roleChanged: false }
    ])
    expect(await liveSessions(a.userId)).toBe(1)
  })

  it('a sign-in that replaced the refresh token during the request wins: nothing revoked', async () => {
    const a = await entraUser('oid-a')
    entra.answers = [{ kind: 'error', status: 400, error: 'invalid_grant' }]
    entra.onRequest = async () => {
      const ctx = await auth.$context
      const row = await ctx.internalAdapter.findAccountByProviderId(a.accountId, ENTRA_PROVIDER_ID)
      await ctx.internalAdapter.updateAccount(row!.id, {
        refreshToken: (await setTokenUtil('rt-fresh-sign-in', await tokenCtx())) as string
      })
    }
    const report = await recheck().run()
    expect(report.outcomes[0]).toMatchObject({ result: 'kept', reason: 'signed_in_meanwhile' })
    expect(await liveSessions(a.userId)).toBe(1)
    expect(externalRevoked).toEqual([])
  })
})

describe('anything else keeps the sessions', () => {
  it('network error, timeout and 503: kept, audited once per outage at level info, then recovery', async () => {
    const a = await entraUser('oid-a')
    const b = await entraUser('oid-b')
    const check = recheck()

    entra.answers = [{ kind: 'network' }, { kind: 'timeout' }]
    const first = await check.run()
    expect(first.outcomes.map((o) => o.result)).toEqual(['kept', 'kept'])
    expect(first.outcomes.map((o) => (o as { cause: string }).cause)).toEqual([
      'network',
      'timeout'
    ])
    expect(await liveSessions(a.userId)).toBe(1)
    expect(await liveSessions(b.userId)).toBe(1)
    expect(recheckLines()).toEqual([
      expect.objectContaining({
        outcome: 'failure',
        level: 'info',
        targetKind: 'hub',
        detail: { reason: 'entra_unavailable', cause: 'network', accounts: 2, sessionsKept: true }
      })
    ])

    // Still down an hour later: retried, no second line.
    entra.answers = [{ kind: 'error', status: 503, error: 'temporarily_unavailable' }]
    const second = await check.run()
    expect(entra.refreshes).toHaveLength(4)
    expect(second.outcomes.map((o) => o.result)).toEqual(['kept', 'kept'])
    expect(recheckLines()).toHaveLength(1)
    expect(externalRevoked).toEqual([])

    // Back: one recovery line, nobody signed out.
    entra.answers = [{ kind: 'tokens' }]
    const third = await check.run()
    expect(third.outcomes.map((o) => o.result)).toEqual(['ok', 'ok'])
    expect(recheckLines()).toHaveLength(2)
    expect(recheckLines()[1]).toMatchObject({ outcome: 'success', detail: { reason: 'recovered' } })
    expect(await liveSessions(a.userId)).toBe(1)
  })

  it('429 and a hub-side error (invalid_client) keep the sessions', async () => {
    const a = await entraUser('oid-a')
    entra.answers = [{ kind: 'error', status: 429, error: 'throttled' }]
    expect((await recheck().run()).outcomes[0]).toMatchObject({
      result: 'kept',
      reason: 'entra_unavailable',
      cause: 'http_429'
    })
    entra.answers = [
      { kind: 'error', status: 401, error: 'invalid_client', description: 'AADSTS700027: bad' }
    ]
    expect((await recheck().run()).outcomes[0]).toMatchObject({
      result: 'kept',
      reason: 'entra_error',
      cause: 'invalid_client'
    })
    expect(await liveSessions(a.userId)).toBe(1)
  })

  it('an ID token that does not verify is not a refusal, and changes no role', async () => {
    const a = await entraUser('oid-a')
    entra.answers = [
      { kind: 'tokens', roles: [ENTRA_ADMIN_ROLE], signWith: strangerKeys.privateKey }
    ]
    const report = await recheck().run()
    expect(report.outcomes[0]).toMatchObject({
      result: 'kept',
      reason: 'id_token_untrusted',
      cause: 'invalid_token'
    })
    expect(await liveSessions(a.userId)).toBe(1)
    expect((await listHubUsers(auth))[0]?.role).toBe('user')
  })

  it("an ID token for another subject is not trusted for this account's role", async () => {
    await entraUser('oid-a')
    entra.answers = [{ kind: 'tokens', oid: 'oid-someone-else', roles: [ENTRA_ADMIN_ROLE] }]
    const report = await recheck().run()
    expect(report.outcomes[0]).toMatchObject({ result: 'kept', cause: 'subject_mismatch' })
    expect((await listHubUsers(auth))[0]?.role).toBe('user')
  })
})

describe('a refresh that works', () => {
  it('stores the rotated refresh token, encrypted; the session stays', async () => {
    const a = await entraUser('oid-a')
    entra.answers = [{ kind: 'tokens', rotate: 'rt-rotated-x' }]
    const report = await recheck().run()
    expect(report.outcomes).toEqual([
      { userId: a.userId, result: 'ok', role: 'user', roleChanged: false }
    ])
    expect(await storedRefreshToken(a.accountId)).toBe('rt-rotated-x')
    const raw = (
      await (
        await auth.$context
      ).internalAdapter.findAccountByProviderId(a.accountId, ENTRA_PROVIDER_ID)
    )?.refreshToken
    expect(raw).not.toContain('rt-rotated-x')
    expect(await liveSessions(a.userId)).toBe(1)
    expect(recheckLines()).toEqual([])
  })

  it('a changed app role updates the role, audits it, and asks for reconnects', async () => {
    const admin = await entraUser('oid-admin', { role: 'admin' })
    const a = await entraUser('oid-a')
    entra.answers = [
      { kind: 'tokens', oid: 'oid-admin', roles: [ENTRA_ADMIN_ROLE] },
      { kind: 'tokens', oid: 'oid-a', roles: [ENTRA_ADMIN_ROLE] }
    ]
    const report = await recheck().run()
    expect(report.outcomes).toEqual([
      { userId: admin.userId, result: 'ok', role: 'admin', roleChanged: false },
      { userId: a.userId, result: 'ok', role: 'admin', roleChanged: true }
    ])
    expect(roleChanges).toEqual([[a.userId, 'admin']])
    expect(audit.filter((l) => l.event === 'user.role_change')).toEqual([
      expect.objectContaining({
        outcome: 'success',
        targetId: a.userId,
        detail: { reason: 'sso_recheck', role: 'admin' }
      })
    ])
  })

  it('the only admin losing the app role is demoted (Entra is the authority), flagged noAdminLeft', async () => {
    const admin = await entraUser('oid-admin', { role: 'admin' })
    entra.answers = [{ kind: 'tokens', roles: [ENTRA_USER_ROLE] }]
    await recheck().run()
    expect((await listHubUsers(auth)).find((u) => u.id === admin.userId)?.role).toBe('user')
    expect(audit.find((l) => l.event === 'user.role_change')).toMatchObject({
      level: 'warn',
      detail: { reason: 'sso_recheck', role: 'user', noAdminLeft: true }
    })
    expect(logs.some((m) => m.includes('no enabled admin'))).toBe(true)
    expect(await liveSessions(admin.userId)).toBe(1)
  })
})

describe('who is asked', () => {
  it('only enabled accounts with a refresh token and a live session (either class)', async () => {
    await entraUser('oid-idle', { signedIn: false })
    await entraUser('oid-no-token', { refreshToken: null })
    const disabled = await entraUser('oid-disabled')
    const ctx = await auth.$context
    await ctx.internalAdapter.updateUser(disabled.userId, { disabledAt: new Date() })
    const web = await entraUser('oid-web', { signedIn: false })
    externalLive.add(web.userId)

    const report = await recheck().run()
    expect(report.checked).toBe(1)
    expect(report.outcomes.map((o) => o.userId)).toEqual([web.userId])
    expect(entra.refreshes.map((r) => r.refreshToken)).toEqual(['rt-oid-web'])
  })

  it('no signed-in account: Entra is not contacted at all', async () => {
    await entraUser('oid-idle', { signedIn: false })
    await recheck().run()
    expect(entra.refreshes).toHaveLength(0)
    expect(entra.keyFetches).toBe(0)
  })
})
