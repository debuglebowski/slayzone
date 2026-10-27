/**
 * The web shell's session routes (T-13) — `POST /api/auth/web-session` and
 * `POST /api/auth/web-logout` — over a REAL hub-auth and a real migrated app DB, served
 * on a loopback listener with the hub's own Origin rule (`cookieOriginDecision`).
 *
 * Native ABI: the app DB is better-sqlite3 built for Electron, so this runs under
 * Electron's node, like hub-users.test.ts.
 *
 * Run with:
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron node_modules/vitest/vitest.mjs run \
 *     --config packages/shared/test-utils/vitest.harness.config.ts \
 *     packages/apps/hub/src/web-session-routes.test.ts
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, assert, expect, test } from 'vitest'
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

afterAll(async () => {
  await loopback.close()
  await https.close()
  await harness.cleanup()
  rmSync(tmpDir, { recursive: true, force: true })
})

test('status: no cookie → signed out; a live cookie → signed in', async () => {
  const none = await post(loopback, WEB_SESSION_STATUS_PATH)
  expect(none.status, 'status 200').toBe(200)
  expect(await none.json(), 'signed out').toEqual({ ok: true, signedIn: false })
  expect(none.headers.get('set-cookie'), 'nothing to clear').toBe(null)
  const session = await mint()
  const live = await post(loopback, WEB_SESSION_STATUS_PATH, {
    cookie: webCookie(session.token)
  })
  expect(await live.json(), 'cookie only').toEqual({ ok: true, signedIn: true })
})

test('status: a dead cookie → signed out, and it is cleared', async () => {
  const dead = await post(loopback, WEB_SESSION_STATUS_PATH, { cookie: webCookie('szw_gone') })
  expect(((await dead.json()) as { signedIn: boolean }).signedIn, 'signed out').toBe(false)
  expect(dead.headers.get('set-cookie'), 'cleared').toEqual(
    clearWebSessionCookie({ secure: false })
  )
})

test('a cookie with a missing, null or foreign Origin is refused (403, audited)', async () => {
  const session = await mint()
  const lines = await captureAudit(async () => {
    for (const path of [WEB_SESSION_STATUS_PATH, WEB_LOGOUT_PATH]) {
      for (const origin of [null, 'null', 'http://127.0.0.1:1', 'https://evil.example']) {
        const res = await post(loopback, path, { cookie: webCookie(session.token), origin })
        expect(res.status, `${path} Origin ${origin} → 403`).toBe(403)
        expect(res.headers.get('set-cookie'), 'no cookie touched').toBe(null)
      }
    }
  })
  expect(lines.length, 'one line per refusal').toBe(8)
  for (const l of lines) {
    expect(`${l.event}:${(l.detail as { reason?: string }).reason}`, 'reason').toBe(
      'authz.denied:origin'
    )
  }
  expect((await verifyWebSessionToken(db, session.token)).ok, 'session untouched').toBe(true)
  expect(loopback.signedOut(), 'no sign-out ran').toBe(0)
})

test('logout: revokes the row, clears the cookie, audits it, closes its sockets', async () => {
  const session = await mint()
  const before = loopback.signedOut()
  let res: Response | null = null
  const lines = await captureAudit(async () => {
    res = await post(loopback, WEB_LOGOUT_PATH, { cookie: webCookie(session.token) })
  })
  assert(res, 'responded')
  const r = res as Response
  expect(r.status, '200').toBe(200)
  expect(await r.json(), 'ok').toEqual({ ok: true })
  expect(r.headers.getSetCookie().join('|'), 'cleared').toEqual(
    clearWebSessionCookie({ secure: false })
  )
  expect((await verifyWebSessionToken(db, session.token)).ok, 'row revoked').toBe(false)
  const revoke = lines.filter((l) => l.event === 'auth.web_session.revoke')
  expect(revoke.length, 'one revoke line').toBe(1)
  expect(revoke[0]!.outcome, 'success').toBe('success')
  expect(revoke[0]!.actor, 'as the session user').toEqual(created.id)
  expect(revoke[0]!.targetId, 'names the row').toEqual(session.id)
  expect(revoke[0]!.route, 'from the sign-out route').toEqual(`POST ${WEB_LOGOUT_PATH}`)
  expect(JSON.stringify(lines), 'the token is never logged').not.toContain(session.token)
  expect(loopback.signedOut(), 'sockets revalidated').toEqual(before + 1)
  const after = await post(loopback, WEB_SESSION_STATUS_PATH, {
    cookie: webCookie(session.token)
  })
  expect(((await after.json()) as { signedIn: boolean }).signedIn, 'signed out now').toBe(false)
})

test('logout on an https hub clears with Secure (attributes match the set cookie)', async () => {
  const session = await mintBrowserWebSession(auth, db, created.id, { secure: true })
  const res = await post(https, WEB_LOGOUT_PATH, { cookie: webCookie(session.token) })
  expect(res.headers.get('set-cookie'), 'Secure clear').toEqual(
    clearWebSessionCookie({ secure: true })
  )
  expect(session.setCookie, 'the set cookie was Secure too').toContain('; Secure')
})

test('logout also ends a better-auth session the browser holds (e.g. a device approval)', async () => {
  const session = await mint()
  const signedIn = await auth.api.signInEmail({
    body: { email: 'web@example.com', password: created.password },
    returnHeaders: true
  })
  const fullCookie = signedIn.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ')
  expect(
    await auth.api.getSession({ headers: new Headers({ cookie: fullCookie }) }),
    'the better-auth session is live'
  ).not.toBe(null)
  const res = await post(loopback, WEB_LOGOUT_PATH, {
    cookie: `${webCookie(session.token)}; ${fullCookie}`
  })
  expect(res.status, '200').toBe(200)
  const cleared = res.headers.getSetCookie()
  expect(cleared.length, `both cookies cleared, got ${cleared.join(' | ')}`).toBeGreaterThan(1)
  expect(
    await auth.api.getSession({ headers: new Headers({ cookie: fullCookie }) }),
    'the better-auth session is gone'
  ).toBe(null)
})

test('logout with no cookie still answers ok and clears; nothing revoked', async () => {
  const lines = await captureAudit(async () => {
    const res = await post(loopback, WEB_LOGOUT_PATH)
    expect(res.status, '200').toBe(200)
    expect(res.headers.get('set-cookie'), 'cleared').toEqual(
      clearWebSessionCookie({ secure: false })
    )
  })
  expect(lines.filter((l) => l.event === 'auth.web_session.revoke').length, 'no revoke').toBe(0)
})

test('POST only; other paths are not taken', async () => {
  expect((await post(loopback, WEB_LOGOUT_PATH, { method: 'GET' })).status, 'GET 405').toBe(405)
  expect((await post(loopback, '/api/auth/web-logout/extra')).status, 'falls through').toBe(404)
})
