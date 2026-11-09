/**
 * The IdP-role mode (idp-roles.ts) against a REAL better-auth instance and a local
 * generic OpenID issuer (fake-oidc-issuer.ts) over HTTP: sign-in through the code flow,
 * then the gate in `verifySession` for cookies and bearers (the CLI's, the desktop's,
 * the app's). Storage is inspected in the sqlite file itself.
 *
 * Covers: grant (highest of admin/user), downgrade at sign-in and at revalidation, deny
 * and malformed claims revoking every human credential (sessions, bearers, user API
 * keys) while computer keys survive, the freshness deadline at every boundary (missing
 * ID token, failed refresh, stale or replayed `iat`, another subject, refresh
 * unavailable), one refresh per identity at a time, a sign-in racing a refresh, the
 * activation epoch (persisted, idempotent, off → on, pre-epoch sessions dead, new ones
 * alive), local role changes refused, password refused, mode off unchanged, and the
 * contract's audit lines.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { parseConfig, type RoleConfig } from '@normain/idp-role-contract'
import { setSecurityLogSink } from '@slayzone/platform/security-log'
import { isHubSwitchedOffError } from '@slayzone/platform/hub-switch-refusal'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHubAuth, type HubAuth } from './auth'
import { mintComputerApiKey } from './computer-keys'
import { OIDC_PROVIDER_ID } from './entra'
import {
  FakeOidcIssuer,
  type IssuedClaims,
  OIDC_CLIENT_ID,
  OIDC_CLIENT_SECRET
} from './fake-oidc-issuer'
import { idpRolesOf, withIssuanceBinding } from './idp-roles'
import { createHubUser, listHubUsers, setHubUserRole } from './users'
import { authorizeExternalSession, verifyComputerApiKey, verifySession } from './verify'

const BASE_URL = 'http://127.0.0.1:9997'
const SECRET = 'idp-roles-test-secret-at-least-32-characters'
const MAPPING = { 'Hub.Admin': ['admin'], 'Hub.User': ['user'] }

const managed = (over: Record<string, string> = {}): RoleConfig =>
  parseConfig(
    {
      IDP_ROLES_ENABLED: 'true',
      IDP_ROLE_CLAIM: 'roles',
      IDP_ROLE_MAPPING: JSON.stringify(MAPPING),
      ...over
    },
    ['admin', 'user']
  )

let tmpDir: string
let issuer: FakeOidcIssuer
let audit: Array<Record<string, unknown>>
let dbPath: string
let auth: HubAuth
let external: string[]

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'hub-auth-idp-roles-'))
  issuer = new FakeOidcIssuer()
  await issuer.start()
})
afterAll(async () => {
  await issuer.stop()
  rmSync(tmpDir, { recursive: true, force: true })
})

let dbCounter = 0
async function boot(idpRoles: RoleConfig | null = managed(), path = dbPath): Promise<HubAuth> {
  const instance = await createHubAuth({
    dbPath: path,
    baseURL: BASE_URL,
    secret: SECRET,
    enablePassword: false,
    sso: {
      issuer: issuer.issuer,
      clientId: OIDC_CLIENT_ID,
      clientAuth: { method: 'client_secret_basic', secret: OIDC_CLIENT_SECRET },
      requireMfa: false,
      idpRoles
    }
  })
  await idpRolesOf(instance)?.attachHub({
    revokeExternal: async (userId) => void external.push(userId),
    log: () => undefined
  })
  // Sign-in evidence counts only from the second AFTER an activation (idp-roles.ts): the
  // tests' clock moves past it, as a person's next sign-in would.
  later(1100)
  return instance
}

/** Move the (faked) wall clock forward. Only `Date` is faked: timers stay real. */
const later = (ms: number): void => {
  vi.setSystemTime(Date.now() + ms)
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'], now: Date.now() })
  dbPath = join(tmpDir, `auth-${++dbCounter}.sqlite`)
  audit = []
  external = []
  issuer.refreshAnswers = [{ kind: 'tokens' }]
  issuer.refreshes.length = 0
  setSecurityLogSink((line) => audit.push(JSON.parse(line) as Record<string, unknown>))
  auth = await boot()
})
afterEach(() => {
  setSecurityLogSink()
  vi.useRealTimers()
})

const raw = (): DatabaseSync => new DatabaseSync(dbPath)
const nowSec = (): number => Math.floor(Date.now() / 1000)
const cookieHeader = (cookies: string[]): string => cookies.map((c) => c.split(';')[0]).join('; ')

interface SignIn {
  error: string | null
  cookies: string[]
}

