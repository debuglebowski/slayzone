/**
 * The web shell's session routes (T-13) — `POST /api/auth/web-session` and
 * `POST /api/auth/web-logout` — over a REAL hub-auth and a real migrated app DB, served
 * on a loopback listener with the hub's own Origin rule (`cookieOriginDecision`).
 *
 * Native ABI: the app DB is better-sqlite3 built for Electron, so this runs under the
 * Electron strict loader (hand-rolled harness, like hub-users.test.ts).
 *
 * Run with:
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron --import tsx/esm \
 *     --experimental-loader ./packages/shared/test-utils/loader.ts \
 *     packages/apps/hub/src/web-session-routes.test.ts
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SlayzoneDb } from '@slayzone/platform'
import {
  routeOf,
  runWithSecurityContext,
  setSecurityLogSink
} from '@slayzone/platform/security-log'
import { createHubAuth, createHubUser, type HubAuth } from '@slayzone/hub-auth/server'
import { createTestHarness } from '../../../shared/test-utils/ipc-harness.js'
import { createWebSessionRoutes } from './web-session-routes.js'
import {
  clearWebSessionCookie,
  mintBrowserWebSession,
  verifyWebSessionToken,
  WEB_LOGOUT_PATH,
  WEB_SESSION_COOKIE_NAME,
  WEB_SESSION_STATUS_PATH
} from './web-sessions.js'
import { cookieOriginDecision } from './ws-origin.js'

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
  if (actual !== expected) {
    throw new Error(`${msg}: expected ${String(expected)}, got ${String(actual)}`)
  }
}

interface Mounted {
  base: string
  signedOut: () => number
  close: () => Promise<void>
}

/** The routes on a loopback listener, wired the way server.ts wires them. */
async function mount(auth: HubAuth, db: SlayzoneDb, secureCookie: boolean): Promise<Mounted> {
  let signedOut = 0
  const routes = createWebSessionRoutes({
    getAuth: () => auth,
    db,
    secureCookie,
    isCookieOriginAllowed: (req) =>
      cookieOriginDecision({
        origin: req.headers.origin,
        host: req.headers.host,
        loopbackBind: true,
        allowedOrigins: []
      }) === 'accept',
    onSignedOut: () => {
      signedOut++
    }
  })
  const server: Server = createServer((req, res) =>
    runWithSecurityContext({ actor: null, ip: null, route: routeOf(req.method, req.url) }, () => {
      if (!routes(req, res)) res.writeHead(404).end()
    })
  )
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return {
    base,
    signedOut: () => signedOut,
    close: () => new Promise<void>((r) => server.close(() => r()))
  }
}

async function captureAudit(fn: () => Promise<void>): Promise<Array<Record<string, unknown>>> {
  const lines: Array<Record<string, unknown>> = []
  setSecurityLogSink((line) => lines.push(JSON.parse(line) as Record<string, unknown>))
  try {
    await fn()
  } finally {
    setSecurityLogSink()
  }
  return lines
}

