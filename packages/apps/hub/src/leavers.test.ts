/**
 * Leavers and session lifetimes (T-12), end to end over a REAL hub-auth, the real
 * migrated app DB, the real REST gate on a real listener, real WebSockets tracked the
 * way server.ts tracks `/trpc`, and — for the Entra re-check — a FAKE Entra behind the
 * injected fetch, driven by fake timers. Nothing here talks to Microsoft.
 *
 *   disable  → bearer 401, `szw_` cookie 401, the account's open sockets closed, its
 *              computers revoked and dropped, every data row kept, audit lines written;
 *              its computer keys and join tokens refused; enable resurrects nothing;
 *   re-check → `invalid_grant` ends sessions, web sessions and sockets within one tick;
 *              the account stays enabled and its computers stay enrolled (O-24); an
 *              outage (503) keeps every session and is retried next hour, audited once;
 *              a changed app role updates `role` and closes the sockets; never two
 *              passes at once; a hub without Entra sign-in creates no timer at all.
 *
 * Native ABI: the app DB is better-sqlite3 built for Electron, so this runs under
 * vitest on Electron's node, like hub-users.test.ts.
 *
 * Run with: vitest (packages/shared/test-utils/vitest.harness.config.ts)
 */
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { generateKeyPairSync } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  mintJoinToken,
  registerComputer,
  setComputerOwner,
  unrevokeComputer
} from '@slayzone/computers/server'
import {
  createHubAuth,
  ENTRA_ADMIN_ROLE,
  ENTRA_PROVIDER_ID,
  ENTRA_USER_ROLE,
  entraAccountId,
  type EntraSsoConfig,
  type HubAuth,
  mintComputerApiKey
} from '@slayzone/hub-auth/server'
import type { SlayzoneDb } from '@slayzone/platform'
import { setSecurityLogSink } from '@slayzone/platform/security-log'
import type { AuthContext } from 'better-auth'
import { setTokenUtil } from 'better-auth/oauth2'
import { exportJWK, SignJWT } from 'jose'
import { WebSocket, WebSocketServer } from 'ws'
import { createTestHarness } from '../../../shared/test-utils/ipc-harness.js'
import { createComputerAuthAdapters } from './computer-auth.js'
import { resolveConnectionPrincipal } from './hub-trpc-context.js'
import { createHubUsersCapability } from './hub-users.js'
import { withRestAuth } from './rest-auth.js'
import {
  BOOT_RECHECK_DELAY_MS,
  RECHECK_INTERVAL_MS,
  type RecheckTimers,
  startSsoRecheck
} from './sso-recheck.js'
import { createTrpcConnectionRegistry, SESSION_ENDED_CLOSE_CODE } from './trpc-connections.js'
import { createUserAccessRevoker } from './user-access.js'
import {
  mintWebSession,
  SSO_WEB_SESSION_LIFETIME,
  WEB_SESSION_COOKIE_NAME,
  webLogin
} from './web-sessions.js'

/** Poll until `cond` holds (the tick runs its pass without being awaited). A wall-clock
 *  deadline, not an iteration count: 400 × 5ms (~2s) timed out under full-suite load.
 *  Every caller waits for something that SHOULD happen, so a long cap costs a passing
 *  test nothing. */
async function waitFor(cond: () => boolean | Promise<boolean>, what: string): Promise<void> {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    if (await cond()) return
    await new Promise((r) => setTimeout(r, 5))
  }
  throw new Error(`timed out waiting for: ${what}`)
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Fake timers: record what was scheduled; fire a callback by hand. */
function fakeTimers(): RecheckTimers & {
  scheduled: Array<{ kind: 'timeout' | 'interval'; ms: number; fn: () => void }>
  fire(kind: 'timeout' | 'interval'): void
} {
  const scheduled: Array<{ kind: 'timeout' | 'interval'; ms: number; fn: () => void }> = []
  return {
    scheduled,
    setTimeout: (fn, ms) => scheduled.push({ kind: 'timeout', ms, fn }),
    setInterval: (fn, ms) => scheduled.push({ kind: 'interval', ms, fn }),
    clearTimeout: () => undefined,
    clearInterval: () => undefined,
    fire(kind) {
      const t = scheduled.find((s) => s.kind === kind)
      if (!t) throw new Error(`no ${kind} scheduled`)
      t.fn()
    }
  }
}

