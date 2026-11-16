/**
 * The IdP-role mode through the hub's NATIVE routes: the shared contract's acceptance
 * suite (`@normain/idp-role-contract/fixtures` `runAdapterAcceptance`) plus the hub's
 * own entry points, against a mini hub assembled from the real parts —
 *
 *   hub-auth (generic OIDC, the mode) ← a local OpenID issuer over HTTP
 *   REST gate (rest-auth.ts withRestAuth + verifyRestBearer) → better-auth /api/auth/*
 *                                                            → the REST API (createMcpRestApp)
 *   task CLI relay (cli-relay.ts) ← a computer-side relay client (automation credential)
 *   web sessions (web-sessions.ts), the user-access revoker, the /trpc socket registry
 *
 * Every observation is read from a native response or from storage (the auth sqlite file,
 * the app DB) — never from the shared functions. Each scenario boots its own hub-auth
 * database. Run with: vitest (packages/shared/test-utils/vitest.harness.config.ts)
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  type AuditEvent,
  buildAuditEvent,
  parseConfig,
  ROLES_MANAGED_BY_IDP,
  ROLES_MANAGED_MESSAGE,
  type RoleConfig
} from '@normain/idp-role-contract'
import {
  type AcceptanceObservation,
  type AcceptanceScenario,
  runAdapterAcceptance
} from '@normain/idp-role-contract/fixtures'
import { createMcpRestApp } from '@slayzone/api'
import { createComputerCliRelay } from '@slayzone/computer/cli-relay'
import {
  createAuthExpressApp,
  createHubAuth,
  type HubAuth,
  idpRolesOf,
  mintComputerApiKey,
  verifyComputerApiKey
} from '@slayzone/hub-auth/server'
import {
  FakeOidcIssuer,
  type IssuedClaims,
  mintBoundBearer,
  OIDC_CLIENT_ID,
  OIDC_CLIENT_SECRET,
  signInThroughFakeIssuer
} from '@slayzone/hub-auth/testing'
import type { SlayzoneDb } from '@slayzone/platform'
import { setSecurityLogSink } from '@slayzone/platform/security-log'
import { afterAll, describe, expect, test, vi } from 'vitest'
import { createTestHarness } from '../../../shared/test-utils/ipc-harness.js'
import { createHubCliRelay, relayOwnerAccount } from './cli-relay.js'
import { createHubUsersCapability } from './hub-users.js'
import { verifyRestBearer, withRestAuth } from './rest-auth.js'
import { createTrpcConnectionRegistry } from './trpc-connections.js'
import { createUserAccessRevoker } from './user-access.js'
import {
  hasLiveWebSession,
  mintWebSession,
  resolveWebSession,
  SSO_WEB_SESSION_LIFETIME
} from './web-sessions.js'

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

const tmpDir = mkdtempSync(join(tmpdir(), 'hub-idp-acceptance-'))
// Only `Date` is faked (timers stay real): sign-in evidence counts from the second after
// an activation or a revocation, and the tests step past each cutoff as a person's next
// sign-in would.
vi.useFakeTimers({ toFake: ['Date'], now: Date.now() })
const later = (ms = 1100): void => {
  vi.setSystemTime(Date.now() + ms)
}
const issuer = new FakeOidcIssuer()
await issuer.start()
const harness = await createTestHarness()
const db: SlayzoneDb = harness.slayDb
const audit: Array<Record<string, unknown>> = []
setSecurityLogSink((line) => audit.push(JSON.parse(line) as Record<string, unknown>))
const open: Array<() => Promise<void>> = []

afterAll(async () => {
  for (const close of open.splice(0).reverse()) await close()
  setSecurityLogSink()
  vi.useRealTimers()
  await issuer.stop()
  await harness.cleanup()
  rmSync(tmpDir, { recursive: true, force: true })
})

interface MiniHub {
  auth: HubAuth
  base: string
  authDb: () => DatabaseSync
  rest(
    method: string,
    path: string,
    token?: string,
    body?: unknown
  ): Promise<{ status: number; body: Record<string, unknown> }>
  /** A request from a task terminal on computer `c1` (owned by `owner`), through the relay. */
  relay(path: string): Promise<number>
  setRelayOwner(userId: string | null): void
  signIn(claims: IssuedClaims): Promise<{ error: string | null; token: string | null }>
}