/** The browser round trip through the issuer, as one person with these claims. */
async function signIn(claims: IssuedClaims, target: HubAuth = auth): Promise<SignIn> {
  const start = await target.handler(
    new Request(`${BASE_URL}/api/auth/sign-in/social`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: OIDC_PROVIDER_ID, callbackURL: '/' })
    })
  )
  const url = new URL(((await start.json()) as { url: string }).url)
  const code = issuer.issueCode(url, claims)
  const res = await target.handler(
    new Request(
      `${BASE_URL}/api/auth/callback/${OIDC_PROVIDER_ID}?code=${code}&state=${url.searchParams.get('state')}`,
      { headers: { cookie: cookieHeader(start.headers.getSetCookie()) } }
    )
  )
  const location = res.headers.get('location') ?? ''
  return {
    error: new URL(location, BASE_URL).searchParams.get('error'),
    cookies: res.headers.getSetCookie()
  }
}

const person = (sub: string, roles: unknown, extra: Partial<IssuedClaims> = {}): IssuedClaims => ({
  sub,
  extra: { roles },
  ...extra
})

const viaCookie = (s: SignIn, target: HubAuth = auth) =>
  verifySession(target, new Headers({ cookie: cookieHeader(s.cookies) }))
const viaBearer = (token: string, target: HubAuth = auth) =>
  verifySession(target, new Headers({ authorization: `Bearer ${token}` }))

const userRow = (sub: string) =>
  raw()
    .prepare(
      'SELECT id, role, idpSubject, idpVerifiedAt, idpRevision, idpGrantedAt FROM "user" WHERE email = ?'
    )
    .get(`${sub}@example.test`) as
    | {
        id: string
        role: string
        idpSubject: string
        idpVerifiedAt: number | null
        idpRevision: number
        idpGrantedAt: number | null
      }
    | undefined

/** Pretend the evidence was signed `age` seconds ago (time travel in storage). */
const ageEvidence = (sub: string, age: number): void => {
  raw()
    .prepare('UPDATE "user" SET idpVerifiedAt = ? WHERE email = ?')
    .run(nowSec() - age, `${sub}@example.test`)
}

/** A CLI/desktop-style bearer for the account: a better-auth session minted the way the
 *  device and app flows mint theirs — through the adapter (its hooks run), bound to the
 *  SSO authentication that approved it (default: the one that granted current access). */
async function bearerFor(
  userId: string,
  target: HubAuth = auth,
  authAtMs?: number
): Promise<string> {
  const ctx = await target.$context
  const granted = (
    new DatabaseSync(dbPath).prepare('SELECT idpGrantedAt FROM "user" WHERE id = ?').get(userId) as
      | { idpGrantedAt: number | null }
      | undefined
  )?.idpGrantedAt
  const bind = authAtMs ?? granted ?? Date.now()
  return withIssuanceBinding(
    { authAtMs: bind },
    async () => (await ctx.internalAdapter.createSession(userId)).token
  )
}

/** A user-owned API key row (what `/api/auth/api-key/create` would mint). */
async function userApiKey(userId: string): Promise<void> {
  raw()
    .prepare(
      `INSERT INTO apikey (id, configId, referenceId, key, createdAt, updatedAt, enabled)
       VALUES (?, 'default', ?, 'hashed', ?, ?, 1)`
    )
    .run(`k-${userId}`, userId, new Date().toISOString(), new Date().toISOString())
}
const apiKeysOf = (userId: string): number =>
  (
    raw().prepare('SELECT count(*) AS n FROM apikey WHERE referenceId = ?').get(userId) as {
      n: number
    }
  ).n

const events = (name: string) => audit.filter((l) => l.event === name)

// ---------------------------------------------------------------------------

describe('grant', () => {
  it('a mapped role signs in; the role, subject and signed iat are stored; one granted line', async () => {
    const s = await signIn(person('ann', ['Hub.User']))
    expect(s.error).toBeNull()
    expect((await viaCookie(s))?.role).toBe('user')
    const row = userRow('ann')!
    expect(row.role).toBe('user')
    expect(row.idpSubject).toBe('ann')
    expect(Math.abs(row.idpVerifiedAt! - nowSec())).toBeLessThanOrEqual(2)
    expect(events('idp_roles.granted')).toEqual([
      expect.objectContaining({
        outcome: 'success',
        targetId: row.id,
        detail: {
          event: 'idp_roles.granted',
          service: 'slayzone',
          actor: 'idp',
          subject: row.id,
          source: 'oidc',
          previousGrants: [],
          newGrants: ['user'],
          reason: 'sign_in'
        }
      })
    ])
    expect(JSON.stringify(audit)).not.toMatch(/rt-|eyJ|example\.test/)
  })

  it('several mapped values: the highest wins (admin over user); values are case-sensitive', async () => {
    expect((await viaCookie(await signIn(person('bo', ['Hub.User', 'Hub.Admin']))))?.role).toBe(
      'admin'
    )
    expect((await signIn(person('cy', ['hub.admin']))).error).toBe('unable_to_get_user_info')
  })

  it('a later sign-in with a lower role downgrades (and closes what captured the old one)', async () => {
    const first = await signIn(person('di', ['Hub.Admin']))
    expect((await viaCookie(first))?.role).toBe('admin')
    await signIn(person('di', ['Hub.User']))
    // The old session reads the new role: it lives on the account.
    expect((await viaCookie(first))?.role).toBe('user')
    expect(events('user.role_change').at(-1)).toMatchObject({
      detail: { reason: 'sso_claim', role: 'user' }
    })
  })
})