/** A gateway stand-in: which computers were dropped. */
function fakeGateway() {
  const dropped: string[] = []
  return {
    dropped,
    disconnect: (computerId: string) => {
      dropped.push(computerId)
      return true
    }
  }
}

/** A `/trpc`-like listener: each socket resolves its principal from `?token=` exactly
 *  as server.ts's createContext does, and is tracked the same way. */
async function socketListener(
  auth: HubAuth,
  db: SlayzoneDb,
  registry: ReturnType<typeof createTrpcConnectionRegistry>
): Promise<{ url: string; close: () => Promise<void> }> {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await new Promise<void>((r) => wss.once('listening', () => r()))
  wss.on('connection', (ws, req) => {
    const token = new URL(req.url ?? '/', 'http://x').searchParams.get('token')
    const resolve = () =>
      resolveConnectionPrincipal({ hubAuthRequired: true, hubAuth: auth, db, token })
    void resolve().then((principal) => {
      if (principal) {
        registry.track(ws, principal.userId, async () => (await resolve())?.userId ?? null)
      }
      ws.send('ready')
    })
  })
  return {
    url: `ws://127.0.0.1:${(wss.address() as AddressInfo).port}`,
    close: () => {
      for (const c of wss.clients) c.terminate()
      return new Promise((r) => wss.close(() => r()))
    }
  }
}

/** A client socket, resolved once the server tracked (or declined to track) it. */
async function openSocket(
  url: string,
  token: string
): Promise<{ ws: WebSocket; closed: Promise<number> }> {
  const ws = new WebSocket(`${url}/?token=${encodeURIComponent(token)}`)
  const closed = new Promise<number>((r) => ws.once('close', (code) => r(code)))
  await new Promise<void>((r) => ws.once('message', () => r()))
  return { ws, closed }
}

/** The REST gate on a real listener; every admitted request answers 200. */
async function gate(auth: HubAuth, db: SlayzoneDb): Promise<{ base: string; server: Server }> {
  const server = createServer(
    withRestAuth({
      getHubAuthRequired: () => true,
      getHubAuth: () => auth,
      getDb: () => db,
      next: (_req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end('{}')
      }
    })
  )
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, server }
}

const tmpDir = mkdtempSync(join(tmpdir(), 'hub-leavers-'))
const harness = await createTestHarness()
const db: SlayzoneDb = harness.slayDb
const audit: Array<Record<string, unknown>> = []
setSecurityLogSink((line) => audit.push(JSON.parse(line) as Record<string, unknown>))
const cleanups: Array<() => Promise<void> | void> = []
const log: string[] = []

afterAll(async () => {
  setSecurityLogSink()
  for (const c of cleanups.reverse()) await c()
  await harness.cleanup()
  rmSync(tmpDir, { recursive: true, force: true })
})

// -----------------------------------------------------------------------
// Disable
// -----------------------------------------------------------------------
const authDbPath = join(tmpDir, 'hub-auth.sqlite')
const auth = await createHubAuth({
  dbPath: authDbPath,
  baseURL: 'http://127.0.0.1:9999',
  secret: 'hub-leavers-test-secret-at-least-32-chars-long'
})
const registry = createTrpcConnectionRegistry()
cleanups.push(() => registry.stop())
const gateway = fakeGateway()
const userAccess = createUserAccessRevoker({
  db,
  getGateway: () => gateway,
  connections: registry,
  log: (m) => log.push(m)
})
const users = createHubUsersCapability(() => auth, userAccess)
const { base, server } = await gate(auth, db)
cleanups.push(() => new Promise<void>((r) => server.close(() => r())))
const sockets = await socketListener(auth, db, registry)
cleanups.push(() => sockets.close())

