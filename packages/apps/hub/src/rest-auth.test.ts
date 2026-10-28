/**
 * Hub REST/MCP bearer gate — the HTTP-side twin of `hub-trpc-context.ts`.
 *
 * THE GAP THIS CLOSES: `setAuthGate` gated the tRPC router, but the SAME muxed
 * listener also serves `/api/*` (the whole `slay` CLI surface: tasks, artifacts,
 * pty write/submit, browser eval) and `/mcp` — and `createMcpRestApp` mounts
 * nothing but `express.json()`. On a hub that requires login that listener is the
 * one clients reach through the front end, so every REST route was reachable
 * unauthenticated while the `slay` CLI was already sending an `Authorization: Bearer` header
 * (from `SLAYZONE_HUB_TOKEN` / `cli-hub-target.json`) that nobody verified.
 *
 * Decisions under test (extracted from `startServer` for the same reason
 * `hub-trpc-context.ts` was — the full boot pulls composeServer → better-auth
 * migrations → two listeners):
 *   1. `restAuthAction` — pure: does THIS request need a bearer verified?
 *      Fail-open ONLY where it must (auth bootstrap, loopback callers); fail-
 *      closed everywhere else once the hub enforces auth.
 *   2. `verifyRestBearer` — a REAL better-auth session token in an
 *      `Authorization: Bearer` header resolves; anything else does not.
 *
 * No mocks of hub-auth: a real `createHubAuth` on a throwaway node:sqlite file
 * mints a genuine token via signInEmail. Native ABI → run under Electron's node.
 *
 * Run with:
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron node_modules/vitest/vitest.mjs run \
 *     --config packages/shared/test-utils/vitest.harness.config.ts \
 *     packages/apps/hub/src/rest-auth.test.ts
 */
import { createServer, type Server } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterAll, assert, expect, test } from 'vitest'
import type { SlayzoneDb } from '@slayzone/platform'
import {
  currentSecurityContext,
  setSecurityLogSink,
  type SecurityContext
} from '@slayzone/platform/security-log'
import { createHubAuth, createHubUser, type HubAuth } from '@slayzone/hub-auth/server'
import { restPrincipalOf, type RestPrincipal } from '@slayzone/api'
import { createTestHarness } from '../../../shared/test-utils/ipc-harness.js'
import {
  type RestAuthAction,
  restAuthAction,
  verifyRestBearer,
  withRestAuth,
  parseCookieHeader
} from './rest-auth.js'
import { mintWebSession, WEB_SESSION_COOKIE_NAME } from './web-sessions.js'

const EMAIL = 'rest-client@example.com'

/** A non-loopback peer — what an internet client's socket reports. */
const WAN = '203.0.113.7'

/** `restAuthAction` for an ENFORCING hub, reached from the public internet. */
function remoteWan(url: string): string {
  return restAuthAction({ hubAuthRequired: true, url })
}

interface GateHarness {
  get(
    path: string,
    opts?: { authorization?: string; cookie?: string; method?: string; origin?: string }
  ): Promise<{ status: number; body: string; reached: boolean }>
  /** The audit context the inner handler last ran with (T-03). */
  seenContext(): SecurityContext | undefined
  /** The REST principal the inner handler last saw bound to its request (T-16). */
  seenPrincipal(): RestPrincipal | null
  close(): Promise<void>
}

/** Collect audit lines while `fn` runs. */
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

/**
 * Mount `withRestAuth` on a real ephemeral listener with a trivial inner handler
 * that records whether it ran (200 'inner'). `forceOffBox` rewrites the socket's
 * reported peer address to a WAN one so the verify branch is reachable from a
 * loopback test client — the ONE thing a unit test can't get for free.
 */