describe('deny and malformed claims revoke every human credential, never automation', () => {
  for (const [label, roles] of [
    ['unmapped value', ['Finance.Reader']],
    ['empty array', []],
    ['not strings', 42],
    ['missing claim', undefined]
  ] as const) {
    it(`${label}: refused; sessions, bearers and user API keys of that identity revoked`, async () => {
      const s = await signIn(person('ed', ['Hub.Admin']))
      const user = userRow('ed')!
      const cli = await bearerFor(user.id)
      await userApiKey(user.id)
      const computer = await mintComputerApiKey(auth, { computerId: 'c-1', name: 'laptop' })
      expect(await viaBearer(cli)).not.toBeNull()
      audit.length = 0

      expect((await signIn(person('ed', roles))).error).toBe('unable_to_get_user_info')
      expect(await viaCookie(s)).toBeNull()
      expect(await viaBearer(cli)).toBeNull()
      expect(apiKeysOf(user.id)).toBe(0)
      expect(userRow('ed')!.role).toBe('user')
      expect(external).toEqual([user.id])
      expect(await verifyComputerApiKey(auth, computer.key)).not.toBeNull()
      expect(events('auth.signin')[0]).toMatchObject({
        outcome: 'denied',
        detail: { reason: 'no_mapped_role' }
      })
      expect(events('idp_roles.denied')[0]).toMatchObject({
        outcome: 'denied',
        detail: { previousGrants: ['admin'], newGrants: [], reason: 'no_mapped_role' }
      })
    })
  }

  it('a person who never signed in is simply refused (no account is created)', async () => {
    expect((await signIn(person('fay', ['Nope']))).error).toBe('unable_to_get_user_info')
    expect(await listHubUsers(auth)).toEqual([])
  })
})

