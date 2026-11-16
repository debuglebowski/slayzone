/**
 * An already-open `/trpc` socket against PERSISTED IdP-role state changed by ANOTHER
 * runtime (another hub process on the same database): the production socket context
 * (trpc-socket-context.ts `createHubTrpcContext`) + the production procedure chain
 * (trpc-server `publicProcedure`, its `livenessGate`) + applyWSSHandler + a real tRPC
 * WebSocket client, over two hub-auth instances sharing one sqlite file.
 *
 * Proves: a socket opened on a runtime with the mode OFF, or on an older managed config,
 * loses every operation and every subscription output the moment another runtime
 * activates (or changes the config) — synchronously, without waiting for the periodic
 * sweep, a deadline timer, or any refresh — and the socket is closed. Also the same
 * runtime's own revocation and evidence expiry with a refresh still pending. Mode off on
 * both sides: unchanged.
 *
 * Run with: vitest (packages/shared/test-utils/vitest.harness.config.ts)
 */
import { EventEmitter, on } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { parseConfig, type RoleConfig } from '@normain/idp-role-contract'
import { createHubAuth, type HubAuth } from '@slayzone/hub-auth/server'
import {
  FakeOidcIssuer,
  type IssuedClaims,
  OIDC_CLIENT_ID,
  OIDC_CLIENT_SECRET,
  signInThroughFakeIssuer
} from '@slayzone/hub-auth/testing'
import type { SlayzoneDb } from '@slayzone/platform'
import { setSecurityLogSink } from '@slayzone/platform/security-log'
import { publicProcedure, router, trpcTransformer } from '@slayzone/trpc-server'
import { createTRPCClient, createWSClient, wsLink } from '@trpc/client'
import { applyWSSHandler } from '@trpc/server/adapters/ws'
import { afterAll, afterEach, describe, expect, test, vi } from 'vitest'
import { WebSocket, WebSocketServer } from 'ws'
import { createTestHarness } from '../../../shared/test-utils/ipc-harness.js'
import { createTrpcConnectionRegistry } from './trpc-connections.js'
import { createHubTrpcContext } from './trpc-socket-context.js'

vi.useFakeTimers({ toFake: ['Date'], now: Date.now() })
const later = (ms = 1100): void => {
  vi.setSystemTime(Date.now() + ms)
}

const managed = (over: Record<string, string> = {}): RoleConfig =>
  parseConfig(
    {
      IDP_ROLES_ENABLED: 'true',
      IDP_ROLE_CLAIM: 'roles',
      IDP_ROLE_MAPPING: JSON.stringify({ 'Hub.Admin': ['admin'], 'Hub.User': ['user'] }),
      ...over
    },
    ['admin', 'user']
  )

const tmpDir = mkdtempSync(join(tmpdir(), 'hub-trpc-live-fence-'))
const issuer = new FakeOidcIssuer()
await issuer.start()
const harness = await createTestHarness()
const db: SlayzoneDb = harness.slayDb
setSecurityLogSink(() => undefined)
const cleanups: Array<() => Promise<void> | void> = []

afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c()
})
afterAll(async () => {
  setSecurityLogSink()
  vi.useRealTimers()
  await issuer.stop()
  await harness.cleanup()
  rmSync(tmpDir, { recursive: true, force: true })
})

// A router on the PRODUCTION procedure chain: a query and a subscription whose outputs
// the test releases one at a time.
const ticks = new EventEmitter()
const testRouter = router({
  ping: publicProcedure.query(({ ctx }) => `pong:${ctx.principal?.userId ?? 'none'}`),
  ticks: publicProcedure.subscription(async function* (opts) {
    for await (const [n] of on(ticks, 'tick', { signal: opts.signal })) yield n as number
  })
})
type TestRouter = typeof testRouter

let counter = 0
async function runtime(idpRoles: RoleConfig | null, authDbPath: string) {
  const baseURL = `http://127.0.0.1:${40000 + ++counter}`
  const auth = await createHubAuth({
    dbPath: authDbPath,
    baseURL,
    secret: 'hub-trpc-live-fence-secret-at-least-32-chars',
    enablePassword: false,
    sso: {
      issuer: issuer.issuer,
      clientId: OIDC_CLIENT_ID,
      clientAuth: { method: 'client_secret_basic', secret: OIDC_CLIENT_SECRET },
      requireMfa: false,
      idpRoles
    }
  })
  later()
  return { auth, baseURL }
}