let hubCount = 0
async function bootHub(
  idpRoles: RoleConfig | null,
  authDbPath = join(tmpDir, `auth-${++hubCount}.sqlite`),
  opts: { externalRevokeFails?: boolean } = {}
): Promise<MiniHub> {
  const server: Server = createServer()
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const auth = await createHubAuth({
    dbPath: authDbPath,
    baseURL: base,
    secret: 'hub-idp-acceptance-secret-at-least-32-chars',
    enablePassword: false,
    sso: {
      issuer: issuer.issuer,
      clientId: OIDC_CLIENT_ID,
      clientAuth: { method: 'client_secret_basic', secret: OIDC_CLIENT_SECRET },
      requireMfa: false,
      idpRoles
    }
  })
  const connections = createTrpcConnectionRegistry()
  const userAccess = createUserAccessRevoker({
    db,
    getGateway: () => null,
    connections,
    log: () => undefined
  })
  const idp = idpRolesOf(auth)
  if (idp) {
    await idp.attachHub({
      revokeExternal: opts.externalRevokeFails
        ? async () => {
            throw new Error('web-session store unavailable')
          }
        : (userId) => userAccess.endSessions(userId),
      onRoleChange: (userId) => userAccess.reconnectUser(userId),
      hasExternalSession: (userId) => hasLiveWebSession(db, userId, SSO_WEB_SESSION_LIFETIME),
      log: () => undefined
    })
  }
  const mcpRest = createMcpRestApp({
    db,
    notifyRenderer: () => undefined,
    computers: { getHubUrl: () => 'ws://127.0.0.1:1/computers', getGateway: () => null },
    hubUsers: createHubUsersCapability(() => auth, userAccess),
    restAuth: {
      required: () => true,
      verifyBearer: (h, c) => verifyRestBearer(auth, db, h, c, null)
    }
  })
  const authApp = createAuthExpressApp(auth)
  let relayOwner: string | null = null
  const cliRelay = createHubCliRelay({
    computer: async (id) => (id === 'c1' ? { owner_user_id: relayOwner, revoked_at: null } : null),
    account: (id) => relayOwnerAccount(auth, id),
    dispatch: (req, res) => gated(req, res)
  })
  const gated = withRestAuth({
    getHubAuthRequired: () => true,
    getSsoActive: () => true,
    getPasswordEnabled: () => false,
    getHubAuth: () => auth,
    getDb: () => db,
    resolveInternalPrincipal: cliRelay.principalOf,
    next: (req, res) => {
      if ((req.url ?? '').startsWith('/api/auth/')) authApp(req, res)
      else mcpRest.app(req, res)
    }
  })
  server.on('request', gated)
  const computerSide = await createComputerCliRelay({
    request: (m, p) => cliRelay.request('c1', m, p)
  })
  const capability = computerSide.issue()
  const close = async () => {
    await computerSide.close()
    await cliRelay.close()
    mcpRest.dispose()
    connections.stop()
    await new Promise<void>((r) => server.close(() => r()))
  }
  open.push(close)
  later()
  return {
    auth,
    base,
    authDb: () => new DatabaseSync(authDbPath),
    async rest(method, path, token, body) {
      const res = await fetch(`${base}${path}`, {
        method,
        headers: {
          'content-type': 'application/json',
          ...(token ? { authorization: `Bearer ${token}` } : {})
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) })
      })
      const text = await res.text()
      let parsed: Record<string, unknown> = {}
      try {
        parsed = text ? (JSON.parse(text) as Record<string, unknown>) : {}
      } catch {
        parsed = { text }
      }
      return { status: res.status, body: parsed }
    },
    async relay(path) {
      const res = await fetch(`${computerSide.url}${path}`, {
        headers: { authorization: `Bearer ${capability.token}` }
      })
      await res.arrayBuffer()
      return res.status
    },
    setRelayOwner(userId) {
      relayOwner = userId
    },
    async signIn(claims) {
      const r = await signInThroughFakeIssuer(auth, issuer, base, claims)
      return { error: r.error, token: r.sessionToken }
    }
  }
}

const person = (sub: string, roles: unknown, extra: Partial<IssuedClaims> = {}): IssuedClaims => ({
  sub,
  extra: { roles },
  ...extra
})
const nowSec = (): number => Math.floor(Date.now() / 1000)

function userOf(hub: MiniHub, sub: string) {
  return hub
    .authDb()
    .prepare('SELECT id, role, idpVerifiedAt, idpGrantedAt FROM "user" WHERE email = ?')
    .get(`${sub}@example.test`) as {
    id: string
    role: string
    idpVerifiedAt: number | null
    idpGrantedAt: number | null
  }
}
const sessionsOf = (hub: MiniHub, userId: string): number =>
  (
    hub.authDb().prepare('SELECT count(*) AS n FROM session WHERE userId = ?').get(userId) as {
      n: number
    }
  ).n