describe('freshness: evidence older than the interval is re-proven at the issuer, or the account loses access', () => {
  async function signedIn(sub = 'gus') {
    const s = await signIn(person(sub, ['Hub.Admin']))
    const user = userRow(sub)!
    return { s, user, cli: await bearerFor(user.id) }
  }

  it('fresh evidence: no request to the issuer at all', async () => {
    const { s, cli } = await signedIn()
    expect((await viaCookie(s))?.role).toBe('admin')
    expect((await viaBearer(cli))?.role).toBe('admin')
    expect(issuer.refreshes).toEqual([])
  })

  it('at the deadline: refreshed, re-mapped (downgrade), the rotated token stored, revalidated line', async () => {
    const { cli, user } = await signedIn()
    ageEvidence('gus', 3600)
    issuer.refreshAnswers = [{ kind: 'tokens', claims: { extra: { roles: ['Hub.User'] } } }]
    const before = raw()
      .prepare('SELECT refreshToken FROM account WHERE userId = ?')
      .get(user.id) as {
      refreshToken: string
    }
    expect((await viaBearer(cli))?.role).toBe('user')
    expect(issuer.refreshes).toHaveLength(1)
    const row = userRow('gus')!
    expect(Math.abs(row.idpVerifiedAt! - nowSec())).toBeLessThanOrEqual(2)
    const after = raw()
      .prepare('SELECT refreshToken FROM account WHERE userId = ?')
      .get(user.id) as {
      refreshToken: string
    }
    expect(after.refreshToken).not.toBe(before.refreshToken)
    expect(events('idp_roles.revalidated')[0]).toMatchObject({
      detail: { previousGrants: ['admin'], newGrants: ['user'], reason: 'role_changed' }
    })
  })

  for (const [label, answer, reason] of [
    [
      'no ID token in the refresh (access token only)',
      { kind: 'tokens', omitIdToken: true },
      'missing_id_token'
    ],
    [
      'the issuer refuses the refresh',
      { kind: 'error', status: 400, error: 'invalid_grant' },
      'refresh_failed'
    ],
    [
      'the issuer is down',
      { kind: 'error', status: 503, error: 'temporarily_unavailable' },
      'refresh_failed'
    ],
    [
      'the refreshed token has no role claim',
      { kind: 'tokens', claims: { extra: { roles: undefined } } },
      'no_mapped_role'
    ],
    [
      'the refreshed token maps no role',
      { kind: 'tokens', claims: { extra: { roles: ['Other'] } } },
      'no_mapped_role'
    ],
    [
      'the refreshed token is signed long ago',
      { kind: 'tokens', claims: { iatOffset: -4000 } },
      'stale_evidence'
    ],
    ['the refreshed token has no iat', { kind: 'tokens', claims: { iat: null } }, 'stale_evidence'],
    [
      'the refreshed token names another subject',
      { kind: 'tokens', claims: { sub: 'mallory' } },
      'verification_failed'
    ]
  ] as const) {
    it(`${label}: refused (${reason}), every human credential revoked, evidence time not advanced`, async () => {
      const { s, cli, user } = await signedIn()
      ageEvidence('gus', 3600)
      const stale = userRow('gus')!.idpVerifiedAt
      issuer.refreshAnswers = [answer as never]
      audit.length = 0
      expect(await viaBearer(cli)).toBeNull()
      expect(await viaCookie(s)).toBeNull()
      expect(userRow('gus')!.idpVerifiedAt).toBe(stale)
      expect(userRow('gus')!.role).toBe('user')
      expect(external).toContain(user.id)
      expect(events('idp_roles.denied')[0]).toMatchObject({ detail: { reason } })
    })
  }

  it('no stored refresh token: refresh unavailable → sign in again', async () => {
    const { cli, user } = await signedIn()
    raw().prepare('UPDATE account SET refreshToken = NULL WHERE userId = ?').run(user.id)
    ageEvidence('gus', 3600)
    expect(await viaBearer(cli)).toBeNull()
    expect(issuer.refreshes).toEqual([])
    expect(events('idp_roles.denied')[0]).toMatchObject({
      detail: { reason: 'refresh_unavailable' }
    })
  })

  it('one second before the deadline still passes without a refresh; at it, never', async () => {
    const { cli } = await signedIn()
    ageEvidence('gus', 3599)
    expect(await viaBearer(cli)).not.toBeNull()
    expect(issuer.refreshes).toEqual([])
    ageEvidence('gus', 3600)
    issuer.refreshAnswers = [{ kind: 'error', status: 400, error: 'invalid_grant' }]
    expect(await viaBearer(cli)).toBeNull()
  })

  it('a shorter interval (IDP_RECHECK_INTERVAL_SECONDS) is honoured', async () => {
    auth = await boot(
      managed({ IDP_RECHECK_INTERVAL_SECONDS: '600' }),
      join(tmpDir, 'short.sqlite')
    )
    const prev = dbPath
    dbPath = join(tmpDir, 'short.sqlite')
    const { cli } = await signedIn('hal')
    ageEvidence('hal', 600)
    issuer.refreshAnswers = [{ kind: 'error', status: 400, error: 'invalid_grant' }]
    expect(await viaBearer(cli)).toBeNull()
    dbPath = prev
  })
})

describe('concurrency', () => {
  it('many requests at the deadline make ONE refresh (per-identity lock), all pass', async () => {
    const s = await signIn(person('ivy', ['Hub.User']))
    ageEvidence('ivy', 3600)
    const results = await Promise.all(Array.from({ length: 5 }, () => viaCookie(s)))
    expect(results.every((r) => r?.role === 'user')).toBe(true)
    expect(issuer.refreshes).toHaveLength(1)
  })

  it('a sign-in landing during a refresh wins: the stale refresh is refused for its request only, nothing is revoked', async () => {
    const first = await signIn(person('jo', ['Hub.User']))
    ageEvidence('jo', 3600)
    let release!: () => void
    issuer.refreshAnswers = [
      { kind: 'tokens', hold: new Promise<void>((r) => (release = r)) },
      { kind: 'tokens' }
    ]
    const racing = viaCookie(first)
    // Wait until the refresh is at the issuer, then sign in again (new refresh token).
    while (issuer.refreshes.length === 0) await new Promise((r) => setTimeout(r, 5))
    const second = signIn(person('jo', ['Hub.Admin']))
    await new Promise((r) => setTimeout(r, 50))
    release()
    const [stale, fresh] = [await racing, await second]
    expect(stale).toBeNull() // that one request is refused (fail closed) …
    expect(fresh.error).toBeNull()
    expect((await viaCookie(fresh))?.role).toBe('admin') // … the newer sign-in stands
    expect(events('idp_roles.denied')).toEqual([])
    expect(external).toEqual([])
  })
})

