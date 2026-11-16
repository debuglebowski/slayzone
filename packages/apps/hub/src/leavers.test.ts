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
 * Every test builds its OWN scenario (accounts, sessions, computers, sockets, socket
 * registry, gateway, audit sink; for the re-check also its own hub-auth DB, fake Entra
 * and schedule) and awaits everything it starts: a scheduled tick returns its pass and
 * the test awaits it, a closed socket is its real `close` event. No test reads state a
 * previous test left running.
 *
 * Native ABI: the app DB is better-sqlite3 built for Electron, so this runs under
 * vitest on Electron's node, like hub-users.test.ts.
 *
 * Run with: vitest (packages/shared/test-utils/vitest.harness.config.ts)
 */
import { afterAll, describe, expect, test } from 'vitest'
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
  type RecheckTick,
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

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Fake timers: record what was scheduled; fire a callback by hand and get its pass. */
function fakeTimers(): RecheckTimers & {
  scheduled: Array<{ kind: 'timeout' | 'interval'; ms: number; fn: RecheckTick }>
  fire(kind: 'timeout' | 'interval'): ReturnType<RecheckTick>
} {
  const scheduled: Array<{ kind: 'timeout' | 'interval'; ms: number; fn: RecheckTick }> = []
  return {
    scheduled,
    setTimeout: (fn, ms) => scheduled.push({ kind: 'timeout', ms, fn }),
    setInterval: (fn, ms) => scheduled.push({ kind: 'interval', ms, fn }),
    clearTimeout: () => undefined,
    clearInterval: () => undefined,
    fire(kind) {
      const t = scheduled.find((s) => s.kind === kind)
      if (!t) throw new Error(`no ${kind} scheduled`)
      return t.fn()
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

/** This test's audit sink: every security-log line from here on, until the next one. */
function captureAudit(): Array<Record<string, unknown>> {
  const lines: Array<Record<string, unknown>> = []
  setSecurityLogSink((line) => lines.push(JSON.parse(line) as Record<string, unknown>))
  return lines
}

/** A `/trpc`-like listener: each socket resolves its principal from `?token=` exactly
 *  as server.ts's createContext does, and is tracked the same way. */
async function socketListener(
  auth: HubAuth,
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
  cleanups.push(() => ws.terminate())
  return { ws, closed }
}
type OpenSocket = Awaited<ReturnType<typeof openSocket>>

/** The REST gate on a real listener; every admitted request answers 200. */
async function gate(auth: HubAuth): Promise<{ base: string; server: Server }> {
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

// Shared infrastructure only (no scenario state): the app DB, one password hub-auth and
// its REST gate. Accounts, computers and sockets are made per test, uniquely named.
const tmpDir = mkdtempSync(join(tmpdir(), 'hub-leavers-'))
const harness = await createTestHarness()
const db: SlayzoneDb = harness.slayDb
const cleanups: Array<() => Promise<void> | void> = []
const log: string[] = []
let scenarioSeq = 0

afterAll(async () => {
  setSecurityLogSink()
  for (const c of cleanups.reverse()) await c()
  await harness.cleanup()
  rmSync(tmpDir, { recursive: true, force: true })
})

const authDbPath = join(tmpDir, 'hub-auth.sqlite')
const auth = await createHubAuth({
  dbPath: authDbPath,
  baseURL: 'http://127.0.0.1:9999',
  secret: 'hub-leavers-test-secret-at-least-32-chars-long'
})
const { base, server } = await gate(auth)
cleanups.push(() => new Promise<void>((r) => server.close(() => r())))

const viaBearer = (token: string) =>
  fetch(`${base}/api/projects`, { headers: { authorization: `Bearer ${token}` } })
const viaCookie = (token: string) =>
  fetch(`${base}/api/projects`, { headers: { cookie: `${WEB_SESSION_COOKIE_NAME}=${token}` } })

// -----------------------------------------------------------------------
// Disable
// -----------------------------------------------------------------------

/**
 * A leaver and an owner on the password hub, each signed in (the leaver also on the
 * web), two computers of the leaver's and one of the owner's, a project the leaver
 * owns; sockets opened as asked, tracked by this scenario's own registry.
 */
async function leaverScenario(opts: { leaverSockets: boolean }) {
  const n = ++scenarioSeq
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
  const sockets = await socketListener(auth, registry)
  cleanups.push(() => sockets.close())

  const ownerEmail = `owner-${n}@example.com`
  const leaverEmail = `leaver-${n}@example.com`
  const owner = await users.create({ email: ownerEmail })
  const leaver = await users.create({ email: leaverEmail, name: 'Leaver' })
  if (!owner.ok || !leaver.ok) throw new Error('created both accounts')
  const leaverId = leaver.user.id
  const ownerId = owner.user.id

  const full = await auth.api.signInEmail({
    body: { email: leaverEmail, password: leaver.user.password }
  })
  const web = await webLogin(auth, db, leaverEmail, leaver.user.password)
  if (!web.ok) throw new Error('web login')
  const ownerFull = await auth.api.signInEmail({
    body: { email: ownerEmail, password: owner.user.password }
  })

  const computers = {
    leaver1: `c-leaver-1-${n}`,
    leaver2: `c-leaver-2-${n}`,
    owner: `c-owner-${n}`
  }
  for (const [id, who] of [
    [computers.leaver1, leaverId],
    [computers.leaver2, leaverId],
    [computers.owner, ownerId]
  ] as const) {
    await registerComputer(db, { id, name: id, platform: 'darwin-arm64', version: '0' })
    await setComputerOwner(db, id, who)
  }
  await db.run('INSERT INTO projects (id, name, color, owner_user_id) VALUES (?, ?, ?, ?)', [
    `p-leaver-${n}`,
    'Leaver project',
    '#000',
    leaverId
  ])

  let leaverFullSocket: OpenSocket | null = null
  let leaverWebSocket: OpenSocket | null = null
  if (opts.leaverSockets) {
    leaverFullSocket = await openSocket(sockets.url, full.token)
    leaverWebSocket = await openSocket(sockets.url, web.token)
    expect(registry.count(leaverId), 'leaver sockets tracked').toEqual(2)
  }
  const ownerSocket = await openSocket(sockets.url, ownerFull.token)
  expect(registry.count(ownerId), 'owner socket tracked').toEqual(1)

  return {
    registry,
    gateway,
    users,
    owner: { id: ownerId, email: ownerEmail, token: ownerFull.token, socket: ownerSocket },
    leaver: {
      id: leaverId,
      email: leaverEmail,
      password: leaver.user.password,
      token: full.token,
      webToken: web.token,
      fullSocket: leaverFullSocket,
      webSocket: leaverWebSocket
    },
    computers,
    /** This scenario's computers, `id:live|revoked`, by id. */
    computerStates: async () =>
      (
        await db.all<{ id: string; revoked_at: number | null }>(
          'SELECT id, revoked_at FROM computers WHERE id IN (?, ?, ?) ORDER BY id',
          [computers.leaver1, computers.leaver2, computers.owner]
        )
      ).map((c) => `${c.id}:${c.revoked_at === null ? 'live' : 'revoked'}`)
  }
}

test('before: the gate knows both credentials', async () => {
  const s = await leaverScenario({ leaverSockets: false })
  expect((await viaBearer(s.leaver.token)).status, 'bearer').toEqual(200)
  // A live web session is a real credential of the wrong class for /api: 403, not 401.
  expect((await viaCookie(s.leaver.webToken)).status, 'szw_ cookie recognised').toEqual(403)
})

describe('with the leaver and owner sockets open', () => {
  test('disable: 401 on both credential classes, sockets closed, computers revoked', async () => {
    const s = await leaverScenario({ leaverSockets: true })
    expect(await s.users.disable(s.leaver.email), 'disabled').toEqual('ok')

    expect((await viaBearer(s.leaver.token)).status, 'bearer 401').toEqual(401)
    expect((await viaCookie(s.leaver.webToken)).status, 'szw_ cookie 401').toEqual(401)
    expect(await s.leaver.fullSocket?.closed, 'full-session socket closed').toEqual(
      SESSION_ENDED_CLOSE_CODE
    )
    expect(await s.leaver.webSocket?.closed, 'web-session socket closed').toEqual(
      SESSION_ENDED_CLOSE_CODE
    )
    expect(s.owner.socket.ws.readyState, "the owner's socket stays open").toEqual(WebSocket.OPEN)
    expect((await viaBearer(s.owner.token)).status, "the owner's bearer still works").toEqual(200)

    expect(await s.computerStates(), "the leaver's computers revoked, the owner's not").toEqual([
      `${s.computers.leaver1}:revoked`,
      `${s.computers.leaver2}:revoked`,
      `${s.computers.owner}:live`
    ])
    expect([...s.gateway.dropped].sort(), 'and dropped').toEqual([
      s.computers.leaver1,
      s.computers.leaver2
    ])
  })

  test('disable keeps every data row', async () => {
    const s = await leaverScenario({ leaverSockets: true })
    expect(await s.users.disable(s.leaver.email), 'disabled').toEqual('ok')
    const leaverId = s.leaver.id
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
    const s = await leaverScenario({ leaverSockets: true })
    const audit = captureAudit()
    expect(await s.users.disable(s.leaver.email), 'disabled').toEqual('ok')
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
      [s.computers.leaver1, 'user_disabled'],
      [s.computers.leaver2, 'user_disabled']
    ])
    expect(JSON.stringify(audit), 'no token in a line').not.toContain(s.leaver.token)
  })

  test("a disabled owner's computer key and join token are refused", async () => {
    const s = await leaverScenario({ leaverSockets: true })
    expect(await s.users.disable(s.leaver.email), 'disabled').toEqual('ok')
    const adapters = createComputerAuthAdapters({ db, auth })
    const minted = await mintComputerApiKey(auth, { computerId: s.computers.leaver1, name: 'c' })
    await db.run('UPDATE computers SET auth_key_id = ? WHERE id = ?', [
      minted.keyId,
      s.computers.leaver1
    ])
    // Even un-revoked (by hand), the computer of a disabled owner does not authenticate.
    await unrevokeComputer(db, s.computers.leaver1)
    expect(await adapters.verifyApiKey(minted.key), 'hello refused').toEqual(null)
    const ownersKey = await mintComputerApiKey(auth, { computerId: s.computers.owner, name: 'c' })
    await db.run('UPDATE computers SET auth_key_id = ? WHERE id = ?', [
      ownersKey.keyId,
      s.computers.owner
    ])
    expect(await adapters.verifyApiKey(ownersKey.key), "the owner's computer works").not.toBeNull()

    const joinToken = await mintJoinToken(db, {
      hubUrl: 'ws://127.0.0.1:1/computers',
      ttlMs: 60_000,
      label: 'leaver laptop',
      ownerUserId: s.leaver.id
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
  })

  test('enable resurrects nothing: old credentials stay dead, computers stay revoked', async () => {
    const s = await leaverScenario({ leaverSockets: true })
    expect(await s.users.disable(s.leaver.email), 'disabled').toEqual('ok')
    expect(await s.users.enable(s.leaver.email), 'enabled').toEqual('ok')
    expect((await viaBearer(s.leaver.token)).status, 'old bearer').toEqual(401)
    expect((await viaCookie(s.leaver.webToken)).status, 'old szw_').toEqual(401)
    const live = await db.get<{ n: number }>(
      'SELECT count(*) AS n FROM computers WHERE owner_user_id = ? AND revoked_at IS NULL',
      [s.leaver.id]
    )
    expect(live?.n, 'computers still revoked').toEqual(0)
    const fresh = await auth.api.signInEmail({
      body: { email: s.leaver.email, password: s.leaver.password }
    })
    expect((await viaBearer(fresh.token)).status, 'a new sign-in works').toEqual(200)
  })

  test('a socket whose session ended any other way closes at the next revalidation', async () => {
    const s = await leaverScenario({ leaverSockets: false })
    const { registry } = s
    expect(s.owner.socket.ws.readyState, 'open').toEqual(WebSocket.OPEN)
    await auth.api.signOut({
      headers: new Headers({ authorization: `Bearer ${s.owner.token}` })
    })
    expect(await registry.revalidateAll(), 'one closed').toEqual(1)
    expect(await s.owner.socket.closed, 'with the session-ended code').toEqual(
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

type EntraAnswer =
  | { kind: 'tokens'; oid: string; roles: string[] }
  | { kind: 'error'; status: number; error: string }

/** A fake Entra of the scenario's own: per refresh token how it answers, every refresh
 *  token asked about, and an optional gate holding token requests (with a signal that
 *  one reached it). */
function fakeEntra() {
  const behaviour = new Map<string, EntraAnswer>()
  const refreshes: string[] = []
  let gate: { entered: () => void; released: Promise<void> } | null = null
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input)
    if (url.endsWith('/discovery/v2.0/keys')) {
      return Response.json({ keys: [{ ...(await exportJWK(entraKeys.publicKey)), kid: 'k1' }] })
    }
    const form = new URLSearchParams(String(init?.body))
    const rt = form.get('refresh_token') ?? ''
    refreshes.push(rt)
    if (gate) {
      gate.entered()
      await gate.released
    }
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
  return {
    behaviour,
    refreshes,
    fetch: fetchImpl,
    /** Hold every token request from now on; `arrival(n)` resolves once n have. */
    hold() {
      let release!: () => void
      const released = new Promise<void>((r) => {
        release = r
      })
      let arrived = 0
      const waiters: Array<{ n: number; resolve: () => void }> = []
      const entered = () => {
        arrived++
        for (const w of waiters) if (arrived >= w.n) w.resolve()
      }
      /** Resolves once `n` token requests in all have reached the gate. */
      const arrival = (n: number) =>
        new Promise<void>((resolve) => {
          if (arrived >= n) resolve()
          else waiters.push({ n, resolve })
        })
      gate = { entered, released }
      return {
        arrival,
        release: () => {
          gate = null
          release()
        }
      }
    }
  }
}

/**
 * A hub with Entra sign-in of its own (own hub-auth DB, so a pass sees only these
 * accounts): alice (Entra refuses her), bob (Entra is down for him), carol (promoted in
 * Entra), each with a session and an open socket; alice also with a web session and a
 * computer. The re-check is started on this scenario's fake timers.
 */
async function entraScenario() {
  const n = ++scenarioSeq
  const ssoAuth = await createHubAuth({
    dbPath: join(tmpDir, `hub-auth-sso-${n}.sqlite`),
    baseURL: 'http://127.0.0.1:9999',
    secret: 'hub-leavers-sso-test-secret-at-least-32-chars',
    sso
  })
  const registry = createTrpcConnectionRegistry()
  cleanups.push(() => registry.stop())
  const gateway = fakeGateway()
  const access = createUserAccessRevoker({
    db,
    getGateway: () => gateway,
    connections: registry,
    log: (m) => log.push(m)
  })
  const sockets = await socketListener(ssoAuth, registry)
  cleanups.push(() => sockets.close())
  const entra = fakeEntra()

  /** An account as an Entra sign-in leaves it, with a session and its bearer token. */
  const entraPerson = async (name: string, role: 'admin' | 'user') => {
    const oid = `${name}-${n}`
    const ctx = await ssoAuth.$context
    const user = await ctx.internalAdapter.createUser(
      { email: `${oid}@normain.test`, name: oid, emailVerified: true, role },
      { method: 'oauth', oauth: { providerId: ENTRA_PROVIDER_ID } }
    )
    const refreshToken = `rt-${oid}`
    await ctx.internalAdapter.linkAccount({
      userId: user.id,
      providerId: ENTRA_PROVIDER_ID,
      accountId: entraAccountId(oid, TENANT),
      refreshToken: (await setTokenUtil(refreshToken, ctx as unknown as AuthContext)) as string
    })
    const session = await ctx.internalAdapter.createSession(user.id)
    const socket = await openSocket(sockets.url, session.token)
    return { oid, refreshToken, userId: user.id, token: session.token, socket }
  }

  const alice = await entraPerson('alice', 'admin')
  const bob = await entraPerson('bob', 'user')
  const carol = await entraPerson('carol', 'user')
  entra.behaviour.set(alice.refreshToken, { kind: 'error', status: 400, error: 'invalid_grant' })
  entra.behaviour.set(bob.refreshToken, {
    kind: 'error',
    status: 503,
    error: 'temporarily_unavailable'
  })
  entra.behaviour.set(carol.refreshToken, {
    kind: 'tokens',
    oid: carol.oid,
    roles: [ENTRA_ADMIN_ROLE]
  })
  const aliceWeb = await mintWebSession(db, {
    userId: alice.userId,
    scopes: ['read'],
    lifetime: SSO_WEB_SESSION_LIFETIME
  })
  const aliceComputer = `c-alice-${n}`
  await registerComputer(db, { id: aliceComputer, name: 'a', platform: 'p', version: '0' })
  await setComputerOwner(db, aliceComputer, alice.userId)
  expect(registry.count(), 'three sso sockets tracked').toEqual(3)

  const timers = fakeTimers()
  const recheck = startSsoRecheck({
    auth: ssoAuth,
    sso,
    db,
    revoker: access,
    timers,
    fetch: entra.fetch,
    log: (m) => log.push(m)
  })
  cleanups.push(() => recheck.stop())

  const ctx = await ssoAuth.$context
  return {
    ssoAuth,
    gateway,
    entra,
    timers,
    recheck,
    alice,
    bob,
    carol,
    aliceWeb,
    aliceComputer,
    sessionsOf: async (userId: string) => (await ctx.internalAdapter.listSessions(userId)).length,
    roleOf: async (userId: string) =>
      ((await ctx.internalAdapter.findUserById(userId)) as { role?: string })?.role
  }
}

/** A scenario whose boot tick has run to completion, with the audit lines it wrote. */
async function afterFirstTick() {
  const s = await entraScenario()
  const audit = captureAudit()
  const report = await s.timers.fire('timeout')
  expect(report?.checked, 'the boot tick ran a pass over all three').toEqual(3)
  return { ...s, audit }
}

describe('Entra re-check, through the tick', () => {
  test('scheduled: first pass after boot, then hourly', async () => {
    const s = await entraScenario()
    expect(s.recheck.active, 'active').toEqual(true)
    expect(
      s.timers.scheduled.map((t) => `${t.kind}:${t.ms}`),
      'timers'
    ).toEqual([`timeout:${BOOT_RECHECK_DELAY_MS}`, `interval:${RECHECK_INTERVAL_MS}`])
    expect(RECHECK_INTERVAL_MS, 'hourly').toEqual(60 * 60 * 1000)
  })

  describe('after the first tick', () => {
    test('one tick: invalid_grant ends her sessions; account enabled, computer kept (O-24)', async () => {
      const s = await afterFirstTick()
      const { alice, audit } = s
      expect(await s.sessionsOf(alice.userId), 'alice revoked').toEqual(0)
      expect(await alice.socket.closed, 'her socket closed').toEqual(SESSION_ENDED_CLOSE_CODE)
      const webRow = await db.get<{ revoked_at: number | null }>(
        'SELECT revoked_at FROM web_sessions WHERE id = ?',
        [s.aliceWeb.id]
      )
      expect(webRow?.revoked_at, 'her web session revoked').not.toBeNull()
      const computer = await db.get<{ revoked_at: number | null }>(
        'SELECT revoked_at FROM computers WHERE id = ?',
        [s.aliceComputer]
      )
      expect(computer?.revoked_at, 'her computer stays enrolled').toEqual(null)
      expect(s.gateway.dropped, 'and connected').toEqual([])
      expect(
        audit.some((l) => l.event === 'computer.revoke'),
        'no computer.revoke line'
      ).toBeFalsy()
      // Its key still authenticates: her account is not disabled.
      const minted = await mintComputerApiKey(s.ssoAuth, { computerId: s.aliceComputer, name: 'a' })
      await db.run('UPDATE computers SET auth_key_id = ? WHERE id = ?', [
        minted.keyId,
        s.aliceComputer
      ])
      const adapters = createComputerAuthAdapters({ db, auth: s.ssoAuth })
      expect(await adapters.verifyApiKey(minted.key), 'her computer still connects').not.toBeNull()
      const disabled = (
        (await (await s.ssoAuth.$context).internalAdapter.findUserById(alice.userId)) as {
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
      const s = await afterFirstTick()
      expect(await s.sessionsOf(s.bob.userId), 'session kept').toEqual(1)
      expect(s.bob.socket.ws.readyState, 'socket open').toEqual(WebSocket.OPEN)
      const failures = s.audit.filter(
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
      const s = await afterFirstTick()
      expect(await s.roleOf(s.carol.userId), 'promoted').toEqual('admin')
      expect(await s.carol.socket.closed, 'socket closed to reconnect').toEqual(
        SESSION_ENDED_CLOSE_CODE
      )
      expect(await s.sessionsOf(s.carol.userId), 'session kept').toEqual(1)
      const change = s.audit.find((l) => l.event === 'user.role_change')
      expect(change?.targetId, 'audited').toEqual(s.carol.userId)
      expect((change?.detail as { reason?: string } | undefined)?.reason, 'reason').toEqual(
        'sso_recheck'
      )
    })

    test('next hour: the outage is retried, no second line; then recovery', async () => {
      const s = await afterFirstTick()
      const { entra, bob } = s
      const before = entra.refreshes.length
      const audit = captureAudit()
      await s.timers.fire('interval')
      const asked = entra.refreshes.slice(before)
      expect(
        asked.filter((r) => r.startsWith(bob.refreshToken)).length,
        'bob retried, once'
      ).toEqual(1)
      expect(
        asked.some((r) => r.startsWith(`${s.carol.refreshToken}+`)),
        'carol asked again'
      ).toBe(true)
      expect(
        audit.filter((l) => l.event === 'auth.sso.recheck').length,
        'no new auth.sso.recheck line while still down'
      ).toEqual(0)
      expect(
        asked.some((r) => r.startsWith(s.alice.refreshToken)),
        'alice (no session) not asked again'
      ).toBe(false)
      expect(await s.sessionsOf(bob.userId), 'still kept').toEqual(1)

      entra.behaviour.set(bob.refreshToken, {
        kind: 'tokens',
        oid: bob.oid,
        roles: [ENTRA_USER_ROLE]
      })
      await s.timers.fire('interval')
      expect(
        audit.some((l) => l.event === 'auth.sso.recheck' && l.outcome === 'success'),
        'recovery line'
      ).toBe(true)
      expect(await s.sessionsOf(bob.userId), 'kept through it all').toEqual(1)
    })

    test('never two passes at once', async () => {
      const s = await entraScenario()
      const held = s.entra.hold()
      const first = s.recheck.runNow()
      // The first pass is inside Entra's token endpoint, held there. A pass asks about
      // one account at a time, so any further request reaching the gate while it is
      // held belongs to a second, concurrent pass.
      await held.arrival(1)
      const secondPassStarted = held.arrival(2).then(() => 'a second pass reached Entra')
      expect(
        await Promise.race([s.recheck.runNow(), secondPassStarted]),
        'second refused while the first runs'
      ).toEqual(null)
      expect(
        await Promise.race([s.timers.fire('interval'), secondPassStarted]),
        'a tick meanwhile is skipped too'
      ).toEqual(null)
      held.release()
      expect(await first, 'first finished').not.toBeNull()
    })

    test('a hub without Entra sign-in (the desktop app’s): no timer, nothing asked', async () => {
      const entra = fakeEntra()
      const registry = createTrpcConnectionRegistry()
      cleanups.push(() => registry.stop())
      const off = fakeTimers()
      const handle = startSsoRecheck({
        auth,
        sso: null,
        db,
        revoker: createUserAccessRevoker({
          db,
          getGateway: () => fakeGateway(),
          connections: registry,
          log: (m) => log.push(m)
        }),
        timers: off,
        fetch: entra.fetch
      })
      expect(handle.active, 'inactive').toEqual(false)
      expect(off.scheduled.length, 'no timer').toEqual(0)
      expect(await handle.runNow(), 'runNow is inert').toEqual(null)
      expect(entra.refreshes.length, 'Entra not contacted').toEqual(0)
    })
  })
})