const owner = await users.create({ email: 'owner@example.com' })
const leaver = await users.create({ email: 'leaver@example.com', name: 'Leaver' })
if (!owner.ok || !leaver.ok) throw new Error('created both accounts')
const leaverId = leaver.user.id

const full = await auth.api.signInEmail({
  body: { email: 'leaver@example.com', password: leaver.user.password }
})
const web = await webLogin(auth, db, 'leaver@example.com', leaver.user.password)
if (!web.ok) throw new Error('web login')
const ownerFull = await auth.api.signInEmail({
  body: { email: 'owner@example.com', password: owner.user.password }
})

const viaBearer = (token: string) =>
  fetch(`${base}/api/projects`, { headers: { authorization: `Bearer ${token}` } })
const viaCookie = (token: string) =>
  fetch(`${base}/api/projects`, { headers: { cookie: `${WEB_SESSION_COOKIE_NAME}=${token}` } })

// Computers: two of the leaver's, one of the owner's; a project the leaver owns.
for (const [id, who] of [
  ['c-leaver-1', leaverId],
  ['c-leaver-2', leaverId],
  ['c-owner', owner.user.id]
] as const) {
  await registerComputer(db, { id, name: id, platform: 'darwin-arm64', version: '0' })
  await setComputerOwner(db, id, who)
}
await db.run('INSERT INTO projects (id, name, color, owner_user_id) VALUES (?, ?, ?, ?)', [
  'p-leaver',
  'Leaver project',
  '#000',
  leaverId
])

test('before: the gate knows both credentials', async () => {
  expect((await viaBearer(full.token)).status, 'bearer').toEqual(200)
  // A live web session is a real credential of the wrong class for /api: 403, not 401.
  expect((await viaCookie(web.token)).status, 'szw_ cookie recognised').toEqual(403)
})

type OpenSocket = Awaited<ReturnType<typeof openSocket>>
let leaverFullSocket: OpenSocket
let leaverWebSocket: OpenSocket
let ownerSocket: OpenSocket