describe('activation epoch', () => {
  it('turning the mode on ends every human session and credential once; automation survives; restart is idempotent; off → on is a new epoch', async () => {
    const path = join(tmpDir, 'activation.sqlite')
    dbPath = path
    // Mode off: people sign in and hold sessions, bearers and API keys; an admin exists.
    const off = await boot(null, path)
    const s = await signIn(person('kim', ['whatever']), off)
    const kim = userRow('kim')!
    expect(kim.role).toBe('admin') // role mode `hub`: the first account
    const cli = await bearerFor(kim.id, off)
    await userApiKey(kim.id)
    const computer = await mintComputerApiKey(off, { computerId: 'c-2', name: 'build' })
    audit.length = 0

    const on = await boot(managed(), path)
    const epoch1 = raw().prepare('SELECT * FROM slayzone_idp_activation').get() as {
      config_identity: string
      epoch: number
    }
    expect(epoch1.epoch).toBe(1)
    expect(await viaCookie(s, on)).toBeNull()
    expect(await viaBearer(cli, on)).toBeNull()
    // The rows themselves are gone (not only refused by the epoch check).
    expect(
      (
        raw().prepare('SELECT count(*) AS n FROM session WHERE userId = ?').get(kim.id) as {
          n: number
        }
      ).n
    ).toBe(0)
    expect(apiKeysOf(kim.id)).toBe(0)
    expect(userRow('kim')!.role).toBe('user')
    expect(userRow('kim')!.idpVerifiedAt).toBeNull()
    expect(external).toContain(kim.id)
    expect(await verifyComputerApiKey(on, computer.key)).not.toBeNull()
    expect(events('idp_roles.activation')[0]).toMatchObject({
      detail: {
        source: 'activation',
        previousGrants: ['admin'],
        newGrants: [],
        reason: 'activated'
      }
    })

    // A newly verified session is valid, and stays valid across a restart.
    const fresh = await signIn(person('kim', ['Hub.Admin']), on)
    expect((await viaCookie(fresh, on))?.role).toBe('admin')
    audit.length = 0
    const again = await boot(managed(), path)
    expect(
      (raw().prepare('SELECT epoch FROM slayzone_idp_activation').get() as { epoch: number }).epoch
    ).toBe(1)
    expect(events('idp_roles.activation')).toEqual([])
    expect((await viaCookie(fresh, again))?.role).toBe('admin')

    // Off, then on again: a new epoch — the epoch-1 session is dead.
    await boot(null, path)
    expect(
      (
        raw().prepare('SELECT config_identity FROM slayzone_idp_activation').get() as {
          config_identity: string
        }
      ).config_identity
    ).toBe('off')
    const back = await boot(managed(), path)
    expect(
      (raw().prepare('SELECT epoch FROM slayzone_idp_activation').get() as { epoch: number }).epoch
    ).toBe(2)
    expect(await viaCookie(fresh, back)).toBeNull()
  })

  it('changing the mapping, claim or interval is a new epoch; the same config is not', async () => {
    const path = join(tmpDir, 'remap.sqlite')
    const epoch = () =>
      (
        new DatabaseSync(path).prepare('SELECT epoch FROM slayzone_idp_activation').get() as {
          epoch: number
        }
      ).epoch
    await boot(managed(), path)
    await boot(managed(), path)
    expect(epoch()).toBe(1)
    await boot(managed({ IDP_RECHECK_INTERVAL_SECONDS: '1800' }), path)
    expect(epoch()).toBe(2)
    await boot(
      managed({
        IDP_RECHECK_INTERVAL_SECONDS: '1800',
        IDP_ROLE_MAPPING: JSON.stringify({ 'Hub.Admin': ['admin'] })
      }),
      path
    )
    expect(epoch()).toBe(3)
    await boot(
      managed({
        IDP_RECHECK_INTERVAL_SECONDS: '1800',
        IDP_ROLE_MAPPING: JSON.stringify({ 'Hub.Admin': ['admin'] }),
        IDP_ROLE_CLAIM: 'groups'
      }),
      path
    )
    expect(epoch()).toBe(4)
  })

  it('a process still running with the mode OFF authorizes nobody once another boot turned it on', async () => {
    const path = join(tmpDir, 'replica-off.sqlite')
    dbPath = path
    const off = await boot(null, path)
    const s = await signIn(person('pam', ['x']), off)
    expect(await viaCookie(s, off)).not.toBeNull() // both off: unchanged
    const on = await boot(managed(), path)
    expect(await viaCookie(s, off)).toBeNull() // the stale replica fails closed
    const fresh = await signIn(person('pam', ['Hub.User']), on)
    expect(await viaCookie(fresh, off)).toBeNull() // even for a newly verified session
    expect((await viaCookie(fresh, on))?.role).toBe('user')
  })

  it('a process running an OLDER managed config authorizes nobody after a newer activation', async () => {
    const path = join(tmpDir, 'replica-old.sqlite')
    dbPath = path
    const old = await boot(managed(), path)
    const s = await signIn(person('quin', ['Hub.Admin']), old)
    expect((await viaCookie(s, old))?.role).toBe('admin')
    const newer = await boot(
      managed({ IDP_ROLE_MAPPING: JSON.stringify({ 'Hub.Admin': ['user'] }) }),
      path
    )
    const fresh = await signIn(person('quin', ['Hub.Admin']), newer)
    expect((await viaCookie(fresh, newer))?.role).toBe('user')
    // Fresh evidence under the newer config must not pass under the old one.
    expect(await viaCookie(fresh, old)).toBeNull()
    expect(await viaCookie(s, old)).toBeNull()
  })

  it('a session row from a previous epoch is refused even if it survived', async () => {
    const s = await signIn(person('lou', ['Hub.User']))
    raw().prepare('UPDATE session SET idpEpoch = 0').run()
    expect(await viaCookie(s)).toBeNull()
  })
})

