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
 * Native ABI: the app DB is better-sqlite3 built for Electron, so this runs under the
 * Electron strict loader (hand-rolled harness, like hub-users.test.ts).
 *
 * Run with:
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron --import tsx/esm \
 *     --experimental-loader ./packages/shared/test-utils/loader.ts \
 *     packages/apps/hub/src/leavers.test.ts
 */
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

let passed = 0
let failed = 0

async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn()
    console.log(`  ✓ ${name}`)
    passed++
  } catch (e) {
    console.error(`  ✗ ${name}`)
    console.error(`    ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`)
    failed++
  }
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`assertion failed: ${msg}`)
}
function assertEq(actual: unknown, expected: unknown, msg: string): void {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a !== e) throw new Error(`${msg}: expected ${e}, got ${a}`)
}

/** Poll until `cond` holds (the tick runs its pass without being awaited). */
async function waitFor(cond: () => boolean | Promise<boolean>, what: string): Promise<void> {
  for (let i = 0; i < 400; i++) {
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

async function main(): Promise<void> {
  console.log('\nleavers and session lifetimes (T-12)')
  console.log('─'.repeat(40))

  const tmpDir = mkdtempSync(join(tmpdir(), 'hub-leavers-'))
  const harness = await createTestHarness()
  const db: SlayzoneDb = harness.slayDb
  const audit: Array<Record<string, unknown>> = []
  setSecurityLogSink((line) => audit.push(JSON.parse(line) as Record<string, unknown>))
  const cleanups: Array<() => Promise<void> | void> = []
  const log: string[] = []

  try {
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
    assert(owner.ok && leaver.ok, 'created both accounts')
    const leaverId = leaver.user.id

    const full = await auth.api.signInEmail({
      body: { email: 'leaver@example.com', password: leaver.user.password }
    })
    const web = await webLogin(auth, db, 'leaver@example.com', leaver.user.password)
    assert(web.ok, 'web login')
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

    await test('before: the gate knows both credentials', async () => {
      assertEq((await viaBearer(full.token)).status, 200, 'bearer')
      // A live web session is a real credential of the wrong class for /api: 403, not 401.
      assertEq((await viaCookie(web.token)).status, 403, 'szw_ cookie recognised')
    })

    const leaverFullSocket = await openSocket(sockets.url, full.token)
    const leaverWebSocket = await openSocket(sockets.url, web.token)
    const ownerSocket = await openSocket(sockets.url, ownerFull.token)
    cleanups.push(() => ownerSocket.ws.terminate())
    assertEq(registry.count(leaverId), 2, 'leaver sockets tracked')
    assertEq(registry.count(owner.user.id), 1, 'owner socket tracked')

    audit.length = 0
    await test('disable: 401 on both credential classes, sockets closed, computers revoked', async () => {
      assertEq(await users.disable('leaver@example.com'), 'ok', 'disabled')

      assertEq((await viaBearer(full.token)).status, 401, 'bearer 401')
      assertEq((await viaCookie(web.token)).status, 401, 'szw_ cookie 401')
      assertEq(
        await leaverFullSocket.closed,
        SESSION_ENDED_CLOSE_CODE,
        'full-session socket closed'
      )
      assertEq(await leaverWebSocket.closed, SESSION_ENDED_CLOSE_CODE, 'web-session socket closed')
      assertEq(ownerSocket.ws.readyState, WebSocket.OPEN, "the owner's socket stays open")
      assertEq((await viaBearer(ownerFull.token)).status, 200, "the owner's bearer still works")

      const computers = await db.all<{ id: string; revoked_at: number | null }>(
        'SELECT id, revoked_at FROM computers ORDER BY id'
      )
      assertEq(
        computers.map((c) => `${c.id}:${c.revoked_at === null ? 'live' : 'revoked'}`),
        ['c-leaver-1:revoked', 'c-leaver-2:revoked', 'c-owner:live'],
        "the leaver's computers revoked, the owner's not"
      )
      assertEq([...gateway.dropped].sort(), ['c-leaver-1', 'c-leaver-2'], 'and dropped')
    })

    await test('disable keeps every data row', async () => {
      const authDb = new DatabaseSync(authDbPath)
      try {
        const count = (sql: string) => (authDb.prepare(sql).get(leaverId) as { n: number }).n
        assertEq(count('SELECT count(*) AS n FROM user WHERE id = ?'), 1, 'user row')
        assertEq(count('SELECT count(*) AS n FROM account WHERE userId = ?'), 1, 'account row')
      } finally {
        authDb.close()
      }
      const one = async (sql: string) =>
        ((await db.get<{ n: number }>(sql, [leaverId])) ?? { n: -1 }).n
      assertEq(
        await one('SELECT count(*) AS n FROM projects WHERE owner_user_id = ?'),
        1,
        'project'
      )
      assertEq(
        await one('SELECT count(*) AS n FROM web_sessions WHERE user_id = ?'),
        1,
        'web session row'
      )
      assertEq(
        await one('SELECT count(*) AS n FROM computers WHERE owner_user_id = ?'),
        2,
        'computer rows'
      )
    })

    await test('disable writes the audit lines', async () => {
      const lines = audit.map((l) => `${l.event}:${l.outcome}`)
      for (const expected of [
        'auth.session.revoke:success',
        'auth.web_session.revoke:success',
        'computer.revoke:success',
        'user.disable:success'
      ]) {
        assert(lines.includes(expected), `${expected} in ${lines.join(', ')}`)
      }
      const revokes = audit.filter((l) => l.event === 'computer.revoke')
      assertEq(
        revokes.map((l) => [l.targetId, (l.detail as { reason?: string }).reason]).sort(),
        [
          ['c-leaver-1', 'user_disabled'],
          ['c-leaver-2', 'user_disabled']
        ],
        'one computer.revoke per computer'
      )
      assert(!JSON.stringify(audit).includes(full.token), 'no token in a line')
    })

    await test("a disabled owner's computer key and join token are refused", async () => {
      const adapters = createComputerAuthAdapters({ db, auth })
      const minted = await mintComputerApiKey(auth, { computerId: 'c-leaver-1', name: 'c' })
      await db.run('UPDATE computers SET auth_key_id = ? WHERE id = ?', [
        minted.keyId,
        'c-leaver-1'
      ])
      // Even un-revoked (by hand), the computer of a disabled owner does not authenticate.
      await unrevokeComputer(db, 'c-leaver-1')
      assertEq(await adapters.verifyApiKey(minted.key), null, 'hello refused')
      const ownersKey = await mintComputerApiKey(auth, { computerId: 'c-owner', name: 'c' })
      await db.run('UPDATE computers SET auth_key_id = ? WHERE id = ?', [
        ownersKey.keyId,
        'c-owner'
      ])
      assert((await adapters.verifyApiKey(ownersKey.key)) !== null, "the owner's computer works")

      const joinToken = await mintJoinToken(db, {
        hubUrl: 'ws://127.0.0.1:1/computers',
        ttlMs: 60_000,
        label: 'leaver laptop',
        mintedByUserId: leaverId
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
      assert(refused instanceof Error && /disabled/.test(refused.message), 'enrollment refused')
      await db.run('UPDATE computers SET revoked_at = ? WHERE id = ?', [Date.now(), 'c-leaver-1'])
    })

    await test('enable resurrects nothing: old credentials stay dead, computers stay revoked', async () => {
      assertEq(await users.enable('leaver@example.com'), 'ok', 'enabled')
      assertEq((await viaBearer(full.token)).status, 401, 'old bearer')
      assertEq((await viaCookie(web.token)).status, 401, 'old szw_')
      const live = await db.get<{ n: number }>(
        'SELECT count(*) AS n FROM computers WHERE owner_user_id = ? AND revoked_at IS NULL',
        [leaverId]
      )
      assertEq(live?.n, 0, 'computers still revoked')
      const fresh = await auth.api.signInEmail({
        body: { email: 'leaver@example.com', password: leaver.user.password }
      })
      assertEq((await viaBearer(fresh.token)).status, 200, 'a new sign-in works')
    })

    await test('a socket whose session ended any other way closes at the next revalidation', async () => {
      assertEq(ownerSocket.ws.readyState, WebSocket.OPEN, 'open')
      await auth.api.signOut({
        headers: new Headers({ authorization: `Bearer ${ownerFull.token}` })
      })
      assertEq(await registry.revalidateAll(), 1, 'one closed')
      assertEq(await ownerSocket.closed, SESSION_ENDED_CLOSE_CODE, 'with the session-ended code')
      assertEq(registry.count(), 0, 'nothing tracked')

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
      assertEq([reg.count(), intervals.length], [0, 0], 'a closed socket is not tracked')
      reg.track(sock(1), 'u1', async () => null)
      reg.track(sock(1), 'u2', async () => {
        throw new Error('db down')
      })
      assertEq(intervals.length, 1, 'one timer')
      assertEq(await reg.revalidateAll(), 2, 'both closed: ended, and a check that threw')
      assertEq([closes, reg.count(), intervals.length], [[4401, 4401], 0, 0], 'timer stopped')
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

    const ssoAuth = await createHubAuth({
      dbPath: join(tmpDir, 'hub-auth-sso.sqlite'),
      baseURL: 'http://127.0.0.1:9999',
      secret: 'hub-leavers-sso-test-secret-at-least-32-chars',
      sso
    })
    const ssoRegistry = createTrpcConnectionRegistry()
    cleanups.push(() => ssoRegistry.stop())
    const ssoGateway = fakeGateway()
    const ssoAccess = createUserAccessRevoker({
      db,
      getGateway: () => ssoGateway,
      connections: ssoRegistry,
      log: (m) => log.push(m)
    })
    const ssoSockets = await socketListener(ssoAuth, db, ssoRegistry)
    cleanups.push(() => ssoSockets.close())

    /** An account as an Entra sign-in leaves it, with a session and its bearer token. */
    async function entraPerson(oid: string, role: 'admin' | 'user') {
      const ctx = await ssoAuth.$context
      const user = await ctx.internalAdapter.createUser({
        email: `${oid}@normain.test`,
        name: oid,
        emailVerified: true,
        role
      })
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
      ((await (await ssoAuth.$context).internalAdapter.findUserById(userId)) as { role?: string })
        ?.role

    const alice = await entraPerson('alice', 'admin') // Entra will refuse her
    const bob = await entraPerson('bob', 'user') // Entra will be down for him
    const carol = await entraPerson('carol', 'user') // promoted in Entra
    behaviour.set('rt-alice', { kind: 'error', status: 400, error: 'invalid_grant' })
    behaviour.set('rt-bob', { kind: 'error', status: 503, error: 'temporarily_unavailable' })
    behaviour.set('rt-carol', { kind: 'tokens', oid: 'carol', roles: [ENTRA_ADMIN_ROLE] })

    const aliceWeb = await mintWebSession(db, {
      userId: alice.userId,
      scopes: ['read'],
      lifetime: SSO_WEB_SESSION_LIFETIME
    })
    await registerComputer(db, { id: 'c-alice', name: 'a', platform: 'p', version: '0' })
    await setComputerOwner(db, 'c-alice', alice.userId)
    const aliceSocket = await openSocket(ssoSockets.url, alice.token)
    const bobSocket = await openSocket(ssoSockets.url, bob.token)
    cleanups.push(() => bobSocket.ws.terminate())
    const carolSocket = await openSocket(ssoSockets.url, carol.token)
    assertEq(ssoRegistry.count(), 3, 'three sso sockets tracked')

    const timers = fakeTimers()
    const recheck = startSsoRecheck({
      auth: ssoAuth,
      sso,
      db,
      revoker: ssoAccess,
      timers,
      fetch: entraFetch,
      log: (m) => log.push(m)
    })
    cleanups.push(() => recheck.stop())

    await test('scheduled: first pass after boot, then hourly', () => {
      assertEq(recheck.active, true, 'active')
      assertEq(
        timers.scheduled.map((t) => `${t.kind}:${t.ms}`),
        [`timeout:${BOOT_RECHECK_DELAY_MS}`, `interval:${RECHECK_INTERVAL_MS}`],
        'timers'
      )
      assertEq(RECHECK_INTERVAL_MS, 60 * 60 * 1000, 'hourly')
    })

    audit.length = 0
    await test('one tick: invalid_grant ends her sessions; account enabled, computer kept (O-24)', async () => {
      timers.fire('timeout')
      await waitFor(async () => (await sessionsOf(alice.userId)) === 0, 'alice revoked')
      await waitFor(
        () => audit.some((l) => l.event === 'auth.sso.recheck' && l.outcome === 'failure'),
        'pass finished'
      )
      assertEq(await aliceSocket.closed, SESSION_ENDED_CLOSE_CODE, 'her socket closed')
      const webRow = await db.get<{ revoked_at: number | null }>(
        'SELECT revoked_at FROM web_sessions WHERE id = ?',
        [aliceWeb.id]
      )
      assert(webRow?.revoked_at !== null, 'her web session revoked')
      const computer = await db.get<{ revoked_at: number | null }>(
        'SELECT revoked_at FROM computers WHERE id = ?',
        ['c-alice']
      )
      assertEq(computer?.revoked_at, null, 'her computer stays enrolled')
      assertEq(ssoGateway.dropped, [], 'and connected')
      assert(!audit.some((l) => l.event === 'computer.revoke'), 'no computer.revoke line')
      // Its key still authenticates: her account is not disabled.
      const minted = await mintComputerApiKey(ssoAuth, { computerId: 'c-alice', name: 'a' })
      await db.run('UPDATE computers SET auth_key_id = ? WHERE id = ?', [minted.keyId, 'c-alice'])
      const adapters = createComputerAuthAdapters({ db, auth: ssoAuth })
      assert((await adapters.verifyApiKey(minted.key)) !== null, 'her computer still connects')
      const disabled = (
        (await (await ssoAuth.$context).internalAdapter.findUserById(alice.userId)) as {
          disabledAt?: unknown
        }
      )?.disabledAt
      assert(disabled === null || disabled === undefined, 'not disabled')
      const denied = audit.filter((l) => l.event === 'auth.sso.recheck' && l.outcome === 'denied')
      assertEq(denied.length, 1, 'one denied line')
      assertEq(denied[0]?.targetId, alice.userId, 'for alice')
      assertEq((denied[0]?.detail as { reason?: string }).reason, 'invalid_grant', 'reason')
    })

    await test('same tick: the outage keeps his sessions; audited once, at level info', async () => {
      assertEq(await sessionsOf(bob.userId), 1, 'session kept')
      assertEq(bobSocket.ws.readyState, WebSocket.OPEN, 'socket open')
      const failures = audit.filter(
        (l) => l.event === 'auth.sso.recheck' && l.outcome === 'failure'
      )
      assertEq(failures.length, 1, 'one line')
      assertEq(failures[0]?.level, 'info', 'level info')
      assertEq(
        (failures[0]?.detail as { reason?: string; cause?: string }).cause,
        'http_503',
        'cause'
      )
    })

    await test('same tick: a changed app role updates role and closes the sockets', async () => {
      assertEq(await roleOf(carol.userId), 'admin', 'promoted')
      assertEq(await carolSocket.closed, SESSION_ENDED_CLOSE_CODE, 'socket closed to reconnect')
      assertEq(await sessionsOf(carol.userId), 1, 'session kept')
      const change = audit.find((l) => l.event === 'user.role_change')
      assertEq(change?.targetId, carol.userId, 'audited')
      assertEq((change?.detail as { reason?: string }).reason, 'sso_recheck', 'reason')
    })

    await test('next hour: the outage is retried, no second line; then recovery', async () => {
      const before = refreshes.filter((r) => r.startsWith('rt-bob')).length
      audit.length = 0
      timers.fire('interval')
      await waitFor(
        () => refreshes.filter((r) => r.startsWith('rt-bob')).length === before + 1,
        'bob retried'
      )
      await waitFor(() => refreshes.some((r) => r.startsWith('rt-carol+')), 'carol asked again')
      await new Promise((r) => setTimeout(r, 50))
      assertEq(
        audit.filter((l) => l.event === 'auth.sso.recheck').length,
        0,
        'no new auth.sso.recheck line while still down'
      )
      assert(!refreshes.slice(-3).includes('rt-alice'), 'alice (no session) not asked again')
      assertEq(await sessionsOf(bob.userId), 1, 'still kept')

      behaviour.set('rt-bob', { kind: 'tokens', oid: 'bob', roles: [ENTRA_USER_ROLE] })
      timers.fire('interval')
      await waitFor(
        () => audit.some((l) => l.event === 'auth.sso.recheck' && l.outcome === 'success'),
        'recovery line'
      )
      assertEq(await sessionsOf(bob.userId), 1, 'kept through it all')
    })

    await test('never two passes at once', async () => {
      let release!: () => void
      slow = new Promise<void>((r) => {
        release = r
      })
      const first = recheck.runNow()
      await waitFor(() => refreshes.length > 0, 'first pass in flight')
      assertEq(await recheck.runNow(), null, 'second refused while the first runs')
      release()
      slow = null
      assert((await first) !== null, 'first finished')
    })

    await test('a hub without Entra sign-in (the desktop app’s): no timer, nothing asked', async () => {
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
      assertEq(handle.active, false, 'inactive')
      assertEq(off.scheduled.length, 0, 'no timer')
      assertEq(await handle.runNow(), null, 'runNow is inert')
      assertEq(refreshes.length, before, 'Entra not contacted')
    })
  } finally {
    setSecurityLogSink()
    for (const c of cleanups.reverse()) await c()
    await harness.cleanup()
    rmSync(tmpDir, { recursive: true, force: true })
  }

  console.log(`\n${passed} passed, ${failed} failed\n`)
  process.exit(failed > 0 ? 1 : 0)
}

void main()