const apiKeysOf = (hub: MiniHub, userId: string): number =>
  (
    hub.authDb().prepare('SELECT count(*) AS n FROM apikey WHERE referenceId = ?').get(userId) as {
      n: number
    }
  ).n
function addUserApiKey(hub: MiniHub, userId: string): void {
  const at = new Date().toISOString()
  hub
    .authDb()
    .prepare(
      `INSERT INTO apikey (id, configId, referenceId, key, createdAt, updatedAt, enabled) VALUES (?, 'default', ?, 'h', ?, ?, 1)`
    )
    .run(`k-${userId}-${Math.random()}`, userId, at, at)
}
const ageEvidence = (hub: MiniHub, sub: string, age: number): void => {
  hub
    .authDb()
    .prepare('UPDATE "user" SET idpVerifiedAt = ? WHERE email = ?')
    .run(nowSec() - age, `${sub}@example.test`)
}
const grantsOf = (hub: MiniHub, sub: string, allowed: boolean): string[] =>
  allowed ? [userOf(hub, sub).role] : []

/**
 * One person fully equipped: an SSO session (its token used as a bearer), a CLI-style
 * bearer minted from an approved code, a web session, a user API key, the relay acting
 * for them — and a computer API key (automation).
 */
async function equipped(hub: MiniHub, sub: string, roles: string[]) {
  const s = await hub.signIn(person(sub, roles))
  if (!s.token) throw new Error(`sign-in refused: ${s.error}`)
  const user = userOf(hub, sub)
  const cli = await mintBoundBearer(hub.auth, user.id)
  const web = await mintWebSession(db, {
    userId: user.id,
    scopes: ['full'],
    lifetime: SSO_WEB_SESSION_LIFETIME
  })
  addUserApiKey(hub, user.id)
  const computer = await mintComputerApiKey(hub.auth, { computerId: `c-${sub}`, name: sub })
  hub.setRelayOwner(user.id)
  return { session: s.token, cli, web: web.token, user, computer: computer.key }
}

/** Every human credential of `who` refused and gone; automation alive. */
async function revocationObserved(hub: MiniHub, who: Awaited<ReturnType<typeof equipped>>) {
  const session = await hub.rest('GET', '/api/tasks', who.session)
  const cli = await hub.rest('GET', '/api/tasks', who.cli)
  const relay = await hub.relay('/api/tasks')
  const web = await resolveWebSession(hub.auth, db, who.web)
  return {
    humanSessionsRevoked:
      session.status === 401 && web === null && sessionsOf(hub, who.user.id) === 0,
    userCredentialsRevoked:
      cli.status === 401 && relay === 401 && apiKeysOf(hub, who.user.id) === 0,
    automationCredentialsPreserved: (await verifyComputerApiKey(hub.auth, who.computer)) !== null,
    allowed: session.status === 200 || cli.status === 200 || relay === 200 || web !== null
  }
}