describe('late credentials never come back', () => {
  it('a credential issued after a revocation is dead, and stays dead after the next valid sign-in', async () => {
    const s = await signIn(person('rex', ['Hub.Admin']))
    const user = userRow('rex')!
    const before = await bearerFor(user.id)
    // Lose the role at a revalidation: access revoked.
    ageEvidence('rex', 3600)
    issuer.refreshAnswers = [{ kind: 'tokens', claims: { extra: { roles: ['Other'] } } }]
    expect(await viaCookie(s)).toBeNull()
    // A code approved BEFORE the revocation is redeemed late: no session is minted …
    const approvedAt = Date.now() - 1000
    await expect(bearerFor(user.id, auth, approvedAt)).rejects.toThrow()
    // … nor after the person signs in validly again.
    issuer.refreshAnswers = [{ kind: 'tokens' }]
    later(1100)
    const again = await signIn(person('rex', ['Hub.User']))
    expect((await viaCookie(again))?.role).toBe('user')
    await expect(bearerFor(user.id, auth, approvedAt)).rejects.toThrow()
    expect(await viaBearer(before)).toBeNull()
    // A code approved under the new grant mints normally.
    expect((await viaBearer(await bearerFor(user.id)))?.role).toBe('user')
    expect(
      events('idp_roles.denied').map((l) => (l.detail as { reason: string }).reason)
    ).toContain('stale_authorization')
  })

  it('a session that SURVIVED a revocation (a failed revoke outside hub-auth) stays dead after the next valid sign-in', async () => {
    await signIn(person('uma', ['Hub.User']))
    const user = userRow('uma')!
    const webCreatedAt = Date.now() // a web session minted under the first grant
    expect((await authorizeExternalSession(auth, user.id, webCreatedAt)).ok).toBe(true)
    // Revoked (no mapped role); the hub's web-session revocation is assumed to have failed.
    expect((await signIn(person('uma', ['Other']))).error).not.toBeNull()
    expect((await authorizeExternalSession(auth, user.id, webCreatedAt)).ok).toBe(false)
    later(1100)
    await signIn(person('uma', ['Hub.User']))
    // The old web session predates the new grant: still refused. A new one passes.
    expect((await authorizeExternalSession(auth, user.id, webCreatedAt)).ok).toBe(false)
    expect((await authorizeExternalSession(auth, user.id, Date.now())).ok).toBe(true)
  })

  it('a session minted with no binding at all is refused (fail closed)', async () => {
    await signIn(person('ria', ['Hub.User']))
    const ctx = await auth.$context
    await expect(ctx.internalAdapter.createSession(userRow('ria')!.id)).rejects.toThrow()
  })
})