/** One hub's `/trpc` endpoint, wired as server.ts wires it. */
async function serve(auth: HubAuth) {
  const http: Server = createServer()
  const wss = new WebSocketServer({ server: http })
  const connections = createTrpcConnectionRegistry()
  const handler = applyWSSHandler({
    wss,
    router: testRouter,
    createContext: createHubTrpcContext({
      hubAuthRequired: true,
      hubAuth: auth,
      db,
      connections,
      isCookieOriginAllowed: () => false,
      extra: {}
    }) as never
  })
  await new Promise<void>((r) => http.listen(0, '127.0.0.1', r))
  const port = (http.address() as AddressInfo).port
  cleanups.push(async () => {
    handler.broadcastReconnectNotification()
    connections.stop()
    wss.close()
    await new Promise<void>((r) => http.close(() => r()))
  })
  return port
}

/** An already-open client socket with a running subscription. */
async function openClient(port: number, token: string) {
  const closes: number[] = []
  const ws = createWSClient({
    url: `ws://127.0.0.1:${port}`,
    WebSocket: WebSocket as unknown as typeof globalThis.WebSocket,
    connectionParams: { token },
    retryDelayMs: () => 60_000,
    onClose: (cause) => closes.push(cause?.code ?? 0)
  })
  cleanups.push(() => ws.close())
  const trpc = createTRPCClient<TestRouter>({
    links: [wsLink({ client: ws, transformer: trpcTransformer })]
  })
  const received: number[] = []
  const errors: string[] = []
  const sub = trpc.ticks.subscribe(undefined, {
    onData: (n) => received.push(n),
    onError: (e) => errors.push(e.message)
  })
  cleanups.push(() => sub.unsubscribe())
  return { trpc, received, errors, closes }
}

const waitFor = async (cond: () => boolean, ms = 3_000): Promise<void> => {
  const end = performance.now() + ms
  while (!cond()) {
    if (performance.now() > end) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 10))
  }
}

const person = (sub: string, roles: unknown): IssuedClaims => ({ sub, extra: { roles } })

async function signIn(
  r: { auth: HubAuth; baseURL: string },
  claims: IssuedClaims
): Promise<string> {
  const s = await signInThroughFakeIssuer(r.auth, issuer, r.baseURL, claims)
  if (!s.sessionToken) throw new Error(`sign-in refused: ${s.error}`)
  return s.sessionToken
}

/** The socket is working: an operation answers and a subscription output arrives. */
async function works(c: Awaited<ReturnType<typeof openClient>>, tick: number): Promise<void> {
  expect(await c.trpc.ping.query()).toMatch(/^pong:/)
  ticks.emit('tick', tick)
  await waitFor(() => c.received.includes(tick))
}

