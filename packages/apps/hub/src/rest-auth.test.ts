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
 * mints a genuine token via signInEmail. Native ABI → Electron strict loader,
 * hand-rolled harness (no vitest import), same as hub-trpc-context.test.ts.
 *
 * Run with:
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron --import tsx/esm \
 *     --experimental-loader ./packages/shared/test-utils/loader.ts \
 *     packages/apps/hub/src/rest-auth.test.ts
 */
import { createServer, type Server } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { SlayzoneDb } from '@slayzone/platform'
import {
  currentSecurityContext,
  setSecurityLogSink,
  type SecurityContext
} from '@slayzone/platform/security-log'
import { createHubAuth, createHubUser, type HubAuth } from '@slayzone/hub-auth/server'
import { restPrincipalOf, type RestPrincipal } from '@slayzone/transport/server'
import { createTestHarness } from '../../../shared/test-utils/ipc-harness.js'
import {
  type RestAuthAction,
  restAuthAction,
  verifyRestBearer,
  withRestAuth,
  parseCookieHeader
} from './rest-auth.js'
import { mintWebSession, WEB_SESSION_COOKIE_NAME } from './web-sessions.js'

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
    opts?: { authorization?: string; cookie?: string }
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
}): Promise<GateHarness> {
  let reached = false
  let seen: SecurityContext | undefined
  let seenPrincipal: RestPrincipal | null = null
  const gated = withRestAuth({
    getHubAuthRequired: () => opts.required,
    getHubAuth: () => opts.auth,
    getDb: () => opts.db ?? null,
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
      const res = await fetch(`${base}${path}`, {
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

async function main(): Promise<void> {
  console.log('\nhub REST/MCP bearer gate')
  console.log('─'.repeat(48))

  // ── login NOT required (the default / the desktop app's hub) — must be TOTALLY inert ────────
  await test('auth OFF: every path allows, even the full-power ones', () => {
    for (const url of [
      '/api/tasks',
      '/api/pty/abc/submit',
      '/api/browser/task-1/eval',
      '/mcp',
      '/api/artifacts/t1/export/pdf'
    ]) {
      assertEq(restAuthAction({ hubAuthRequired: false, url }), 'allow', `gate off → allow ${url}`)
    }
  })

  // ── auth ON — the guarded surface ─────────────────────────────────────────
  await test('the whole /api/* CLI surface requires a bearer from the internet', () => {
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
      assertEq(remoteWan(url), 'verify', `must verify ${url}`)
    }
  })

  await test('/mcp requires a bearer from the internet (full tool surface)', () => {
    assertEq(remoteWan('/mcp'), 'verify', 'POST/GET/DELETE /mcp is guarded')
  })

  await test('the agent-hook route is guarded from the internet', () => {
    // Local agents post to sidecar loopback; a computer-routed agent posts to the
    // COMPUTER's loopback and the envelope is relayed over the authed ws channel —
    // so NO legitimate caller reaches this route over the WAN.
    assertEq(remoteWan('/api/agent-hook'), 'verify', 'agent-hook guarded off-box')
  })

  await test('the OAuth deep-link route is guarded from the internet', () => {
    // Under /api/auth/ by path, but it is OURS (registerAuthDeepLinkRoute), not
    // better-auth's — an off-box caller must not be able to inject a callback
    // code into the authEvents bus.
    assertEq(remoteWan('/api/auth/deep-link'), 'verify', 'deep-link is not a bootstrap route')
  })

  // ── auth ON — the exemptions, and WHY each one must exist ─────────────────
  await test('better-auth own routes stay open (else no token can ever be obtained)', () => {
    for (const url of ['/api/auth/sign-in/email', '/api/auth/get-session', '/api/auth/sign-out']) {
      assertEq(remoteWan(url), 'allow', `bootstrap route open: ${url}`)
    }
  })

  await test("web-login stays open too — OURS, not better-auth's, same bootstrap need", () => {
    assertEq(remoteWan('/api/auth/web-login'), 'allow', 'web-login exempt')
    // Prefix-confusion around it, same rigor as the other exact entries.
    assertEq(remoteWan('/api/auth/web-login/extra'), 'verify', 'nested path is not exempt')
    assertEq(
      remoteWan('/api/auth/web-login?x=1'),
      'allow',
      'query string does not defeat the match'
    )
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
  await test('every OTHER /api/auth route is gated (allowlist, not prefix)', () => {
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
      assertEq(remoteWan(url), 'verify', `non-bootstrap /api/auth route gated: ${url}`)
    }
  })

  // Entra sign-in (T-09): exactly two routes open, and only on a hub with SSO on.
  await test('Entra sign-in: start + callback open only when SSO is on, by exact path', () => {
    const sso = (url: string): RestAuthAction =>
      restAuthAction({ hubAuthRequired: true, ssoActive: true, url })
    for (const url of ['/api/auth/sign-in/social', '/api/auth/callback/microsoft']) {
      assertEq(remoteWan(url), 'verify', `SSO off: ${url} stays gated`)
      assertEq(sso(url), 'allow', `SSO on: ${url} open`)
      assertEq(sso(`${url}?code=x&state=y`), 'allow', `SSO on: query ignored on ${url}`)
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
      assertEq(sso(url), 'verify', `SSO on: ${url} stays gated`)
    }
    assertEq(
      restAuthAction({ hubAuthRequired: false, ssoActive: true, url: '/api/tasks' }),
      'allow',
      'login off: SSO changes nothing'
    )
  })

  await test('computer join-token stays open (its own loopback guard is the protection)', () => {
    // The Electron MAIN process mints over loopback with no bearer at boot; a
    // bearer requirement here would break local-computer auto-enroll on a remote
    // hub. The route itself 403s a non-loopback peer.
    assertEq(remoteWan('/api/computers/join-token'), 'allow', 'join-token exempt')
  })

  await test('hub user management stays open (its own loopback guard is the protection)', () => {
    // `slay hub users …` runs on the hub box and holds no session — a
    // bearer requirement would make it impossible to create the FIRST account on a
    // remote hub, which is the whole reason the route exists. Its own 403 for a
    // non-loopback peer is strictly tighter than a bearer.
    assertEq(remoteWan('/api/hub/users'), 'allow', 'hub users exempt')
    // Exact-path, not prefix: a nested path must NOT inherit the exemption.
    assertEq(remoteWan('/api/hub/users/extra'), 'verify', 'nested path is not exempt')
    assertEq(remoteWan('/api/hub/users?x=1'), 'allow', 'query string does not defeat the match')
  })

  // NO loopback exemption. The gate used to wave through a loopback peer on a
  // supervised hub, but that branch was unreachable (a supervised hub has login off,
  // so it returned 'allow' before getting there) — and a peer-address pass is wrong
  // exactly where login matters: a same-box reverse proxy makes every off-box
  // request arrive from 127.0.0.1. A caller on this machine presents a bearer.
  await test('there is no loopback exemption: the decision depends only on the hub and the url', () => {
    // restAuthAction takes no peer address at all, so none can influence it.
    assertEq(
      restAuthAction({ hubAuthRequired: true, url: '/api/tasks' }),
      'verify',
      'a login-required hub verifies a guarded route whoever is calling'
    )
    assertEq(
      restAuthAction({ hubAuthRequired: false, url: '/api/tasks' }),
      'allow',
      'a login-off hub never verifies'
    )
  })

  await test('non-API paths are not gated (/health is pre-express; unknown 404s anyway)', () => {
    assertEq(remoteWan('/health'), 'allow', '/health ungated')
    assertEq(remoteWan('/'), 'allow', 'root ungated')
    assertEq(remoteWan('/trpc'), 'allow', 'ws upgrade path never reaches the gate')
  })

  await test('a path-traversal-ish or prefix-confusable url cannot dodge the gate', () => {
    // `/api/authx` is NOT under the bootstrap prefix; `/mcp-foo` is not `/mcp`.
    assertEq(remoteWan('/api/authx/steal'), 'verify', '/api/authx is guarded')
    assertEq(remoteWan('/api/auth'), 'verify', 'bare /api/auth (no slash) is guarded')
    assertEq(remoteWan('/api/computers/join-token/../tasks'), 'verify', 'not the exact join path')
    assertEq(remoteWan('/mcp-not-really'), 'allow', 'unrelated path stays ungated (404s)')
  })

  await test('the query string never changes the decision', () => {
    assertEq(remoteWan('/api/tasks?limit=10'), 'verify', 'query ignored on a guarded path')
    assertEq(remoteWan('/api/auth/sign-in/email?x=1'), 'allow', 'query ignored on an exempt path')
  })

  await test('a missing url fails closed', () => {
    assertEq(
      restAuthAction({ hubAuthRequired: true, url: undefined }),
      'verify',
      'undefined url → verify'
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

  try {
    // Public signup is closed (`disableSignUp`), so the fixture account comes from
    // createHubUser, which generates the password and returns it once.
    const created = await createHubUser(auth, { email: EMAIL, name: 'Client' })
    assert(!('error' in created), 'created the fixture account')
    const signIn = await auth.api.signInEmail({
      body: { email: EMAIL, password: created.password }
    })
    const validToken = signIn.token
    assert(typeof validToken === 'string' && validToken.length > 0, 'got a real session token')

    await test('a real session token in Authorization: Bearer verifies as full', async () => {
      assertEq(
        await verifiesAsFull({ authorization: `Bearer ${validToken}` }),
        true,
        'valid bearer → full'
      )
    })

    await test('the scheme is case-insensitive (bearer / BEARER)', async () => {
      assertEq(await verifiesAsFull({ authorization: `bearer ${validToken}` }), true, 'lc')
      assertEq(await verifiesAsFull({ authorization: `BEARER ${validToken}` }), true, 'uc')
    })

    await test('a bogus / blank / absent / wrong-scheme header does NOT verify', async () => {
      assertEq(await verifiesAsFull({ authorization: 'Bearer nope' }), false, 'bogus')
      assertEq(await verifiesAsFull({ authorization: 'Bearer ' }), false, 'blank token')
      assertEq(await verifiesAsFull({ authorization: '' }), false, 'empty header')
      assertEq(await verifiesAsFull({}), false, 'absent header')
      assertEq(
        await verifiesAsFull({ authorization: `Basic ${validToken}` }),
        false,
        'wrong scheme'
      )
      assertEq(
        await verifiesAsFull({ authorization: validToken }),
        false,
        'raw token without a scheme'
      )
    })

    await test('a duplicated Authorization header (string[]) does NOT verify', async () => {
      // node collapses most dup headers, but authorization can arrive as an array;
      // an ambiguous request must fail closed rather than pick one.
      assertEq(
        await verifiesAsFull({
          authorization: [`Bearer ${validToken}`, 'Bearer other'] as unknown as string
        }),
        false,
        'array header → false'
      )
    })

    await test('a null hubAuth does NOT verify (fail-closed, no crash)', async () => {
      const principal = await verifyRestBearer(null, db, { authorization: `Bearer ${validToken}` })
      assertEq(principal, null, 'no auth instance → null')
    })

    await test('end-to-end: WAN request to /api/tasks → verify → real token admits it', async () => {
      const action = remoteWan('/api/tasks')
      assertEq(action, 'verify', 'gate demands verification')
      assertEq(
        await verifiesAsFull({ authorization: `Bearer ${validToken}` }),
        true,
        'the CLI bearer (SLAYZONE_HUB_TOKEN / cli-hub-target.json) is now honoured'
      )
      assertEq(
        await verifiesAsFull({ authorization: 'Bearer forged' }),
        false,
        'a forged bearer is rejected → 401'
      )
    })

    // ── the szw_ scoped-session path — bearer AND cookie ──────────────────────
    const scopedSession = await mintWebSession(db, {
      userId: created.id,
      scopes: ['read', 'tasks']
    })

    await test('a szw_ bearer resolves to its OWN scopes, never full', async () => {
      const principal = await verifyRestBearer(auth, db, {
        authorization: `Bearer ${scopedSession.token}`
      })
      assert(principal !== null, 'scoped session resolves')
      assertEq(principal!.scopes.join(','), 'read,tasks', 'carries its minted scopes')
      assert(!principal!.scopes.includes('full'), 'never full')
    })

    await test('a szw_ token in the COOKIE also resolves (bearer absent)', async () => {
      const principal = await verifyRestBearer(
        auth,
        db,
        {},
        { [WEB_SESSION_COOKIE_NAME]: scopedSession.token }
      )
      assert(principal !== null, 'cookie-carried scoped session resolves')
      assertEq(principal!.scopes.join(','), 'read,tasks', 'same scopes via cookie')
    })

    await test('a szw_ token is checked BEFORE the better-auth path — never mistried', async () => {
      // If a szw_ token were passed to verifySession instead, it would just fail
      // (401) rather than resolve to its real scopes — this proves the PREFIX
      // branch, not a fallback, is what resolves it.
      const principal = await verifyRestBearer(auth, db, {
        authorization: `Bearer ${scopedSession.token}`
      })
      assert(principal !== null, 'must resolve via the web-session branch, not fail through')
    })

    await test('a real better-auth bearer in the COOKIE does NOT verify (cookie-blind for full)', async () => {
      // The one asymmetry the design requires: cookies are only ever consulted
      // for the scope-limited credential class, never for a full session — a
      // forged cross-site request carrying an ambient cookie must never be able
      // to reach `full`.
      const principal = await verifyRestBearer(
        auth,
        db,
        {},
        { [WEB_SESSION_COOKIE_NAME]: validToken }
      )
      assertEq(principal, null, 'a non-szw_ value in the cookie slot resolves to nothing')
    })

    await test('an unknown / expired / revoked szw_ token resolves to null, never throws', async () => {
      assertEq(
        await verifyRestBearer(auth, db, { authorization: 'Bearer szw_nonexistent' }),
        null,
        'unknown szw_ token'
      )
    })

    await test('parseCookieHeader parses name=value pairs, ignores malformed entries', () => {
      const parsed = parseCookieHeader({
        cookie: `${WEB_SESSION_COOKIE_NAME}=abc123; other=xyz; malformed; =blank-name`
      })
      assertEq(parsed[WEB_SESSION_COOKIE_NAME], 'abc123', 'session cookie parsed')
      assertEq(parsed.other, 'xyz', 'sibling cookie parsed')
      assertEq(Object.keys(parsed).length, 2, 'malformed/blank-name entries dropped')
      assertEq(Object.keys(parseCookieHeader({})).length, 0, 'no Cookie header → empty map')
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

    await test('the REST principal carries the account role, for both credential classes', async () => {
      assertEq((await principalOf(validToken))?.role, 'admin', 'first account, full')
      assertEq((await principalOf(scopedSession.token))?.role, 'admin', 'first account, szw_')
      assertEq((await principalOf(secondFull.token))?.role, 'user', 'second account, full')
      assertEq((await principalOf(secondWeb.token))?.role, 'user', 'second account, szw_')
    })

    await test('a disabled account: its existing full and web sessions do not verify', async () => {
      setDisabled(second.id, true)
      try {
        assertEq(await principalOf(secondFull.token), null, 'full session refused')
        assertEq(await principalOf(secondWeb.token), null, 'szw_ bearer refused')
        assertEq(
          await verifyRestBearer(auth, db, {}, { [WEB_SESSION_COOKIE_NAME]: secondWeb.token }),
          null,
          'szw_ cookie refused'
        )
        const h = await mountGate({ required: true, auth, forceOffBox: true })
        try {
          const res = await h.get('/api/tasks', { authorization: `Bearer ${secondFull.token}` })
          assertEq(res.status, 401, 'the gate answers 401')
          assertEq(res.reached, false, 'the inner handler never ran')
        } finally {
          await h.close()
        }
      } finally {
        setDisabled(second.id, false)
      }
      assertEq((await principalOf(secondFull.token))?.userId, second.id, 'verifies once enabled')
    })

    // ── withRestAuth over a REAL listener ───────────────────────────────────
    // Drives the actual wiring server.ts mounts. Requests here come from
    // 127.0.0.1, so `hubAuthRequired` alone would never demand a bearer — the
    // harness forces the off-box branch via `remoteOverride` to exercise the
    // verify path that a WAN client would hit.
    await test('withRestAuth: 401 (no body leak) without a bearer, 200 with a real one', async () => {
      const h = await mountGate({ required: true, auth, forceOffBox: true })
      try {
        const anon = await h.get('/api/tasks')
        assertEq(anon.status, 401, 'no bearer → 401')
        assertEq(anon.reached, false, 'the inner handler never ran')
        assert(anon.body.includes('Unauthorized'), 'json error body')

        const forged = await h.get('/api/tasks', { authorization: 'Bearer forged' })
        assertEq(forged.status, 401, 'forged bearer → 401')
        assertEq(forged.reached, false, 'the inner handler never ran')

        const good = await h.get('/api/tasks', { authorization: `Bearer ${validToken}` })
        assertEq(good.status, 200, 'valid bearer → 200')
        assertEq(good.reached, true, 'the inner handler ran')
      } finally {
        await h.close()
      }
    })

    await test('withRestAuth: binds the verified principal to the request (who creates a project, T-16)', async () => {
      const h = await mountGate({ required: true, auth, forceOffBox: true })
      try {
        const good = await h.get('/api/projects', { authorization: `Bearer ${validToken}` })
        assertEq(good.status, 200, 'valid bearer → 200')
        assertEq(h.seenPrincipal()?.userId, created.id, 'the handler sees the signed-in user')
        assertEq(h.seenPrincipal()?.scopes.includes('full'), true, 'full principal')
        // An open path is admitted without verifying anyone: nothing bound.
        const open = await h.get('/api/auth/sign-in/email')
        assertEq(open.reached, true, 'open path reached')
        assertEq(h.seenPrincipal(), null, 'no principal on an unverified request')
      } finally {
        await h.close()
      }
      const off = await mountGate({ required: false, auth, forceOffBox: true })
      try {
        const res = await off.get('/api/projects', { authorization: `Bearer ${validToken}` })
        assertEq(res.reached, true, 'login off → through')
        assertEq(off.seenPrincipal(), null, 'login off: no user on the request, even with a bearer')
      } finally {
        await off.close()
      }
    })

    await test('withRestAuth: exempt + ungated paths pass through with no bearer', async () => {
      const h = await mountGate({ required: true, auth, forceOffBox: true })
      try {
        for (const path of [
          '/api/auth/sign-in/email',
          '/api/auth/web-login',
          '/api/computers/join-token',
          '/whatever'
        ]) {
          const res = await h.get(path)
          assertEq(res.status, 200, `${path} passes through`)
          assertEq(res.reached, true, `${path} reached the inner handler`)
        }
      } finally {
        await h.close()
      }
    })

    await test('withRestAuth: auth OFF passes everything through, unauthenticated', async () => {
      const h = await mountGate({ required: false, auth, forceOffBox: true })
      try {
        const res = await h.get('/api/browser/task-1/eval')
        assertEq(res.status, 200, 'gate off → through')
        assertEq(res.reached, true, 'inner handler ran with no bearer')
      } finally {
        await h.close()
      }
    })

    await test('withRestAuth: a real loopback peer must authenticate on a login-required hub', async () => {
      // The peer address is genuinely 127.0.0.1. SLAYZONE_SUPERVISED must not matter:
      // only the login switch (here, `required`) decides.
      const prev = process.env.SLAYZONE_SUPERVISED
      process.env.SLAYZONE_SUPERVISED = '1'
      const h = await mountGate({ required: true, auth, forceOffBox: false })
      try {
        assertEq((await h.get('/api/tasks')).status, 401, 'no bearer is refused, supervised or not')
        assertEq(
          (await h.get('/api/tasks', { authorization: `Bearer ${validToken}` })).status,
          200,
          'a valid bearer is accepted'
        )
      } finally {
        await h.close()
        if (prev === undefined) delete process.env.SLAYZONE_SUPERVISED
        else process.env.SLAYZONE_SUPERVISED = prev
      }
    })

    await test('withRestAuth: a null hubAuth 401s a guarded route (fail-closed)', async () => {
      const h = await mountGate({ required: true, auth: null, forceOffBox: true })
      try {
        const res = await h.get('/api/tasks', { authorization: `Bearer ${validToken}` })
        assertEq(res.status, 401, 'no auth instance → 401, never open')
        assertEq(res.reached, false, 'inner handler never ran')
      } finally {
        await h.close()
      }
    })

    await test('withRestAuth: a scoped web session gets 403 on the REST surface, never the inner handler', async () => {
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
        assertEq(
          viaBearer.status,
          403,
          'scoped bearer → 403, not 401 (real credential, wrong class)'
        )
        assertEq(viaBearer.reached, false, 'inner handler never ran for a scoped session')

        const viaCookie = await h.get('/api/tasks', {
          cookie: `${WEB_SESSION_COOKIE_NAME}=${scopedSession.token}`
        })
        assertEq(viaCookie.status, 403, 'same result via cookie')
        assertEq(viaCookie.reached, false, 'inner handler never ran')

        // A full session on the SAME listener still gets through — the denial
        // is about the principal's scope class, not a config toggle.
        const viaFull = await h.get('/api/tasks', { authorization: `Bearer ${validToken}` })
        assertEq(viaFull.status, 200, 'a full session is unaffected')
      } finally {
        await h.close()
      }
    })

    // ── audit (T-03) ─────────────────────────────────────────────────────────
    await test('audit: each refusal writes one authz.denied line naming why', async () => {
      const h = await mountGate({ required: true, auth, db, forceOffBox: true })
      try {
        const lines = await captureAudit(async () => {
          await h.get('/api/tasks?q=secret')
          await h.get('/api/tasks', { authorization: 'Bearer forged' })
          await h.get('/api/tasks', { authorization: `Bearer ${scopedSession.token}` })
        })
        assertEq(lines.length, 3, 'one line per refusal')
        const [none, invalid, scoped] = lines
        for (const l of lines) {
          assertEq(l.event, 'authz.denied', 'event')
          assertEq(l.outcome, 'denied', 'outcome')
          assertEq(l.ip, WAN, 'peer address')
          assertEq(l.route, 'GET /api/tasks', 'route without the query string')
        }
        assertEq((none!.detail as { reason: string }).reason, 'no_credential', 'no credential')
        assertEq(none!.actor, null, 'no actor without a credential')
        assertEq((invalid!.detail as { reason: string }).reason, 'invalid_credential', 'forged')
        assertEq((scoped!.detail as { reason: string }).reason, 'scoped_session', 'scoped')
        assertEq(scoped!.actor, created.id, 'a scoped refusal names the user')
        for (const l of lines) {
          assert(!JSON.stringify(l).includes(scopedSession.token), 'no token in a line')
          assert(!JSON.stringify(l).includes('forged'), 'no presented bearer in a line')
        }
      } finally {
        await h.close()
      }
    })

    await test('audit: an admitted request writes nothing and runs as its user', async () => {
      const h = await mountGate({ required: true, auth, db, forceOffBox: true })
      try {
        const lines = await captureAudit(async () => {
          const res = await h.get('/api/tasks', { authorization: `Bearer ${validToken}` })
          assertEq(res.status, 200, 'admitted')
        })
        assertEq(lines.length, 0, 'no line for an admitted request')
        const seen = h.seenContext()
        assertEq(seen?.actor, created.id, 'acting user is the bearer owner')
        assertEq(seen?.ip, WAN, 'peer address')
        assertEq(seen?.route, 'GET /api/tasks', 'route')

        await h.get('/api/auth/sign-in/email')
        assertEq(h.seenContext()?.actor, null, 'an exempt route runs with no actor')
        assertEq(h.seenContext()?.ip, WAN, 'but with the peer address')
      } finally {
        await h.close()
      }
    })
  } finally {
    await harness.cleanup()
    rmSync(tmpDir, { recursive: true, force: true })
  }

  console.log(`\n${passed} passed, ${failed} failed\n`)
  if (failed > 0) process.exit(1)
}

void main()