let scenarioCount = 0
async function run(scenario: AcceptanceScenario): Promise<AcceptanceObservation> {
  const sub = `${scenario.replace(/_/g, '-')}-${++scenarioCount}`
  issuer.refreshAnswers = [{ kind: 'tokens' }]
  switch (scenario) {
    case 'mode_off': {
      const hub = await bootHub(null)
      const first = await hub.signIn(person(`${sub}-a`, undefined))
      const second = await hub.signIn(person(`${sub}-b`, ['Hub.Admin']))
      const tasks = await hub.rest('GET', '/api/tasks', first.token!)
      // Roles are the hub's: the first account (admin) promotes the second, as before.
      const promote = await hub.rest('PATCH', '/api/hub/users', first.token!, {
        email: `${sub}-b@example.test`,
        role: 'admin'
      })
      void second
      return {
        nativeIntegration: true,
        allowed: tasks.status === 200,
        grants: [userOf(hub, `${sub}-a`).role],
        localBehaviorPreserved:
          promote.status === 200 &&
          userOf(hub, `${sub}-b`).role === 'admin' &&
          idpRolesOf(hub.auth) === null
      }
    }
    case 'grant': {
      const hub = await bootHub(managed())
      const s = await hub.signIn(person(sub, ['Hub.User']))
      const tasks = await hub.rest('GET', '/api/tasks', s.token!)
      return {
        nativeIntegration: true,
        allowed: tasks.status === 200,
        grants: grantsOf(hub, sub, tasks.status === 200)
      }
    }
    case 'remove': {
      // SlayZone holds one exclusive role: the removal is a downgrade at a revalidation.
      const hub = await bootHub(managed())
      const s = await hub.signIn(person(sub, ['Hub.Admin']))
      const previousGrants = [userOf(hub, sub).role]
      ageEvidence(hub, sub, 3600)
      issuer.refreshAnswers = [{ kind: 'tokens', claims: { extra: { roles: ['Hub.User'] } } }]
      const tasks = await hub.rest('GET', '/api/tasks', s.token!)
      return {
        nativeIntegration: true,
        allowed: tasks.status === 200,
        grants: grantsOf(hub, sub, tasks.status === 200),
        previousGrants
      }
    }
    case 'deny':
    case 'invalid_claim': {
      const hub = await bootHub(managed())
      const who = await equipped(hub, sub, ['Hub.Admin'])
      expect(await hub.relay('/api/tasks')).toBe(200)
      const refused = await hub.signIn(
        person(sub, scenario === 'deny' ? ['Finance.Reader'] : (42 as never))
      )
      const seen = await revocationObserved(hub, who)
      return {
        nativeIntegration: true,
        ...seen,
        allowed: seen.allowed || refused.error === null,
        grants: []
      }
    }
    case 'credentials_revoked': {
      const hub = await bootHub(managed())
      const who = await equipped(hub, sub, ['Hub.User'])
      expect((await hub.rest('GET', '/api/tasks', who.cli)).status).toBe(200)
      ageEvidence(hub, sub, 3600)
      issuer.refreshAnswers = [{ kind: 'tokens', claims: { extra: { roles: ['Other'] } } }]
      const seen = await revocationObserved(hub, who)
      return { nativeIntegration: true, ...seen, grants: [] }
    }
    case 'password_refused': {
      const hub = await bootHub(managed())
      const password = await hub.rest('POST', '/api/auth/sign-in/email', undefined, {
        email: `${sub}@example.test`,
        password: 'correct horse battery'
      })
      const sso = await hub.rest('POST', '/api/auth/sign-in/social', undefined, {
        provider: 'oidc',
        callbackURL: '/'
      })
      return {
        nativeIntegration: true,
        allowed: password.status === 200,
        grants: [],
        statusCode: password.status,
        requiresSso: sso.status === 200 && typeof sso.body.url === 'string'
      }
    }
    case 'local_change_refused': {
      const hub = await bootHub(managed())
      const admin = await hub.signIn(person(`${sub}-admin`, ['Hub.Admin']))
      await hub.signIn(person(sub, ['Hub.User']))
      const res = await hub.rest('PATCH', '/api/hub/users', admin.token!, {
        email: `${sub}@example.test`,
        role: 'admin'
      })
      return {
        nativeIntegration: true,
        allowed: res.status === 200,
        grants: [userOf(hub, sub).role],
        statusCode: res.status,
        errorCode: String(res.body.code),
        message: String(res.body.error)
      }
    }
    case 'freshness_deadline': {
      const hub = await bootHub(managed())
      const who = await equipped(hub, sub, ['Hub.User'])
      ageEvidence(hub, sub, 3600)
      const before = userOf(hub, sub).idpVerifiedAt
      issuer.refreshAnswers = [{ kind: 'tokens', omitIdToken: true }]
      const seen = await revocationObserved(hub, who)
      // Fresh SSO is what restores access.
      later()
      const again = await hub.signIn(person(sub, ['Hub.User']))
      const after = await hub.rest('GET', '/api/tasks', again.token!)
      return {
        nativeIntegration: true,
        allowed: seen.allowed,
        grants: [],
        requiresSso: !seen.allowed && after.status === 200,
        verifiedAtUnchanged: before !== null && before <= nowSec() - 3600
      }
    }
    case 'activation': {
      const path = join(tmpDir, `activation-${sub}.sqlite`)
      const off = await bootHub(null, path)
      const who = await equipped(off, sub, ['anything'])
      expect((await off.rest('GET', '/api/tasks', who.cli)).status).toBe(200)
      const on = await bootHub(managed(), path)
      const epoch = () =>
        on.authDb().prepare('SELECT config_identity, epoch FROM slayzone_idp_activation').get() as {
          config_identity: string
          epoch: number
        }
      const first = epoch()
      on.setRelayOwner(who.user.id)
      const seen = await revocationObserved(on, who)
      // The stale process still running with the mode off authorizes nobody either.
      const staleReplica = await off.rest('GET', '/api/tasks', who.cli)
      const fresh = await on.signIn(person(sub, ['Hub.Admin']))
      const activationLines = audit.filter((l) => l.event === 'idp_roles.activation').length
      const restarted = await bootHub(managed(), path)
      const idempotent =
        epoch().epoch === first.epoch &&
        audit.filter((l) => l.event === 'idp_roles.activation').length === activationLines
      const stillValid = (await restarted.rest('GET', '/api/tasks', fresh.token!)).status === 200
      await bootHub(null, path)
      await bootHub(managed(), path)
      return {
        nativeIntegration: true,
        ...seen,
        allowed: seen.allowed || staleReplica.status === 200,
        grants: [],
        activationPersisted: first.epoch === 1 && first.config_identity !== 'off',
        activationIdempotent: idempotent && epoch().epoch === 2,
        newlyVerifiedSessionValid: stillValid
      }
    }
    case 'audit': {
      const hub = await bootHub(managed())
      const mark = audit.length
      await hub.signIn(person(sub, ['Hub.User', 'Hub.Admin']))
      const line = audit.slice(mark).find((l) => l.event === 'idp_roles.granted')
      return {
        nativeIntegration: true,
        allowed: true,
        grants: [userOf(hub, sub).role],
        audit: line?.detail as AuditEvent
      }
    }
  }
}