async function main(): Promise<void> {
  console.log('\nweb shell session routes (real hub-auth + app DB)')
  console.log('─'.repeat(50))

  const tmpDir = mkdtempSync(join(tmpdir(), 'web-session-routes-'))
  const auth = await createHubAuth({
    dbPath: join(tmpDir, 'hub-auth.sqlite'),
    baseURL: 'http://127.0.0.1:9999',
    secret: 'web-session-routes-test-secret-at-least-32-chars'
  })
  const harness = await createTestHarness()
  const db: SlayzoneDb = harness.slayDb
  const created = await createHubUser(auth, { email: 'web@example.com', name: 'Web' })
  assert(!('error' in created), 'created the account')
  const loopback = await mount(auth, db, false)
  const https = await mount(auth, db, true)

  const post = (
    m: Mounted,
    path: string,
    opts: { cookie?: string; origin?: string | null; method?: string } = {}
  ): Promise<Response> => {
    const headers: Record<string, string> = {}
    if (opts.cookie) headers.cookie = opts.cookie
    const origin = opts.origin === undefined ? m.base : opts.origin
    if (origin !== null) headers.origin = origin
    return fetch(`${m.base}${path}`, { method: opts.method ?? 'POST', headers })
  }
  const webCookie = (token: string): string => `${WEB_SESSION_COOKIE_NAME}=${token}`
  const mint = () => mintBrowserWebSession(auth, db, created.id, { secure: false })

  try {
    await test('status: no cookie → signed out; a live cookie → signed in', async () => {
      const none = await post(loopback, WEB_SESSION_STATUS_PATH)
      assertEq(none.status, 200, 'status 200')
      assertEq(JSON.stringify(await none.json()), '{"ok":true,"signedIn":false}', 'signed out')
      assertEq(none.headers.get('set-cookie'), null, 'nothing to clear')
      const session = await mint()
      const live = await post(loopback, WEB_SESSION_STATUS_PATH, {
        cookie: webCookie(session.token)
      })
      assertEq(JSON.stringify(await live.json()), '{"ok":true,"signedIn":true}', 'cookie only')
    })

    await test('status: a dead cookie → signed out, and it is cleared', async () => {
      const dead = await post(loopback, WEB_SESSION_STATUS_PATH, { cookie: webCookie('szw_gone') })
      assertEq(((await dead.json()) as { signedIn: boolean }).signedIn, false, 'signed out')
      assertEq(dead.headers.get('set-cookie'), clearWebSessionCookie({ secure: false }), 'cleared')
    })

    await test('a cookie with a missing, null or foreign Origin is refused (403, audited)', async () => {
      const session = await mint()
      const lines = await captureAudit(async () => {
        for (const path of [WEB_SESSION_STATUS_PATH, WEB_LOGOUT_PATH]) {
          for (const origin of [null, 'null', 'http://127.0.0.1:1', 'https://evil.example']) {
            const res = await post(loopback, path, { cookie: webCookie(session.token), origin })
            assertEq(res.status, 403, `${path} Origin ${origin} → 403`)
            assertEq(res.headers.get('set-cookie'), null, 'no cookie touched')
          }
        }
      })
      assertEq(lines.length, 8, 'one line per refusal')
      for (const l of lines) {
        assertEq(
          `${l.event}:${(l.detail as { reason?: string }).reason}`,
          'authz.denied:origin',
          'reason'
        )
      }
      assertEq((await verifyWebSessionToken(db, session.token)).ok, true, 'session untouched')
      assertEq(loopback.signedOut(), 0, 'no sign-out ran')
    })

    await test('logout: revokes the row, clears the cookie, audits it, closes its sockets', async () => {
      const session = await mint()
      const before = loopback.signedOut()
      let res: Response | null = null
      const lines = await captureAudit(async () => {
        res = await post(loopback, WEB_LOGOUT_PATH, { cookie: webCookie(session.token) })
      })
      assert(res, 'responded')
      const r = res as Response
      assertEq(r.status, 200, '200')
      assertEq(JSON.stringify(await r.json()), '{"ok":true}', 'ok')
      assertEq(
        r.headers.getSetCookie().join('|'),
        clearWebSessionCookie({ secure: false }),
        'cleared'
      )
      assertEq((await verifyWebSessionToken(db, session.token)).ok, false, 'row revoked')
      const revoke = lines.filter((l) => l.event === 'auth.web_session.revoke')
      assertEq(revoke.length, 1, 'one revoke line')
      assertEq(revoke[0]!.outcome, 'success', 'success')
      assertEq(revoke[0]!.actor, created.id, 'as the session user')
      assertEq(revoke[0]!.targetId, session.id, 'names the row')
      assertEq(revoke[0]!.route, `POST ${WEB_LOGOUT_PATH}`, 'from the sign-out route')
      assert(!JSON.stringify(lines).includes(session.token), 'the token is never logged')
      assertEq(loopback.signedOut(), before + 1, 'sockets revalidated')
      const after = await post(loopback, WEB_SESSION_STATUS_PATH, {
        cookie: webCookie(session.token)
      })
      assertEq(((await after.json()) as { signedIn: boolean }).signedIn, false, 'signed out now')
    })

    await test('logout on an https hub clears with Secure (attributes match the set cookie)', async () => {
      const session = await mintBrowserWebSession(auth, db, created.id, { secure: true })
      const res = await post(https, WEB_LOGOUT_PATH, { cookie: webCookie(session.token) })
      assertEq(
        res.headers.get('set-cookie'),
        clearWebSessionCookie({ secure: true }),
        'Secure clear'
      )
      assert(session.setCookie.includes('; Secure'), 'the set cookie was Secure too')
    })

    await test('logout also ends a better-auth session the browser holds (e.g. a device approval)', async () => {
      const session = await mint()
      const signedIn = await auth.api.signInEmail({
        body: { email: 'web@example.com', password: created.password },
        returnHeaders: true
      })
      const fullCookie = signedIn.headers
        .getSetCookie()
        .map((c) => c.split(';')[0])
        .join('; ')
      assert(
        (await auth.api.getSession({ headers: new Headers({ cookie: fullCookie }) })) !== null,
        'the better-auth session is live'
      )
      const res = await post(loopback, WEB_LOGOUT_PATH, {
        cookie: `${webCookie(session.token)}; ${fullCookie}`
      })
      assertEq(res.status, 200, '200')
      const cleared = res.headers.getSetCookie()
      assert(cleared.length > 1, `both cookies cleared, got ${cleared.join(' | ')}`)
      assertEq(
        await auth.api.getSession({ headers: new Headers({ cookie: fullCookie }) }),
        null,
        'the better-auth session is gone'
      )
    })

    await test('logout with no cookie still answers ok and clears; nothing revoked', async () => {
      const lines = await captureAudit(async () => {
        const res = await post(loopback, WEB_LOGOUT_PATH)
        assertEq(res.status, 200, '200')
        assertEq(res.headers.get('set-cookie'), clearWebSessionCookie({ secure: false }), 'cleared')
      })
      assertEq(lines.filter((l) => l.event === 'auth.web_session.revoke').length, 0, 'no revoke')
    })

    await test('POST only; other paths are not taken', async () => {
      assertEq((await post(loopback, WEB_LOGOUT_PATH, { method: 'GET' })).status, 405, 'GET 405')
      assertEq((await post(loopback, '/api/auth/web-logout/extra')).status, 404, 'falls through')
    })
  } finally {
    await loopback.close()
    await https.close()
    await harness.cleanup()
    rmSync(tmpDir, { recursive: true, force: true })
  }

  console.log(`\n${passed} passed, ${failed} failed\n`)
  if (failed > 0) process.exit(1)
}

void main()