describe('with the leaver and owner sockets open', () => {
  beforeAll(async () => {
    leaverFullSocket = await openSocket(sockets.url, full.token)
    leaverWebSocket = await openSocket(sockets.url, web.token)
    ownerSocket = await openSocket(sockets.url, ownerFull.token)
    cleanups.push(() => ownerSocket.ws.terminate())
    expect(registry.count(leaverId), 'leaver sockets tracked').toEqual(2)
    expect(registry.count(owner.user.id), 'owner socket tracked').toEqual(1)

    audit.length = 0
  })

  test('disable: 401 on both credential classes, sockets closed, computers revoked', async () => {
    expect(await users.disable('leaver@example.com'), 'disabled').toEqual('ok')

    expect((await viaBearer(full.token)).status, 'bearer 401').toEqual(401)
    expect((await viaCookie(web.token)).status, 'szw_ cookie 401').toEqual(401)
    expect(await leaverFullSocket.closed, 'full-session socket closed').toEqual(
      SESSION_ENDED_CLOSE_CODE
    )
    expect(await leaverWebSocket.closed, 'web-session socket closed').toEqual(
      SESSION_ENDED_CLOSE_CODE
    )
    expect(ownerSocket.ws.readyState, "the owner's socket stays open").toEqual(WebSocket.OPEN)
    expect((await viaBearer(ownerFull.token)).status, "the owner's bearer still works").toEqual(200)

    const computers = await db.all<{ id: string; revoked_at: number | null }>(
      'SELECT id, revoked_at FROM computers ORDER BY id'
    )
    expect(
      computers.map((c) => `${c.id}:${c.revoked_at === null ? 'live' : 'revoked'}`),
      "the leaver's computers revoked, the owner's not"
    ).toEqual(['c-leaver-1:revoked', 'c-leaver-2:revoked', 'c-owner:live'])
    expect([...gateway.dropped].sort(), 'and dropped').toEqual(['c-leaver-1', 'c-leaver-2'])
  })

  test('disable keeps every data row', async () => {
    const authDb = new DatabaseSync(authDbPath)
    try {
      const count = (sql: string) => (authDb.prepare(sql).get(leaverId) as { n: number }).n
      expect(count('SELECT count(*) AS n FROM user WHERE id = ?'), 'user row').toEqual(1)
      expect(count('SELECT count(*) AS n FROM account WHERE userId = ?'), 'account row').toEqual(1)
    } finally {
      authDb.close()
    }
    const one = async (sql: string) =>
      ((await db.get<{ n: number }>(sql, [leaverId])) ?? { n: -1 }).n
    expect(
      await one('SELECT count(*) AS n FROM projects WHERE owner_user_id = ?'),
      'project'
    ).toEqual(1)
    expect(
      await one('SELECT count(*) AS n FROM web_sessions WHERE user_id = ?'),
      'web session row'
    ).toEqual(1)
    expect(
      await one('SELECT count(*) AS n FROM computers WHERE owner_user_id = ?'),
      'computer rows'
    ).toEqual(2)
  })

  test('disable writes the audit lines', async () => {
    const lines = audit.map((l) => `${l.event}:${l.outcome}`)
    for (const expected of [
      'auth.session.revoke:success',
      'auth.web_session.revoke:success',
      'computer.revoke:success',
      'user.disable:success'
    ]) {
      expect(lines, `${expected} in ${lines.join(', ')}`).toContain(expected)
    }
    const revokes = audit.filter((l) => l.event === 'computer.revoke')
    expect(
      revokes.map((l) => [l.targetId, (l.detail as { reason?: string }).reason]).sort(),
      'one computer.revoke per computer'
    ).toEqual([
      ['c-leaver-1', 'user_disabled'],
      ['c-leaver-2', 'user_disabled']
    ])
    expect(JSON.stringify(audit), 'no token in a line').not.toContain(full.token)
  })

  test("a disabled owner's computer key and join token are refused", async () => {
    const adapters = createComputerAuthAdapters({ db, auth })
    const minted = await mintComputerApiKey(auth, { computerId: 'c-leaver-1', name: 'c' })
    await db.run('UPDATE computers SET auth_key_id = ? WHERE id = ?', [minted.keyId, 'c-leaver-1'])
    // Even un-revoked (by hand), the computer of a disabled owner does not authenticate.
    await unrevokeComputer(db, 'c-leaver-1')
    expect(await adapters.verifyApiKey(minted.key), 'hello refused').toEqual(null)
    const ownersKey = await mintComputerApiKey(auth, { computerId: 'c-owner', name: 'c' })
    await db.run('UPDATE computers SET auth_key_id = ? WHERE id = ?', [ownersKey.keyId, 'c-owner'])
    expect(await adapters.verifyApiKey(ownersKey.key), "the owner's computer works").not.toBeNull()

    const joinToken = await mintJoinToken(db, {
      hubUrl: 'ws://127.0.0.1:1/computers',
      ttlMs: 60_000,
      label: 'leaver laptop',
      ownerUserId: leaverId
    })
    let refused: unknown = null
    try {
      await adapters.verifyEnrollment({
        joinToken: joinToken.token,
        name: 'leaver-laptop',
        platform: 'darwin-arm64',
        version: '0',
        capabilities: [],
        protocolVersion: 1
      } as Parameters<typeof adapters.verifyEnrollment>[0])
    } catch (err) {
      refused = err
    }
    expect(refused, 'enrollment refused').toBeInstanceOf(Error)
    expect((refused as Error).message, 'enrollment refused').toMatch(/disabled/)
    await db.run('UPDATE computers SET revoked_at = ? WHERE id = ?', [Date.now(), 'c-leaver-1'])
  })

  test('enable resurrects nothing: old credentials stay dead, computers stay revoked', async () => {
    expect(await users.enable('leaver@example.com'), 'enabled').toEqual('ok')
    expect((await viaBearer(full.token)).status, 'old bearer').toEqual(401)
    expect((await viaCookie(web.token)).status, 'old szw_').toEqual(401)
    const live = await db.get<{ n: number }>(
      'SELECT count(*) AS n FROM computers WHERE owner_user_id = ? AND revoked_at IS NULL',
      [leaverId]
    )
    expect(live?.n, 'computers still revoked').toEqual(0)
    const fresh = await auth.api.signInEmail({
      body: { email: 'leaver@example.com', password: leaver.user.password }
    })
    expect((await viaBearer(fresh.token)).status, 'a new sign-in works').toEqual(200)
  })

  test('a socket whose session ended any other way closes at the next revalidation', async () => {
    expect(ownerSocket.ws.readyState, 'open').toEqual(WebSocket.OPEN)
    await auth.api.signOut({
      headers: new Headers({ authorization: `Bearer ${ownerFull.token}` })
    })
    expect(await registry.revalidateAll(), 'one closed').toEqual(1)
    expect(await ownerSocket.closed, 'with the session-ended code').toEqual(
      SESSION_ENDED_CLOSE_CODE
    )
    expect(registry.count(), 'nothing tracked').toEqual(0)

    // The schedule: one interval while anything is tracked, none after; closed
    // sockets are never tracked.
    const intervals: unknown[] = []
    const reg = createTrpcConnectionRegistry({
      timers: {
        setInterval: (fn) => {
          intervals.push(fn)
          return intervals.length
        },
        clearInterval: () => intervals.pop()
      }
    })
    const closes: number[] = []
    const sock = (readyState: number) => ({
      readyState,
      close: (code?: number) => {
        closes.push(code ?? 0)
      },
      once: () => undefined
    })
    reg.track(sock(3), 'gone', async () => 'gone')
    expect([reg.count(), intervals.length], 'a closed socket is not tracked').toEqual([0, 0])
    reg.track(sock(1), 'u1', async () => null)
    reg.track(sock(1), 'u2', async () => {
      throw new Error('db down')
    })
    expect(intervals.length, 'one timer').toEqual(1)
    expect(await reg.revalidateAll(), 'both closed: ended, and a check that threw').toEqual(2)
    expect([closes, reg.count(), intervals.length], 'timer stopped').toEqual([[4401, 4401], 0, 0])
  })
})