describe('the shared acceptance suite over native hub routes', () => {
  test('runAdapterAcceptance: every scenario passes', async () => {
    const { passed } = await runAdapterAcceptance({ run })
    expect(passed).toBe(11)
  })
})

describe('the hub entry points, one by one', () => {
  test('audit lines are the contract shape: canonical, no tokens or emails', async () => {
    const hub = await bootHub(managed())
    const mark = audit.length
    await hub.signIn(person('aud', ['Hub.Admin']))
    const lines = audit.slice(mark).filter((l) => String(l.event).startsWith('idp_roles.'))
    expect(lines.length).toBeGreaterThan(0)
    for (const l of lines) expect(l.detail).toEqual(buildAuditEvent(l.detail as AuditEvent))
    expect(JSON.stringify(audit.slice(mark))).not.toMatch(/example\.test|rt-|eyJ/)
  })

  test('the 409 carries exactly the contract code and message', async () => {
    const hub = await bootHub(managed())
    const admin = await hub.signIn(person('boss', ['Hub.Admin']))
    const res = await hub.rest('POST', '/api/hub/users', admin.token!, {
      email: 'n@example.test',
      role: 'user'
    })
    expect(res.status).toBe(409)
    expect(res.body).toEqual({
      ok: false,
      code: ROLES_MANAGED_BY_IDP,
      error: ROLES_MANAGED_MESSAGE
    })
  })

  test('a web session whose revocation failed is still refused by the gate (and by /trpc)', async () => {
    const hub = await bootHub(managed(), undefined, { externalRevokeFails: true })
    const who = await equipped(hub, 'wes', ['Hub.User'])
    expect(await resolveWebSession(hub.auth, db, who.web)).not.toBeNull()
    expect((await hub.signIn(person('wes', ['Other']))).error).not.toBeNull()
    // The row is still there (its revocation failed) …
    expect(await hasLiveWebSession(db, who.user.id, SSO_WEB_SESSION_LIFETIME)).toBe(true)
    // … but the gate refuses it, also after the person's next valid sign-in.
    expect(await resolveWebSession(hub.auth, db, who.web)).toBeNull()
    later()
    await hub.signIn(person('wes', ['Hub.User']))
    expect(await resolveWebSession(hub.auth, db, who.web)).toBeNull()
  })

  test('relay: the computer credential keeps working, the owner it acts for is gated (deadline, then fresh SSO)', async () => {
    const hub = await bootHub(managed())
    const who = await equipped(hub, 'rel', ['Hub.User'])
    expect(await hub.relay('/api/tasks')).toBe(200)
    ageEvidence(hub, 'rel', 3600)
    issuer.refreshAnswers = [{ kind: 'error', status: 400, error: 'invalid_grant' }]
    expect(await hub.relay('/api/tasks')).toBe(401)
    expect(await verifyComputerApiKey(hub.auth, who.computer)).not.toBeNull()
    issuer.refreshAnswers = [{ kind: 'tokens' }]
    later()
    await hub.signIn(person('rel', ['Hub.User']))
    expect(await hub.relay('/api/tasks')).toBe(200)
  })
})