describe('an open /trpc socket is fenced by PERSISTED state on every operation and output', () => {
  test('mode-OFF runtime, socket open, another runtime activates the mode: no operation, no output, closed', async () => {
    const path = join(tmpDir, 'off-then-on.sqlite')
    const off = await runtime(null, path)
    const token = await signIn(off, person('ann', undefined))
    const client = await openClient(await serve(off.auth), token)
    await works(client, 1)

    await runtime(managed(), path) // another process, same database: activation

    ticks.emit('tick', 2)
    await waitFor(() => client.errors.length > 0)
    expect(client.errors[0]).toMatch(/session no longer valid/)
    expect(client.received).not.toContain(2) // the output after activation never left
    await waitFor(() => client.closes.length > 0)
  })

  test('OLDER managed config, socket open, another runtime changes the config: refused before anything is delivered', async () => {
    const path = join(tmpDir, 'old-config.sqlite')
    const old = await runtime(managed(), path)
    const token = await signIn(old, person('bob', ['Hub.Admin']))
    const client = await openClient(await serve(old.auth), token)
    await works(client, 10)

    // The newer runtime even has a fresh sign-in by the same person: the old socket
    // (old epoch, old process) must still not pass.
    const newer = await runtime(managed({ IDP_RECHECK_INTERVAL_SECONDS: '1800' }), path)
    await signIn(newer, person('bob', ['Hub.Admin']))

    // An operation first: refused UNAUTHORIZED, nothing executed.
    await expect(client.trpc.ping.query()).rejects.toThrow(/session no longer valid/)
    ticks.emit('tick', 11)
    await new Promise((r) => setTimeout(r, 50))
    expect(client.received).not.toContain(11)
    await waitFor(() => client.closes.length > 0)
  })

  test('same runtime: evidence at its deadline with the refresh still pending — stopped at once, nothing awaited', async () => {
    const path = join(tmpDir, 'deadline.sqlite')
    const r = await runtime(managed(), path)
    const token = await signIn(r, person('cyd', ['Hub.User']))
    const client = await openClient(await serve(r.auth), token)
    await works(client, 20)
    // The issuer never answers a refresh; the evidence reaches its deadline.
    issuer.refreshAnswers = [{ kind: 'tokens', hold: new Promise<void>(() => undefined) }]
    new DatabaseSync(path)
      .prepare('UPDATE "user" SET idpVerifiedAt = ? WHERE email = ?')
      .run(Math.floor(Date.now() / 1000) - 3600, 'cyd@example.test')
    ticks.emit('tick', 21)
    await waitFor(() => client.errors.length > 0)
    expect(client.received).not.toContain(21)
    expect(issuer.refreshes).toEqual([]) // stopped from storage, not after a refresh
    issuer.refreshAnswers = [{ kind: 'tokens' }]
  })

  test('SAME epoch, another runtime demotes admin -> user: the cached admin socket is refused; restoring the role does not revive it', async () => {
    const path = join(tmpDir, 'demotion.sqlite')
    const a = await runtime(managed(), path)
    const b = await runtime(managed(), path) // same config: same epoch, no activation
    const token = await signIn(a, person('eve', ['Hub.Admin']))
    const client = await openClient(await serve(a.auth), token)
    await works(client, 40)
    later()
    await signIn(b, person('eve', ['Hub.User'])) // demoted by the IdP, seen on runtime B
    await expect(client.trpc.ping.query()).rejects.toThrow(/session no longer valid/)
    later()
    await signIn(b, person('eve', ['Hub.Admin'])) // the admin role given back
    ticks.emit('tick', 41)
    await new Promise((r) => setTimeout(r, 50))
    expect(client.received).not.toContain(41) // the old socket stays dead
    await waitFor(() => client.closes.length > 0)
  })

  test('its own credential deleted elsewhere (sign-out on another runtime): refused', async () => {
    const path = join(tmpDir, 'deleted.sqlite')
    const a = await runtime(managed(), path)
    const token = await signIn(a, person('fay', ['Hub.User']))
    const client = await openClient(await serve(a.auth), token)
    await works(client, 50)
    new DatabaseSync(path).prepare('DELETE FROM session WHERE token = ?').run(token)
    await expect(client.trpc.ping.query()).rejects.toThrow(/session no longer valid/)
  })

  test('its own credential expired: refused', async () => {
    const path = join(tmpDir, 'expired.sqlite')
    const a = await runtime(managed(), path)
    const token = await signIn(a, person('gil', ['Hub.User']))
    const client = await openClient(await serve(a.auth), token)
    await works(client, 60)
    new DatabaseSync(path)
      .prepare('UPDATE session SET expiresAt = ? WHERE token = ?')
      .run(new Date(Date.now() - 1000).toISOString(), token)
    await expect(client.trpc.ping.query()).rejects.toThrow(/session no longer valid/)
  })

  test('mode off: a role change by another runtime ends the cached role too', async () => {
    const path = join(tmpDir, 'off-role.sqlite')
    const a = await runtime(null, path)
    const first = await signIn(a, person('hal', undefined)) // first account: admin
    await signIn(a, person('ida', undefined))
    const client = await openClient(await serve(a.auth), first)
    await works(client, 70)
    new DatabaseSync(path)
      .prepare(`UPDATE "user" SET role = 'user' WHERE email = ?`)
      .run('hal@example.test')
    await expect(client.trpc.ping.query()).rejects.toThrow(/session no longer valid/)
  })

  test('mode off on both sides (nothing persisted changes): unchanged', async () => {
    const path = join(tmpDir, 'off-off.sqlite')
    const off = await runtime(null, path)
    const token = await signIn(off, person('dee', undefined))
    const client = await openClient(await serve(off.auth), token)
    await works(client, 30)
    await runtime(null, path) // a restart with the mode still off
    await works(client, 31)
    expect(client.errors).toEqual([])
  })
})