// -----------------------------------------------------------------------
// Entra re-check, through the tick
// -----------------------------------------------------------------------
const TENANT = '11111111-2222-3333-4444-555555555555'
const CLIENT_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
const AUTHORITY = 'https://login.fake-entra.test'
const hubKeys = generateKeyPairSync('rsa', { modulusLength: 2048 })
const entraKeys = generateKeyPairSync('rsa', { modulusLength: 2048 })
const sso: EntraSsoConfig = {
  tenantId: TENANT,
  clientId: CLIENT_ID,
  credential: { privateKey: hubKeys.privateKey, thumbprintS256: 'test' },
  requireMfa: true,
  authority: AUTHORITY
}
/** Per refresh token: how the fake Entra answers it. */
const behaviour = new Map<
  string,
  | { kind: 'tokens'; oid: string; roles: string[] }
  | { kind: 'error'; status: number; error: string }
>()
const refreshes: string[] = []
let slow: Promise<void> | null = null
const entraFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input)
  if (url.endsWith('/discovery/v2.0/keys')) {
    return Response.json({ keys: [{ ...(await exportJWK(entraKeys.publicKey)), kid: 'k1' }] })
  }
  const form = new URLSearchParams(String(init?.body))
  const rt = form.get('refresh_token') ?? ''
  refreshes.push(rt)
  if (slow) await slow
  const b = behaviour.get(rt)
  if (!b) return Response.json({ error: 'invalid_request' }, { status: 400 })
  if (b.kind === 'error') return Response.json({ error: b.error }, { status: b.status })
  const now = Math.floor(Date.now() / 1000)
  const idToken = await new SignJWT({ tid: TENANT, oid: b.oid, roles: b.roles })
    .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
    .setIssuer(`${AUTHORITY}/${TENANT}/v2.0`)
    .setAudience(CLIENT_ID)
    .setIssuedAt(now)
    .setExpirationTime(now + 3600)
    .sign(entraKeys.privateKey)
  // Entra rotates: the new token answers like the old one.
  const rotated = `${rt}+`
  behaviour.set(rotated, b)
  return Response.json({
    token_type: 'Bearer',
    access_token: 'at',
    id_token: idToken,
    refresh_token: rotated
  })
}) as typeof fetch