async function mountGate(opts: {
  required: boolean
  auth: HubAuth | null
  db?: SlayzoneDb | null
  forceOffBox: boolean
  isCookieOriginAllowed?: (req: import('node:http').IncomingMessage) => boolean
}): Promise<GateHarness> {
  let reached = false
  let seen: SecurityContext | undefined
  let seenPrincipal: RestPrincipal | null = null
  const gated = withRestAuth({
    getHubAuthRequired: () => opts.required,
    getHubAuth: () => opts.auth,
    getDb: () => opts.db ?? null,
    isCookieOriginAllowed: opts.isCookieOriginAllowed,
    next: (req, res) => {
      reached = true
      seen = currentSecurityContext()
      seenPrincipal = restPrincipalOf(req)
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('inner')
    }
  })
  const server: Server = createServer((req, res) => {
    if (opts.forceOffBox) {
      Object.defineProperty(req.socket, 'remoteAddress', { value: WAN, configurable: true })
    }
    gated(req, res)
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const addr = server.address()
  if (!addr || typeof addr === 'string') throw new Error('bad address')
  const base = `http://127.0.0.1:${addr.port}`
  return {
    async get(path, callOpts) {
      reached = false
      const headers: Record<string, string> = {}
      if (callOpts?.authorization) headers.authorization = callOpts.authorization
      if (callOpts?.cookie) headers.cookie = callOpts.cookie
      if (callOpts?.origin) headers.origin = callOpts.origin
      const res = await fetch(`${base}${path}`, {
        method: callOpts?.method ?? 'GET',
        headers: Object.keys(headers).length > 0 ? headers : undefined
      })
      const body = await res.text()
      return { status: res.status, body, reached }
    },
    seenContext: () => seen,
    seenPrincipal: () => seenPrincipal,
    close: () => new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

// ── login NOT required (the default / the desktop app's hub) — must be TOTALLY inert ────────
test('auth OFF: every path allows, even the full-power ones', () => {
  for (const url of [
    '/api/tasks',
    '/api/pty/abc/submit',
    '/api/browser/task-1/eval',
    '/mcp',
    '/api/artifacts/t1/export/pdf'
  ]) {
    expect(restAuthAction({ hubAuthRequired: false, url }), `gate off → allow ${url}`).toBe('allow')
  }
})

// ── auth ON — the guarded surface ─────────────────────────────────────────
test('the whole /api/* CLI surface requires a bearer from the internet', () => {
  for (const url of [
    '/api/tasks',
    '/api/tasks/search?q=x',
    '/api/tasks/abc',
    '/api/notify',
    '/api/projects',
    '/api/artifacts/t1',
    '/api/pty/sess-1/submit',
    '/api/pty/sess-1/write',
    '/api/browser/task-1/eval',
    '/api/automations/a1/run',
    '/api/processes'
  ]) {
    expect(remoteWan(url), `must verify ${url}`).toBe('verify')
  }
})

test('/mcp requires a bearer from the internet (full tool surface)', () => {
  expect(remoteWan('/mcp'), 'POST/GET/DELETE /mcp is guarded').toBe('verify')
})

test('the agent-hook route is guarded from the internet', () => {
  // Local agents post to sidecar loopback; a computer-routed agent posts to the
  // COMPUTER's loopback and the envelope is relayed over the authed ws channel —
  // so NO legitimate caller reaches this route over the WAN.
  expect(remoteWan('/api/agent-hook'), 'agent-hook guarded off-box').toBe('verify')
})

test('the OAuth deep-link route is guarded from the internet', () => {
  // Under /api/auth/ by path, but it is OURS (registerAuthDeepLinkRoute), not
  // better-auth's — an off-box caller must not be able to inject a callback
  // code into the authEvents bus.
  expect(remoteWan('/api/auth/deep-link'), 'deep-link is not a bootstrap route').toBe('verify')
})

// ── auth ON — the exemptions, and WHY each one must exist ─────────────────
test('better-auth own routes stay open (else no token can ever be obtained)', () => {
  for (const url of ['/api/auth/sign-in/email', '/api/auth/get-session', '/api/auth/sign-out']) {
    expect(remoteWan(url), `bootstrap route open: ${url}`).toBe('allow')
  }
})

test("web-login stays open too — OURS, not better-auth's, same bootstrap need", () => {
  expect(remoteWan('/api/auth/web-login'), 'web-login exempt').toBe('allow')
  // Prefix-confusion around it, same rigor as the other exact entries.
  expect(remoteWan('/api/auth/web-login/extra'), 'nested path is not exempt').toBe('verify')
  expect(remoteWan('/api/auth/web-login?x=1'), 'query string does not defeat the match').toBe(
    'allow'
  )
})

test('the web shell session routes (T-13) are open; web-sso only with SSO on', () => {
  for (const url of ['/api/auth/web-session', '/api/auth/web-logout']) {
    expect(remoteWan(url), `${url} open (acts on its own cookie, Origin-checked)`).toBe('allow')
    expect(
      restAuthAction({ hubAuthRequired: true, passwordEnabled: false, url }),
      `${url} open with password off too`
    ).toBe('allow')
    expect(remoteWan(`${url}/extra`), `${url}/extra is not exempt`).toBe('verify')
  }
  expect(remoteWan('/api/auth/web-sso'), 'SSO off: web-sso gated').toBe('verify')
  expect(
    restAuthAction({ hubAuthRequired: true, ssoActive: true, url: '/api/auth/web-sso?return=1' }),
    'SSO on: web-sso open'
  ).toBe('allow')
})

/**
 * The exemption is an EXACT ALLOWLIST, not the `/api/auth/` prefix it used to be.
 *
 * A prefix exemption is fail-OPEN by construction: every route better-auth or
 * any of its plugins mounts under it — present and future — was reachable with
 * no bearer. That is not theoretical. The `apiKey()` plugin mounts
 * `/api/auth/api-key/create`, which accepts a session plus arbitrary metadata
 * and was the computer-impersonation escalation (regression-tested in
 * hub-auth.test.ts). The `organization()` and `jwt()` plugins mount member,
 * invite, token and JWKS routes that nothing in SlayZone reads.
 *
 * `sign-up/email` is deliberately NOT on the list either. `disableSignUp`
 * already refuses it at the source, so exempting it bought nothing and only
 * turned a 401 into a 400 for an anonymous caller.
 */
test('every OTHER /api/auth route is gated (allowlist, not prefix)', () => {
  for (const url of [
    '/api/auth/api-key/create',
    '/api/auth/api-key/list',
    '/api/auth/sign-up/email',
    '/api/auth/organization/create',
    '/api/auth/token',
    '/api/auth/jwks',
    // Ours, not better-auth's — must never let an off-box caller inject an
    // OAuth callback code into the authEvents bus.
    '/api/auth/deep-link',
    // Prefix-confusion around the allowlisted entries.
    '/api/auth/sign-in/email/extra',
    '/api/auth/get-session-x',
    '/api/auth'
  ]) {
    expect(remoteWan(url), `non-bootstrap /api/auth route gated: ${url}`).toBe('verify')
  }
})

// Entra sign-in (T-09): exactly two routes open, and only on a hub with SSO on.
test('Entra sign-in: start + callback open only when SSO is on, by exact path', () => {
  const sso = (url: string): RestAuthAction =>
    restAuthAction({ hubAuthRequired: true, ssoActive: true, url })
  for (const url of ['/api/auth/sign-in/social', '/api/auth/callback/microsoft']) {
    expect(remoteWan(url), `SSO off: ${url} stays gated`).toBe('verify')
    expect(sso(url), `SSO on: ${url} open`).toBe('allow')
    expect(sso(`${url}?code=x&state=y`), `SSO on: query ignored on ${url}`).toBe('allow')
  }
  for (const url of [
    // Another provider's callback, and prefix confusion around the open ones.
    '/api/auth/callback/google',
    '/api/auth/callback/microsoft/extra',
    '/api/auth/callback',
    '/api/auth/sign-in/social/extra',
    // better-auth's other OAuth routes need a session or are unused.
    '/api/auth/link-social',
    '/api/auth/refresh-token',
    '/api/auth/get-access-token',
    '/api/auth/account-info',
    '/api/auth/error',
    '/api/auth/api-key/create'
  ]) {
    expect(sso(url), `SSO on: ${url} stays gated`).toBe('verify')
  }
  expect(
    restAuthAction({ hubAuthRequired: false, ssoActive: true, url: '/api/tasks' }),
    'login off: SSO changes nothing'
  ).toBe('allow')
})

// Device sign-in (T-14): the code + token routes open on an SSO hub only; the plugin's
// browser-leg routes stay behind the bearer (and 404 there — hub-auth device.test.ts).
test('device sign-in: code + token open only when SSO is on, by exact path', () => {
  const sso = (url: string): RestAuthAction =>
    restAuthAction({ hubAuthRequired: true, ssoActive: true, url })
  for (const url of ['/api/auth/device/code', '/api/auth/device/token']) {
    expect(remoteWan(url), `SSO off: ${url} stays gated`).toBe('verify')
    expect(sso(url), `SSO on: ${url} open`).toBe('allow')
  }
  for (const url of [
    '/api/auth/device',
    '/api/auth/device/approve',
    '/api/auth/device/deny',
    '/api/auth/device/code/extra',
    '/api/auth/device/tokens'
  ]) {
    expect(sso(url), `SSO on: ${url} stays gated`).toBe('verify')
  }
  // The approval page is outside /api, like the web shell: the gate never sees it.
  expect(sso('/device?user_code=ABCDEFGH'), 'page not gated').toBe('allow')
})

test('computer join-token stays open (its own loopback guard is the protection)', () => {
  // The Electron MAIN process mints over loopback with no bearer at boot; a
  // bearer requirement here would break local-computer auto-enroll on a remote
  // hub. The route itself 403s a non-loopback peer.
  expect(remoteWan('/api/computers/join-token'), 'join-token exempt').toBe('allow')
})

test('hub user management stays open (its own loopback guard is the protection)', () => {
  // `slay hub users …` runs on the hub box and holds no session — a
  // bearer requirement would make it impossible to create the FIRST account on a
  // remote hub, which is the whole reason the route exists. Its own 403 for a
  // non-loopback peer is strictly tighter than a bearer.
  expect(remoteWan('/api/hub/users'), 'hub users exempt').toBe('allow')
  // Exact-path, not prefix: a nested path must NOT inherit the exemption.
  expect(remoteWan('/api/hub/users/extra'), 'nested path is not exempt').toBe('verify')
  expect(remoteWan('/api/hub/users?x=1'), 'query string does not defeat the match').toBe('allow')
})

// NO loopback exemption. The gate used to wave through a loopback peer on a
// supervised hub, but that branch was unreachable (a supervised hub has login off,
// so it returned 'allow' before getting there) — and a peer-address pass is wrong
// exactly where login matters: a same-box reverse proxy makes every off-box
// request arrive from 127.0.0.1. A caller on this machine presents a bearer.
test('there is no loopback exemption: the decision depends only on the hub and the url', () => {
  // restAuthAction takes no peer address at all, so none can influence it.
  expect(
    restAuthAction({ hubAuthRequired: true, url: '/api/tasks' }),
    'a login-required hub verifies a guarded route whoever is calling'
  ).toBe('verify')
  expect(
    restAuthAction({ hubAuthRequired: false, url: '/api/tasks' }),
    'a login-off hub never verifies'
  ).toBe('allow')
})

test('non-API paths are not gated (/health is pre-express; unknown 404s anyway)', () => {
  expect(remoteWan('/health'), '/health ungated').toBe('allow')
  expect(remoteWan('/'), 'root ungated').toBe('allow')
  expect(remoteWan('/trpc'), 'ws upgrade path never reaches the gate').toBe('allow')
})

test('a path-traversal-ish or prefix-confusable url cannot dodge the gate', () => {
  // `/api/authx` is NOT under the bootstrap prefix; `/mcp-foo` is not `/mcp`.
  expect(remoteWan('/api/authx/steal'), '/api/authx is guarded').toBe('verify')
  expect(remoteWan('/api/auth'), 'bare /api/auth (no slash) is guarded').toBe('verify')
  expect(remoteWan('/api/computers/join-token/../tasks'), 'not the exact join path').toBe('verify')
  expect(remoteWan('/mcp-not-really'), 'unrelated path stays ungated (404s)').toBe('allow')
})

test('the query string never changes the decision', () => {
  expect(remoteWan('/api/tasks?limit=10'), 'query ignored on a guarded path').toBe('verify')
  expect(remoteWan('/api/auth/sign-in/email?x=1'), 'query ignored on an exempt path').toBe('allow')
})

test('a missing url fails closed', () => {
  expect(restAuthAction({ hubAuthRequired: true, url: undefined }), 'undefined url → verify').toBe(
    'verify'
  )
})

// ── verifyRestBearer against a REAL better-auth session ───────────────────
const tmpDir = mkdtempSync(join(tmpdir(), 'hub-rest-auth-'))
// One path for createHubAuth and the direct flag flips below: two literals drifted
// apart once (the auth DB rename) and the flips silently hit an empty new file.
const authDbPath = join(tmpDir, 'slayzone.auth.sqlite')
const auth: HubAuth = await createHubAuth({
  dbPath: authDbPath,
  baseURL: 'http://127.0.0.1:9999',
  secret: 'hub-rest-auth-test-secret-at-least-32-chars-long'
})
// A real SlayzoneDb (migrated) for the szw_ web-session path — verifyRestBearer
// now resolves TWO credential classes, and this is the one that isn't better-auth.
const harness = await createTestHarness()
const db: SlayzoneDb = harness.slayDb

/** `verifyRestBearer` now returns a principal, not a boolean. This mirrors the
 *  OLD `true`/`false` shape for the tests below that only ever cared "is this
 *  a valid FULL session" — i.e. everything before the szw_ tests further down. */
async function verifiesAsFull(headers: Parameters<typeof verifyRestBearer>[2]): Promise<boolean> {
  const principal = await verifyRestBearer(auth, db, headers)
  return principal !== null && principal.scopes.includes('full')
}

afterAll(async () => {
  await harness.cleanup()
  rmSync(tmpDir, { recursive: true, force: true })
})

// Public signup is closed (`disableSignUp`), so the fixture account comes from
// createHubUser, which generates the password and returns it once.
const created = await createHubUser(auth, { email: EMAIL, name: 'Client' })
assert(!('error' in created), 'created the fixture account')
const signIn = await auth.api.signInEmail({
  body: { email: EMAIL, password: created.password }
})
const validToken = signIn.token
expect(typeof validToken, 'got a real session token').toBe('string')
expect(validToken.length, 'got a real session token').toBeGreaterThan(0)

test('a real session token in Authorization: Bearer verifies as full', async () => {
  expect(
    await verifiesAsFull({ authorization: `Bearer ${validToken}` }),
    'valid bearer → full'
  ).toBe(true)
})

test('the scheme is case-insensitive (bearer / BEARER)', async () => {
  expect(await verifiesAsFull({ authorization: `bearer ${validToken}` }), 'lc').toBe(true)
  expect(await verifiesAsFull({ authorization: `BEARER ${validToken}` }), 'uc').toBe(true)
})

test('a bogus / blank / absent / wrong-scheme header does NOT verify', async () => {
  expect(await verifiesAsFull({ authorization: 'Bearer nope' }), 'bogus').toBe(false)
  expect(await verifiesAsFull({ authorization: 'Bearer ' }), 'blank token').toBe(false)
  expect(await verifiesAsFull({ authorization: '' }), 'empty header').toBe(false)
  expect(await verifiesAsFull({}), 'absent header').toBe(false)
  expect(await verifiesAsFull({ authorization: `Basic ${validToken}` }), 'wrong scheme').toBe(false)
  expect(await verifiesAsFull({ authorization: validToken }), 'raw token without a scheme').toBe(
    false
  )
})

test('a duplicated Authorization header (string[]) does NOT verify', async () => {
  // node collapses most dup headers, but authorization can arrive as an array;
  // an ambiguous request must fail closed rather than pick one.
  expect(
    await verifiesAsFull({
      authorization: [`Bearer ${validToken}`, 'Bearer other'] as unknown as string
    }),
    'array header → false'
  ).toBe(false)
})

test('a null hubAuth does NOT verify (fail-closed, no crash)', async () => {
  const principal = await verifyRestBearer(null, db, { authorization: `Bearer ${validToken}` })
  expect(principal, 'no auth instance → null').toBe(null)
})

test('end-to-end: WAN request to /api/tasks → verify → real token admits it', async () => {
  const action = remoteWan('/api/tasks')
  expect(action, 'gate demands verification').toBe('verify')
  expect(
    await verifiesAsFull({ authorization: `Bearer ${validToken}` }),
    'the CLI bearer (SLAYZONE_HUB_TOKEN / cli-hub-target.json) is now honoured'
  ).toBe(true)
  expect(
    await verifiesAsFull({ authorization: 'Bearer forged' }),
    'a forged bearer is rejected → 401'
  ).toBe(false)
})

// ── the szw_ scoped-session path — bearer AND cookie ──────────────────────
const scopedSession = await mintWebSession(db, {
  userId: created.id,
  scopes: ['read', 'tasks']
})

test('a szw_ bearer resolves to its OWN scopes, never full', async () => {
  const principal = await verifyRestBearer(auth, db, {
    authorization: `Bearer ${scopedSession.token}`
  })
  expect(principal, 'scoped session resolves').not.toBe(null)
  expect(principal!.scopes.join(','), 'carries its minted scopes').toBe('read,tasks')
  expect(principal!.scopes, 'never full').not.toContain('full')
})

test('a szw_ token in the COOKIE also resolves (bearer absent)', async () => {
  const principal = await verifyRestBearer(
    auth,
    db,
    {},
    { [WEB_SESSION_COOKIE_NAME]: scopedSession.token }
  )
  expect(principal, 'cookie-carried scoped session resolves').not.toBe(null)
  expect(principal!.scopes.join(','), 'same scopes via cookie').toBe('read,tasks')
})

test('a szw_ token is checked BEFORE the better-auth path — never mistried', async () => {
  // If a szw_ token were passed to verifySession instead, it would just fail
  // (401) rather than resolve to its real scopes — this proves the PREFIX
  // branch, not a fallback, is what resolves it.
  const principal = await verifyRestBearer(auth, db, {
    authorization: `Bearer ${scopedSession.token}`
  })
  expect(principal, 'must resolve via the web-session branch, not fail through').not.toBe(null)
})

test('a real better-auth bearer in the COOKIE does NOT verify (cookie-blind for full)', async () => {
  // The one asymmetry the design requires: cookies are only ever consulted
  // for the scope-limited credential class, never for a full session — a
  // forged cross-site request carrying an ambient cookie must never be able
  // to reach `full`.
  const principal = await verifyRestBearer(auth, db, {}, { [WEB_SESSION_COOKIE_NAME]: validToken })
  expect(principal, 'a non-szw_ value in the cookie slot resolves to nothing').toBe(null)
})

test('an unknown / expired / revoked szw_ token resolves to null, never throws', async () => {
  expect(
    await verifyRestBearer(auth, db, { authorization: 'Bearer szw_nonexistent' }),
    'unknown szw_ token'
  ).toBe(null)
})

test('parseCookieHeader parses name=value pairs, ignores malformed entries', () => {
  const parsed = parseCookieHeader({
    cookie: `${WEB_SESSION_COOKIE_NAME}=abc123; other=xyz; malformed; =blank-name`
  })
  expect(parsed[WEB_SESSION_COOKIE_NAME], 'session cookie parsed').toBe('abc123')
  expect(parsed.other, 'sibling cookie parsed').toBe('xyz')
  expect(Object.keys(parsed).length, 'malformed/blank-name entries dropped').toBe(2)
  expect(Object.keys(parseCookieHeader({})).length, 'no Cookie header → empty map').toBe(0)
})

// ── account role + disabled account (T-08) ──────────────────────────────
const second = await createHubUser(auth, { email: 'second@example.com' })
assert(!('error' in second), 'created a second account')
const secondFull = await auth.api.signInEmail({
  body: { email: 'second@example.com', password: second.password }
})
const secondWeb = await mintWebSession(db, { userId: second.id, scopes: ['read'] })
const principalOf = (token: string) =>
  verifyRestBearer(auth, db, { authorization: `Bearer ${token}` })
/** Flag the account directly, leaving its sessions in place (the "exists anyway" case). */
const setDisabled = (userId: string, disabled: boolean): void => {
  const authDb = new DatabaseSync(authDbPath)
  authDb
    .prepare('UPDATE user SET disabledAt = ? WHERE id = ?')
    .run(disabled ? new Date().toISOString() : null, userId)
  authDb.close()
}

test('the REST principal carries the account role, for both credential classes', async () => {
  expect((await principalOf(validToken))?.role, 'first account, full').toBe('admin')
  expect((await principalOf(scopedSession.token))?.role, 'first account, szw_').toBe('admin')
  expect((await principalOf(secondFull.token))?.role, 'second account, full').toBe('user')
  expect((await principalOf(secondWeb.token))?.role, 'second account, szw_').toBe('user')
})

test('a disabled account: its existing full and web sessions do not verify', async () => {
  setDisabled(second.id, true)
  try {
    expect(await principalOf(secondFull.token), 'full session refused').toBe(null)
    expect(await principalOf(secondWeb.token), 'szw_ bearer refused').toBe(null)
    expect(
      await verifyRestBearer(auth, db, {}, { [WEB_SESSION_COOKIE_NAME]: secondWeb.token }),
      'szw_ cookie refused'
    ).toBe(null)
    const h = await mountGate({ required: true, auth, forceOffBox: true })
    try {
      const res = await h.get('/api/tasks', { authorization: `Bearer ${secondFull.token}` })
      expect(res.status, 'the gate answers 401').toBe(401)
      expect(res.reached, 'the inner handler never ran').toBe(false)
    } finally {
      await h.close()
    }
  } finally {
    setDisabled(second.id, false)
  }
  expect((await principalOf(secondFull.token))?.userId, 'verifies once enabled').toEqual(second.id)
})

// ── withRestAuth over a REAL listener ───────────────────────────────────
// Drives the actual wiring server.ts mounts. Requests here come from
// 127.0.0.1, so `hubAuthRequired` alone would never demand a bearer — the
// harness forces the off-box branch via `remoteOverride` to exercise the
// verify path that a WAN client would hit.
test('withRestAuth: 401 (no body leak) without a bearer, 200 with a real one', async () => {
  const h = await mountGate({ required: true, auth, forceOffBox: true })
  try {
    const anon = await h.get('/api/tasks')
    expect(anon.status, 'no bearer → 401').toBe(401)
    expect(anon.reached, 'the inner handler never ran').toBe(false)
    expect(anon.body, 'json error body').toContain('Unauthorized')

    const forged = await h.get('/api/tasks', { authorization: 'Bearer forged' })
    expect(forged.status, 'forged bearer → 401').toBe(401)
    expect(forged.reached, 'the inner handler never ran').toBe(false)

    const good = await h.get('/api/tasks', { authorization: `Bearer ${validToken}` })
    expect(good.status, 'valid bearer → 200').toBe(200)
    expect(good.reached, 'the inner handler ran').toBe(true)
  } finally {
    await h.close()
  }
})

test('withRestAuth: binds the verified principal to the request (who creates a project, T-16)', async () => {
  const h = await mountGate({ required: true, auth, forceOffBox: true })
  try {
    const good = await h.get('/api/projects', { authorization: `Bearer ${validToken}` })
    expect(good.status, 'valid bearer → 200').toBe(200)
    expect(h.seenPrincipal()?.userId, 'the handler sees the signed-in user').toEqual(created.id)
    expect(h.seenPrincipal()?.scopes.includes('full'), 'full principal').toBe(true)
    // An open path is admitted without verifying anyone: nothing bound.
    const open = await h.get('/api/auth/sign-in/email')
    expect(open.reached, 'open path reached').toBe(true)
    expect(h.seenPrincipal(), 'no principal on an unverified request').toBe(null)
  } finally {
    await h.close()
  }
  const off = await mountGate({ required: false, auth, forceOffBox: true })
  try {
    const res = await off.get('/api/projects', { authorization: `Bearer ${validToken}` })
    expect(res.reached, 'login off → through').toBe(true)
    expect(off.seenPrincipal(), 'login off: no user on the request, even with a bearer').toBe(null)
  } finally {
    await off.close()
  }
})

test('withRestAuth: exempt + ungated paths pass through with no bearer', async () => {
  const h = await mountGate({ required: true, auth, forceOffBox: true })
  try {
    for (const path of [
      '/api/auth/sign-in/email',
      '/api/auth/web-login',
      '/api/computers/join-token',
      '/whatever'
    ]) {
      const res = await h.get(path)
      expect(res.status, `${path} passes through`).toBe(200)
      expect(res.reached, `${path} reached the inner handler`).toBe(true)
    }
  } finally {
    await h.close()
  }
})

test('withRestAuth: auth OFF passes everything through, unauthenticated', async () => {
  const h = await mountGate({ required: false, auth, forceOffBox: true })
  try {
    const res = await h.get('/api/browser/task-1/eval')
    expect(res.status, 'gate off → through').toBe(200)
    expect(res.reached, 'inner handler ran with no bearer').toBe(true)
  } finally {
    await h.close()
  }
})

test('withRestAuth: a real loopback peer must authenticate on a login-required hub', async () => {
  // The peer address is genuinely 127.0.0.1. SLAYZONE_SUPERVISED must not matter:
  // only the login switch (here, `required`) decides.
  const prev = process.env.SLAYZONE_SUPERVISED
  process.env.SLAYZONE_SUPERVISED = '1'
  const h = await mountGate({ required: true, auth, forceOffBox: false })
  try {
    expect((await h.get('/api/tasks')).status, 'no bearer is refused, supervised or not').toBe(401)
    expect(
      (await h.get('/api/tasks', { authorization: `Bearer ${validToken}` })).status,
      'a valid bearer is accepted'
    ).toBe(200)
  } finally {
    await h.close()
    if (prev === undefined) delete process.env.SLAYZONE_SUPERVISED
    else process.env.SLAYZONE_SUPERVISED = prev
  }
})

test('withRestAuth: a null hubAuth 401s a guarded route (fail-closed)', async () => {
  const h = await mountGate({ required: true, auth: null, forceOffBox: true })
  try {
    const res = await h.get('/api/tasks', { authorization: `Bearer ${validToken}` })
    expect(res.status, 'no auth instance → 401, never open').toBe(401)
    expect(res.reached, 'inner handler never ran').toBe(false)
  } finally {
    await h.close()
  }
})

test('withRestAuth: a scoped web session gets 403 on the REST surface, never the inner handler', async () => {
  // Phase 1 gives a scoped session NO REST access at all — the granular
  // per-route scope map that would make a narrower grant safe does not
  // exist for `/api/*` the way SCOPE_POLICY does for `/trpc`. A real,
  // valid, unexpired scoped session must still be refused here — this is
  // NOT the same failure as "no credential" (401), so both are asserted.
  const h = await mountGate({ required: true, auth, db, forceOffBox: true })
  try {
    const viaBearer = await h.get('/api/tasks', {
      authorization: `Bearer ${scopedSession.token}`
    })
    expect(viaBearer.status, 'scoped bearer → 403, not 401 (real credential, wrong class)').toBe(
      403
    )
    expect(viaBearer.reached, 'inner handler never ran for a scoped session').toBe(false)

    const viaCookie = await h.get('/api/tasks', {
      cookie: `${WEB_SESSION_COOKIE_NAME}=${scopedSession.token}`
    })
    expect(viaCookie.status, 'same result via cookie').toBe(403)
    expect(viaCookie.reached, 'inner handler never ran').toBe(false)

    // A full session on the SAME listener still gets through — the denial
    // is about the principal's scope class, not a config toggle.
    const viaFull = await h.get('/api/tasks', { authorization: `Bearer ${validToken}` })
    expect(viaFull.status, 'a full session is unaffected').toBe(200)
  } finally {
    await h.close()
  }
})

// ── CSRF (T-13): a cookie authenticates a state-changing request only from the hub page
test('withRestAuth: a state-changing request by cookie needs the hub page Origin', async () => {
  const cookie = `${WEB_SESSION_COOKIE_NAME}=${scopedSession.token}`
  const HUB = 'https://hub.example.com'
  const allowed = (req: import('node:http').IncomingMessage): boolean => req.headers.origin === HUB
  const h = await mountGate({
    required: true,
    auth,
    db,
    forceOffBox: true,
    isCookieOriginAllowed: allowed
  })
  const bare = await mountGate({ required: true, auth, db, forceOffBox: true })
  try {
    const lines = await captureAudit(async () => {
      for (const origin of [undefined, 'https://evil.example', 'null']) {
        const res = await h.get('/api/tasks', { method: 'POST', cookie, origin })
        expect(res.status, `POST by cookie, Origin ${origin} → 403`).toBe(403)
        expect(res.reached, 'inner handler never ran').toBe(false)
      }
      // Without the option nothing is ever the hub page: refused too (fail closed).
      const unwired = await bare.get('/api/tasks', { method: 'DELETE', cookie, origin: HUB })
      expect(unwired.status, 'no origin check wired → refused').toBe(403)
    })
    const reasons = lines.map((l) => (l.detail as { reason?: string }).reason)
    expect(reasons.join(','), 'each refused as origin').toBe('origin,origin,origin,origin')

    // From the hub page the request reaches the credential check (a scoped session
    // is then refused REST as before — not by origin).
    const fromHub = await captureAudit(async () => {
      const res = await h.get('/api/tasks', { method: 'POST', cookie, origin: HUB })
      expect(res.status, 'scoped session → 403 as before').toBe(403)
    })
    expect(
      (fromHub[0]?.detail as { reason?: string } | undefined)?.reason,
      'past the Origin check'
    ).toBe('scoped_session')
    // A safe method by cookie needs no Origin (a same-origin GET sends none).
    const get = await captureAudit(async () => {
      await h.get('/api/tasks', { cookie })
    })
    expect((get[0]?.detail as { reason?: string } | undefined)?.reason, 'GET: no origin rule').toBe(
      'scoped_session'
    )
    // A szw_ BEARER is not ambient: no Origin needed.
    const bearer = await captureAudit(async () => {
      await h.get('/api/tasks', {
        method: 'POST',
        authorization: `Bearer ${scopedSession.token}`,
        cookie
      })
    })
    expect(
      (bearer[0]?.detail as { reason?: string } | undefined)?.reason,
      'bearer: no origin rule'
    ).toBe('scoped_session')
    // A full bearer with no cookie is untouched by the rule.
    const full = await h.get('/api/tasks', {
      method: 'POST',
      authorization: `Bearer ${validToken}`
    })
    expect(full.status, 'full bearer POST, no Origin → admitted').toBe(200)
  } finally {
    await h.close()
    await bare.close()
  }
})

// ── audit (T-03) ─────────────────────────────────────────────────────────
test('audit: each refusal writes one authz.denied line naming why', async () => {
  const h = await mountGate({ required: true, auth, db, forceOffBox: true })
  try {
    const lines = await captureAudit(async () => {
      await h.get('/api/tasks?q=secret')
      await h.get('/api/tasks', { authorization: 'Bearer forged' })
      await h.get('/api/tasks', { authorization: `Bearer ${scopedSession.token}` })
    })
    expect(lines.length, 'one line per refusal').toBe(3)
    const [none, invalid, scoped] = lines
    for (const l of lines) {
      expect(l.event, 'event').toBe('authz.denied')
      expect(l.outcome, 'outcome').toBe('denied')
      expect(l.ip, 'peer address').toEqual(WAN)
      expect(l.route, 'route without the query string').toBe('GET /api/tasks')
    }
    expect((none!.detail as { reason: string }).reason, 'no credential').toBe('no_credential')
    expect(none!.actor, 'no actor without a credential').toBe(null)
    expect((invalid!.detail as { reason: string }).reason, 'forged').toBe('invalid_credential')
    expect((scoped!.detail as { reason: string }).reason, 'scoped').toBe('scoped_session')
    expect(scoped!.actor, 'a scoped refusal names the user').toEqual(created.id)
    for (const l of lines) {
      expect(JSON.stringify(l), 'no token in a line').not.toContain(scopedSession.token)
      expect(JSON.stringify(l), 'no presented bearer in a line').not.toContain('forged')
    }
  } finally {
    await h.close()
  }
})

test('audit: an admitted request writes nothing and runs as its user', async () => {
  const h = await mountGate({ required: true, auth, db, forceOffBox: true })
  try {
    const lines = await captureAudit(async () => {
      const res = await h.get('/api/tasks', { authorization: `Bearer ${validToken}` })
      expect(res.status, 'admitted').toBe(200)
    })
    expect(lines.length, 'no line for an admitted request').toBe(0)
    const seen = h.seenContext()
    expect(seen?.actor, 'acting user is the bearer owner').toEqual(created.id)
    expect(seen?.ip, 'peer address').toEqual(WAN)
    expect(seen?.route, 'route').toBe('GET /api/tasks')

    await h.get('/api/auth/sign-in/email')
    expect(h.seenContext()?.actor, 'an exempt route runs with no actor').toBe(null)
    expect(h.seenContext()?.ip, 'but with the peer address').toEqual(WAN)
  } finally {
    await h.close()
  }
})