describe('sign-in evidence only moves forward', () => {
  it('a sign-in signed before the stored evidence cannot put back an older role', async () => {
    later(40_000) // well after the activation, so -30 s is still after its cutoff
    await signIn(person('sid', ['Hub.Admin']))
    const s = await signIn(person('sid', ['Hub.User']))
    expect((await viaCookie(s))?.role).toBe('user')
    // A delayed callback carrying OLDER evidence (signed 30 s before) for the admin role.
    const late = await signIn(person('sid', ['Hub.Admin'], { iatOffset: -30 }))
    expect(late.error).not.toBeNull()
    expect(userRow('sid')!.role).toBe('user')
    expect((await viaCookie(s))?.role).toBe('user')
    expect(events('idp_roles.denied').at(-1)).toMatchObject({
      detail: { reason: 'superseded_evidence' }
    })
  })

  it('across a revocation: evidence signed before it never restores access (pre-cutoff)', async () => {
    await signIn(person('tia', ['Hub.Admin']))
    // Denied (no mapped role): access revoked, evidence time left as it was.
    expect((await signIn(person('tia', ['Other']))).error).not.toBeNull()
    expect(userRow('tia')!.idpGrantedAt).toBeNull()
    audit.length = 0
    // A delayed callback signed 5 s before that evidence — fresh, but older: refused.
    const older = await signIn(person('tia', ['Hub.Admin'], { iatOffset: -5 }))
    expect(older.error).not.toBeNull()
    expect(userRow('tia')!.idpGrantedAt).toBeNull()
    expect(userRow('tia')!.role).toBe('user')
    expect(events('idp_roles.denied')[0]).toMatchObject({
      detail: { reason: 'pre_cutoff_evidence' }
    })
  })
})

/** Start a sign-in and let the issuer sign the evidence NOW; complete it later. */
async function pendingSignIn(claims: IssuedClaims, target: HubAuth = auth) {
  const start = await target.handler(
    new Request(`${BASE_URL}/api/auth/sign-in/social`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: OIDC_PROVIDER_ID, callbackURL: '/' })
    })
  )
  const url = new URL(((await start.json()) as { url: string }).url)
  // Signed now: an exact iat, whenever the callback is finally processed.
  const code = issuer.issueCode(url, { ...claims, iat: nowSec() })
  const cookie = cookieHeader(start.headers.getSetCookie())
  return async (finisher: HubAuth): Promise<SignIn> => {
    const res = await finisher.handler(
      new Request(
        `${BASE_URL}/api/auth/callback/${OIDC_PROVIDER_ID}?code=${code}&state=${url.searchParams.get('state')}`,
        { headers: { cookie } }
      )
    )
    return {
      error: new URL(res.headers.get('location') ?? '', BASE_URL).searchParams.get('error'),
      cookies: res.headers.getSetCookie()
    }
  }
}

describe('denials are ordered like grants: an older unmapped callback never revokes newer access', () => {
  it('old denial (signed earlier) completes AFTER a newer valid sign-in: refused itself, revokes nothing', async () => {
    await signIn(person('yul', ['Hub.User']))
    const staleDenial = await pendingSignIn(person('yul', ['Finance.Reader']))
    later(1100)
    const newer = await signIn(person('yul', ['Hub.Admin']))
    expect((await viaCookie(newer))?.role).toBe('admin')
    audit.length = 0
    const delayed = await staleDenial(auth)
    expect(delayed.error).not.toBeNull() // that sign-in is still refused …
    expect((await viaCookie(newer))?.role).toBe('admin') // … and the newer access stands
    expect(userRow('yul')!.idpGrantedAt).not.toBeNull()
    expect(external).toEqual([])
    expect(events('idp_roles.denied').map((l) => (l.detail as { reason: string }).reason)).toEqual([
      'superseded_denial'
    ])
  })

  it('a denial signed before the current activation revokes nothing in the new epoch', async () => {
    const signedAt = nowSec()
    later(1100)
    const newer = await boot(managed({ IDP_RECHECK_INTERVAL_SECONDS: '1800' }))
    const fresh = await signIn(person('zed', ['Hub.User']), newer)
    expect((await viaCookie(fresh, newer))?.role).toBe('user')
    // An unmapped token signed before the activation arrives on a request made now.
    expect((await signIn(person('zed', ['Other'], { iat: signedAt }), newer)).error).not.toBeNull()
    expect((await viaCookie(fresh, newer))?.role).toBe('user')
  })

  it('a NEWER denial still revokes (and same-second as the stored evidence revokes: fail closed)', async () => {
    const s = await signIn(person('ada', ['Hub.User']))
    expect((await signIn(person('ada', ['Other']))).error).not.toBeNull() // same second
    expect(await viaCookie(s)).toBeNull()
    expect(events('idp_roles.denied').at(-1)).toMatchObject({
      detail: { reason: 'no_mapped_role' }
    })
  })
})

