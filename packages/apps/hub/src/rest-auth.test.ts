/**
 * Hub REST/MCP bearer gate — the HTTP-side twin of `hub-trpc-context.ts`.
 *
 * THE GAP THIS CLOSES: `setAuthGate` gated the tRPC router, but the SAME muxed
 * listener also serves `/api/*` (the whole `slay` CLI surface: tasks, artifacts,
 * pty write/submit, browser eval) and `/mcp` — and `createMcpRestApp` mounts
 * nothing but `express.json()`. Under `SLAYZONE_MODE=remote` that listener is the
 * internet-facing https one, so every REST route was reachable unauthenticated
 * while the `slay` CLI was already sending an `Authorization: Bearer` header
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
import type { SlayzoneDb } from '@slayzone/platform'
import { createHubAuth, createHubUser, type HubAuth } from '@slayzone/hub-auth/server'
import { createTestHarness } from '../../../shared/test-utils/ipc-harness.js'
import { restAuthAction, verifyRestBearer, withRestAuth, parseCookieHeader } from './rest-auth.js'
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
  return restAuthAction({ hubAuthRequired: true, url, remoteAddress: WAN })
}

interface GateHarness {
  get(
    path: string,
    opts?: { authorization?: string; cookie?: string }
  ): Promise<{ status: number; body: string; reached: boolean }>
  close(): Promise<void>
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
  const gated = withRestAuth({
    getHubAuthRequired: () => opts.required,
    getHubAuth: () => opts.auth,
    getDb: () => opts.db ?? null,
    next: (_req, res) => {
      reached = true
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
    close: () => new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

async function main(): Promise<void> {
  console.log('\nhub REST/MCP bearer gate')
  console.log('─'.repeat(48))

  // ── auth OFF (local / supervised / default) — must be TOTALLY inert ────────
  await test('auth OFF: every path allows, even the full-power ones', () => {
    for (const url of [
      '/api/tasks',
      '/api/pty/abc/submit',
      '/api/browser/task-1/eval',
      '/mcp',
      '/api/artifacts/t1/export/pdf'
    ]) {
      assertEq(
        restAuthAction({ hubAuthRequired: false, url, remoteAddress: WAN }),
        'allow',
        `gate off → allow ${url}`
      )
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

  await test('computer join-token stays open (its own loopback guard is the protection)', () => {
    // The Electron MAIN process mints over loopback with no bearer at boot; a
    // bearer requirement here would break local-computer auto-enroll on a remote
    // hub. The route itself 403s a non-loopback peer.
    assertEq(remoteWan('/api/computers/join-token'), 'allow', 'join-token exempt')
  })

  await test('hub user management stays open (its own loopback guard is the protection)', () => {
    // `slay hub users add|ls|rm` runs on the hub box and holds no session — a
    // bearer requirement would make it impossible to create the FIRST account on a
    // remote hub, which is the whole reason the route exists. Its own 403 for a
    // non-loopback peer is strictly tighter than a bearer.
    assertEq(remoteWan('/api/hub/users'), 'allow', 'hub users exempt')
    // Exact-path, not prefix: a nested path must NOT inherit the exemption.
    assertEq(remoteWan('/api/hub/users/extra'), 'verify', 'nested path is not exempt')
    assertEq(remoteWan('/api/hub/users?x=1'), 'allow', 'query string does not defeat the match')
  })

  // SUPERVISED-ONLY. On a supervised hub the bind is asserted loopback and the
  // Electron host owns the process, so a co-located caller sits inside a boundary
  // the OS already drew — that path stays byte-identical. On a standalone hub this
  // was the real fail-open: with auth required on every non-supervised hub, an
  // unconditional loopback pass made the gate inert exactly where it began to matter.
  await test('loopback callers bypass the gate ONLY on a supervised hub', () => {
    for (const addr of ['127.0.0.1', '::1', '::ffff:127.0.0.1', '127.0.0.53']) {
      assertEq(
        restAuthAction({
          supervised: true,
          hubAuthRequired: true,
          url: '/api/tasks',
          remoteAddress: addr
        }),
        'allow',
        `loopback ${addr} bypasses when supervised`
      )
      assertEq(
        restAuthAction({ hubAuthRequired: true, url: '/api/tasks', remoteAddress: addr }),
        'verify',
        `loopback ${addr} must present a bearer on a standalone hub`
      )
    }
  })

  await test('an UNKNOWN peer address fails CLOSED (verify, not allow)', () => {
    assertEq(
      restAuthAction({ hubAuthRequired: true, url: '/api/tasks', remoteAddress: undefined }),
      'verify',
      'no remoteAddress → treated as off-box'
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
      restAuthAction({ hubAuthRequired: true, url: undefined, remoteAddress: WAN }),
      'verify',
      'undefined url → verify'
    )
  })

  // ── verifyRestBearer against a REAL better-auth session ───────────────────
  const tmpDir = mkdtempSync(join(tmpdir(), 'hub-rest-auth-'))
  const auth: HubAuth = await createHubAuth({
    dbPath: join(tmpDir, 'hub-auth.sqlite'),
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

    await test('withRestAuth: a real loopback peer is allowed with no bearer when supervised', async () => {
      // The peer address is genuinely 127.0.0.1. Supervised, so the bypass
      // applies — this is the path the desktop host, the supervised computer and
      // in-task `slay` take, and it must stay byte-identical for them.
      const prev = process.env.SLAYZONE_SUPERVISED
      process.env.SLAYZONE_SUPERVISED = '1'
      const h = await mountGate({ required: true, auth, forceOffBox: false })
      try {
        const res = await h.get('/api/tasks')
        assertEq(res.status, 200, 'supervised loopback bypasses the gate')
        assertEq(res.reached, true, 'inner handler ran')
      } finally {
        await h.close()
        if (prev === undefined) delete process.env.SLAYZONE_SUPERVISED
        else process.env.SLAYZONE_SUPERVISED = prev
      }
    })

    await test('withRestAuth: a real loopback peer on a STANDALONE hub must authenticate', async () => {
      const prev = process.env.SLAYZONE_SUPERVISED
      delete process.env.SLAYZONE_SUPERVISED
      const h = await mountGate({ required: true, auth, forceOffBox: false })
      try {
        assertEq((await h.get('/api/tasks')).status, 401, 'no bearer is refused')
        assertEq(
          (await h.get('/api/tasks', { authorization: `Bearer ${validToken}` })).status,
          200,
          'a valid bearer is accepted'
        )
      } finally {
        await h.close()
        if (prev !== undefined) process.env.SLAYZONE_SUPERVISED = prev
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
  } finally {
    await harness.cleanup()
    rmSync(tmpDir, { recursive: true, force: true })
  }

  console.log(`\n${passed} passed, ${failed} failed\n`)
  if (failed > 0) process.exit(1)
}

void main()