let ssoAuth: HubAuth
let ssoSockets: Awaited<ReturnType<typeof socketListener>>
type EntraPerson = Awaited<ReturnType<typeof entraPerson>>
let alice: EntraPerson
let bob: EntraPerson
let carol: EntraPerson
let aliceWeb: Awaited<ReturnType<typeof mintWebSession>>
let aliceSocket: OpenSocket
let bobSocket: OpenSocket
let carolSocket: OpenSocket
let recheck: ReturnType<typeof startSsoRecheck>
const ssoRegistry = createTrpcConnectionRegistry()
const ssoGateway = fakeGateway()
const ssoAccess = createUserAccessRevoker({
  db,
  getGateway: () => ssoGateway,
  connections: ssoRegistry,
  log: (m) => log.push(m)
})
cleanups.push(() => ssoSockets.close())

/** An account as an Entra sign-in leaves it, with a session and its bearer token. */
async function entraPerson(oid: string, role: 'admin' | 'user') {
  const ctx = await ssoAuth.$context
  const user = await ctx.internalAdapter.createUser(
    {
      email: `${oid}@normain.test`,
      name: oid,
      emailVerified: true,
      role
    },
    { method: 'oauth', oauth: { providerId: ENTRA_PROVIDER_ID } }
  )
  await ctx.internalAdapter.linkAccount({
    userId: user.id,
    providerId: ENTRA_PROVIDER_ID,
    accountId: entraAccountId(oid, TENANT),
    refreshToken: (await setTokenUtil(`rt-${oid}`, ctx as unknown as AuthContext)) as string
  })
  const session = await ctx.internalAdapter.createSession(user.id)
  return { userId: user.id, token: session.token }
}
const sessionsOf = async (userId: string) =>
  (await (await ssoAuth.$context).internalAdapter.listSessions(userId)).length
const roleOf = async (userId: string) =>
  ((await (await ssoAuth.$context).internalAdapter.findUserById(userId)) as { role?: string })?.role

const timers = fakeTimers()