describe('evidence cutoff: a login pending across an activation or a revocation never completes', () => {
  it('request + evidence → activation (another boot) → delayed callback: refused; a truly fresh SSO works', async () => {
    const complete = await pendingSignIn(person('vic', ['Hub.Admin']))
    const signedAt = nowSec()
    later(1100)
    const newer = await boot(managed({ IDP_RECHECK_INTERVAL_SECONDS: '1800' }))
    // The activation removed the pending sign-in state outright …
    expect((raw().prepare('SELECT count(*) AS n FROM verification').get() as { n: number }).n).toBe(
      0
    )
    const delayed = await complete(newer)
    expect(delayed.error).not.toBeNull()
    expect(userRow('vic')?.idpGrantedAt ?? null).toBeNull()
    // … and evidence signed before the activation is refused even on a request started
    // after it (the cutoff, independent of the state removal).
    audit.length = 0
    const replayed = await signIn(person('vic', ['Hub.Admin'], { iat: signedAt }), newer)
    expect(replayed.error).not.toBeNull()
    expect(events('idp_roles.denied')[0]).toMatchObject({
      detail: { reason: 'pre_cutoff_evidence' }
    })
    later(1100)
    const fresh = await signIn(person('vic', ['Hub.Admin']), newer)
    expect((await viaCookie(fresh, newer))?.role).toBe('admin')
  })

  it('request + evidence → denial (revocation) → delayed callback: refused; a truly fresh SSO works', async () => {
    await signIn(person('wyn', ['Hub.User']))
    const complete = await pendingSignIn(person('wyn', ['Hub.Admin']))
    later(1100)
    expect((await signIn(person('wyn', ['Other']))).error).not.toBeNull() // revoked
    audit.length = 0
    const delayed = await complete(auth)
    expect(delayed.error).not.toBeNull()
    expect(userRow('wyn')!.idpGrantedAt).toBeNull()
    expect(userRow('wyn')!.role).toBe('user')
    expect(events('idp_roles.denied')[0]).toMatchObject({
      detail: { reason: 'pre_cutoff_evidence' }
    })
    later(1100)
    const fresh = await signIn(person('wyn', ['Hub.User']))
    expect((await viaCookie(fresh))?.role).toBe('user')
  })

  it('the one-second boundary: evidence signed in the same second as the cutoff is refused; the next second passes', async () => {
    await signIn(person('xan', ['Hub.User']))
    later(1100)
    expect((await signIn(person('xan', ['Other']))).error).not.toBeNull()
    // Same wall-clock second as the revocation: refused, conservatively.
    expect((await signIn(person('xan', ['Hub.User']))).error).not.toBeNull()
    later(1000)
    expect((await signIn(person('xan', ['Hub.User']))).error).toBeNull()
  })
})

describe('reserved accounts', () => {
  it('an SSO sign-in carrying a break-glass or service address is refused (reserved_email)', async () => {
    for (const email of ['break-glass@hub.slayzone.local', 'computers@slayzone.internal']) {
      expect((await signIn(person('sam', ['Hub.Admin'], { email }))).error).toBe(
        'unable_to_get_user_info'
      )
    }
    expect(events('auth.signin').map((l) => (l.detail as { reason: string }).reason)).toEqual([
      'reserved_email',
      'reserved_email'
    ])
  })
})

describe('local changes and password', () => {
  it('role changes in the hub are refused (idp-managed), audited; disable/enable still work', async () => {
    await signIn(person('max', ['Hub.User']))
    audit.length = 0
    expect(await setHubUserRole(auth, 'max@example.test', 'admin')).toBe('idp-managed')
    expect(await createHubUser(auth, { email: 'new@example.test', role: 'user' })).toEqual({
      error: 'idp-managed'
    })
    expect(userRow('max')!.role).toBe('user')
    expect(events('idp_roles.local_change_refused')).toHaveLength(2)
    expect(events('idp_roles.local_change_refused')[0]).toMatchObject({
      outcome: 'denied',
      detail: { source: 'local', reason: 'roles_managed_by_idp', newGrants: ['admin'] }
    })
  })

  it('password sign-in is not served and no password account can be made: SSO only', async () => {
    const res = await auth.handler(
      new Request(`${BASE_URL}/api/auth/sign-in/email`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'x@example.test', password: 'whatever-123' })
      })
    )
    expect(res.status).toBe(404)
    await expect(createHubUser(auth, { email: 'x@example.test' })).rejects.toSatisfy(
      isHubSwitchedOffError
    )
  })
})

describe('mode off on a generic issuer (role mode hub)', () => {
  it('the claim is not read, roles are managed in the hub, nothing is gated or audited as idp', async () => {
    auth = await boot(null, join(tmpDir, 'off.sqlite'))
    const a = await signIn(person('ned', undefined), auth)
    const b = await signIn(person('ola', ['Hub.Admin']), auth)
    expect((await viaCookie(a))?.role).toBe('admin')
    expect((await viaCookie(b))?.role).toBe('user')
    expect(await setHubUserRole(auth, 'ola@example.test', 'admin')).toBe('ok')
    expect(audit.some((l) => String(l.event).startsWith('idp_roles.'))).toBe(false)
    expect(idpRolesOf(auth)).toBeNull()
  })
})