describe('Entra re-check, through the tick', () => {
  beforeAll(async () => {
    ssoAuth = await createHubAuth({
      dbPath: join(tmpDir, 'hub-auth-sso.sqlite'),
      baseURL: 'http://127.0.0.1:9999',
      secret: 'hub-leavers-sso-test-secret-at-least-32-chars',
      sso
    })
    cleanups.push(() => ssoRegistry.stop())
    ssoSockets = await socketListener(ssoAuth, db, ssoRegistry)
    alice = await entraPerson('alice', 'admin') // Entra will refuse her
    bob = await entraPerson('bob', 'user') // Entra will be down for him
    carol = await entraPerson('carol', 'user') // promoted in Entra
    behaviour.set('rt-alice', { kind: 'error', status: 400, error: 'invalid_grant' })
    behaviour.set('rt-bob', { kind: 'error', status: 503, error: 'temporarily_unavailable' })
    behaviour.set('rt-carol', { kind: 'tokens', oid: 'carol', roles: [ENTRA_ADMIN_ROLE] })

    aliceWeb = await mintWebSession(db, {
      userId: alice.userId,
      scopes: ['read'],
      lifetime: SSO_WEB_SESSION_LIFETIME
    })
    await registerComputer(db, { id: 'c-alice', name: 'a', platform: 'p', version: '0' })
    await setComputerOwner(db, 'c-alice', alice.userId)
    aliceSocket = await openSocket(ssoSockets.url, alice.token)
    bobSocket = await openSocket(ssoSockets.url, bob.token)
    cleanups.push(() => bobSocket.ws.terminate())
    carolSocket = await openSocket(ssoSockets.url, carol.token)
    expect(ssoRegistry.count(), 'three sso sockets tracked').toEqual(3)

    recheck = startSsoRecheck({
      auth: ssoAuth,
      sso,
      db,
      revoker: ssoAccess,
      timers,
      fetch: entraFetch,
      log: (m) => log.push(m)
    })
    cleanups.push(() => recheck.stop())
  })

  test('scheduled: first pass after boot, then hourly', () => {
    expect(recheck.active, 'active').toEqual(true)
    expect(
      timers.scheduled.map((t) => `${t.kind}:${t.ms}`),
      'timers'
    ).toEqual([`timeout:${BOOT_RECHECK_DELAY_MS}`, `interval:${RECHECK_INTERVAL_MS}`])
    expect(RECHECK_INTERVAL_MS, 'hourly').toEqual(60 * 60 * 1000)
  })

  describe('after the first tick', () => {
    beforeAll(() => {
      audit.length = 0
    })
    test('one tick: invalid_grant ends her sessions; account enabled, computer kept (O-24)', async () => {
      timers.fire('timeout')
      await waitFor(async () => (await sessionsOf(alice.userId)) === 0, 'alice revoked')
      await waitFor(
        () => audit.some((l) => l.event === 'auth.sso.recheck' && l.outcome === 'failure'),
        'pass finished'
      )
      expect(await aliceSocket.closed, 'her socket closed').toEqual(SESSION_ENDED_CLOSE_CODE)
      const webRow = await db.get<{ revoked_at: number | null }>(
        'SELECT revoked_at FROM web_sessions WHERE id = ?',
        [aliceWeb.id]
      )
      expect(webRow?.revoked_at, 'her web session revoked').not.toBeNull()
      const computer = await db.get<{ revoked_at: number | null }>(
        'SELECT revoked_at FROM computers WHERE id = ?',
        ['c-alice']
      )
      expect(computer?.revoked_at, 'her computer stays enrolled').toEqual(null)
      expect(ssoGateway.dropped, 'and connected').toEqual([])
      expect(
        audit.some((l) => l.event === 'computer.revoke'),
        'no computer.revoke line'
      ).toBeFalsy()
      // Its key still authenticates: her account is not disabled.
      const minted = await mintComputerApiKey(ssoAuth, { computerId: 'c-alice', name: 'a' })
      await db.run('UPDATE computers SET auth_key_id = ? WHERE id = ?', [minted.keyId, 'c-alice'])
      const adapters = createComputerAuthAdapters({ db, auth: ssoAuth })
      expect(await adapters.verifyApiKey(minted.key), 'her computer still connects').not.toBeNull()
      const disabled = (
        (await (await ssoAuth.$context).internalAdapter.findUserById(alice.userId)) as {
          disabledAt?: unknown
        }
      )?.disabledAt
      expect(disabled === null || disabled === undefined, 'not disabled').toBe(true)
      const denied = audit.filter((l) => l.event === 'auth.sso.recheck' && l.outcome === 'denied')
      expect(denied.length, 'one denied line').toEqual(1)
      expect(denied[0]?.targetId, 'for alice').toEqual(alice.userId)
      expect((denied[0]?.detail as { reason?: string } | undefined)?.reason, 'reason').toEqual(
        'invalid_grant'
      )
    })

    test('same tick: the outage keeps his sessions; audited once, at level info', async () => {
      expect(await sessionsOf(bob.userId), 'session kept').toEqual(1)
      expect(bobSocket.ws.readyState, 'socket open').toEqual(WebSocket.OPEN)
      const failures = audit.filter(
        (l) => l.event === 'auth.sso.recheck' && l.outcome === 'failure'
      )
      expect(failures.length, 'one line').toEqual(1)
      expect(failures[0]?.level, 'level info').toEqual('info')
      expect(
        (failures[0]?.detail as { reason?: string; cause?: string } | undefined)?.cause,
        'cause'
      ).toEqual('http_503')
    })

    test('same tick: a changed app role updates role and closes the sockets', async () => {
      expect(await roleOf(carol.userId), 'promoted').toEqual('admin')
      expect(await carolSocket.closed, 'socket closed to reconnect').toEqual(
        SESSION_ENDED_CLOSE_CODE
      )
      expect(await sessionsOf(carol.userId), 'session kept').toEqual(1)
      const change = audit.find((l) => l.event === 'user.role_change')
      expect(change?.targetId, 'audited').toEqual(carol.userId)
      expect((change?.detail as { reason?: string } | undefined)?.reason, 'reason').toEqual(
        'sso_recheck'
      )
    })

    test('next hour: the outage is retried, no second line; then recovery', async () => {
      const before = refreshes.filter((r) => r.startsWith('rt-bob')).length
      audit.length = 0
      timers.fire('interval')
      await waitFor(
        () => refreshes.filter((r) => r.startsWith('rt-bob')).length === before + 1,
        'bob retried'
      )
      await waitFor(() => refreshes.some((r) => r.startsWith('rt-carol+')), 'carol asked again')
      await new Promise((r) => setTimeout(r, 50))
      expect(
        audit.filter((l) => l.event === 'auth.sso.recheck').length,
        'no new auth.sso.recheck line while still down'
      ).toEqual(0)
      expect(refreshes.slice(-3), 'alice (no session) not asked again').not.toContain('rt-alice')
      expect(await sessionsOf(bob.userId), 'still kept').toEqual(1)

      behaviour.set('rt-bob', { kind: 'tokens', oid: 'bob', roles: [ENTRA_USER_ROLE] })
      timers.fire('interval')
      await waitFor(
        () => audit.some((l) => l.event === 'auth.sso.recheck' && l.outcome === 'success'),
        'recovery line'
      )
      expect(await sessionsOf(bob.userId), 'kept through it all').toEqual(1)
    })

    test('never two passes at once', async () => {
      let release!: () => void
      slow = new Promise<void>((r) => {
        release = r
      })
      const first = recheck.runNow()
      await waitFor(() => refreshes.length > 0, 'first pass in flight')
      expect(await recheck.runNow(), 'second refused while the first runs').toEqual(null)
      release()
      slow = null
      expect(await first, 'first finished').not.toBeNull()
    })

    test('a hub without Entra sign-in (the desktop app’s): no timer, nothing asked', async () => {
      const off = fakeTimers()
      const before = refreshes.length
      const handle = startSsoRecheck({
        auth,
        sso: null,
        db,
        revoker: userAccess,
        timers: off,
        fetch: entraFetch
      })
      expect(handle.active, 'inactive').toEqual(false)
      expect(off.scheduled.length, 'no timer').toEqual(0)
      expect(await handle.runNow(), 'runNow is inert').toEqual(null)
      expect(refreshes.length, 'Entra not contacted').toEqual(before)
    })
  })
})
