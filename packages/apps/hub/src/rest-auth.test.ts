/**
 * Hub REST/MCP bearer gate — the HTTP-side twin of `hub-trpc-context.ts`.
 *
 * THE GAP THIS CLOSES: `setAuthGate` gated the tRPC router, but the SAME muxed
 * listener also serves `/api/*` (the whole `slay` CLI surface: tasks, artifacts,
 * pty write/submit, browser eval) and `/mcp` — and `createMcpRestApp` mounts
 * nothing but `express.json()`. Under `SLAYZONE_MODE=remote` that listener is the
 * internet-facing https one, so every REST route was reachable unauthenticated
 * while the `slay` CLI was already sending an `Authorization: Bearer` header
 * (from `SLAYZONE_HUB_TOKEN` / `hub.json`) that nobody verified.
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
import { createHubAuth, createHubUser, type HubAuth } from '@slayzone/hub-auth/server'
import { restAuthAction, verifyRestBearer, withRestAuth } from './rest-auth.js'

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
  get(path: string, authorization?: string): Promise<{ status: number; body: string; reached: boolean }>
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
  forceOffBox: boolean
}): Promise<GateHarness> {
  let reached = false
  const gated = withRestAuth({
    getHubAuthRequired: () => opts.required,
    getHubAuth: () => opts.auth,
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
    async get(path, authorization) {
      reached = false
      const res = await fetch(`${base}${path}`, {
        headers: authorization ? { authorization } : undefined
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
    // Local agents post to sidecar loopback; a runner-routed agent posts to the
    // RUNNER's loopback and the envelope is relayed over the authed ws channel —
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
    for (const url of [
      '/api/auth/sign-in/email',
      // Still GATE-exempt, and that is fine: better-auth itself now 400s this route
      // (`emailAndPassword.disableSignUp` in hub-auth's auth.ts), so an open gate no
      // longer means an open hub. Accounts come from the loopback-only
      // /api/hub/users route below. The BAD_REQUEST is asserted in hub-auth.test.ts.
      '/api/auth/sign-up/email',
      '/api/auth/get-session',
      '/api/auth/sign-out'
    ]) {
      assertEq(remoteWan(url), 'allow', `bootstrap route open: ${url}`)
    }
  })

  await test('runner join-token stays open (its own loopback guard is the protection)', () => {
    // The Electron MAIN process mints over loopback with no bearer at boot; a
    // bearer requirement here would break local-runner auto-enroll on a remote
    // hub. The route itself 403s a non-loopback peer.
    assertEq(remoteWan('/api/runners/join-token'), 'allow', 'join-token exempt')
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

  await test('loopback callers bypass the gate (co-located processes, byte-identical)', () => {
    for (const addr of ['127.0.0.1', '::1', '::ffff:127.0.0.1', '127.0.0.53']) {
      assertEq(
        restAuthAction({ hubAuthRequired: true, url: '/api/tasks', remoteAddress: addr }),
        'allow',
        `loopback ${addr} bypasses`
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
    assertEq(remoteWan('/api/runners/join-token/../tasks'), 'verify', 'not the exact join path')
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

  try {
    // Public signup is closed (`disableSignUp`), so the fixture account comes from
    // createHubUser, which generates the password and returns it once.
    const created = await createHubUser(auth, { email: EMAIL, name: 'Client' })
    assert(!('error' in created), 'created the fixture account')
    const signIn = await auth.api.signInEmail({ body: { email: EMAIL, password: created.password } })
    const validToken = signIn.token
    assert(typeof validToken === 'string' && validToken.length > 0, 'got a real session token')

    await test('a real session token in Authorization: Bearer verifies', async () => {
      const ok = await verifyRestBearer(auth, { authorization: `Bearer ${validToken}` })
      assertEq(ok, true, 'valid bearer → true')
    })

    await test('the scheme is case-insensitive (bearer / BEARER)', async () => {
      assertEq(await verifyRestBearer(auth, { authorization: `bearer ${validToken}` }), true, 'lc')
      assertEq(await verifyRestBearer(auth, { authorization: `BEARER ${validToken}` }), true, 'uc')
    })

    await test('a bogus / blank / absent / wrong-scheme header does NOT verify', async () => {
      assertEq(await verifyRestBearer(auth, { authorization: 'Bearer nope' }), false, 'bogus')
      assertEq(await verifyRestBearer(auth, { authorization: 'Bearer ' }), false, 'blank token')
      assertEq(await verifyRestBearer(auth, { authorization: '' }), false, 'empty header')
      assertEq(await verifyRestBearer(auth, {}), false, 'absent header')
      assertEq(
        await verifyRestBearer(auth, { authorization: `Basic ${validToken}` }),
        false,
        'wrong scheme'
      )
      assertEq(
        await verifyRestBearer(auth, { authorization: validToken }),
        false,
        'raw token without a scheme'
      )
    })

    await test('a duplicated Authorization header (string[]) does NOT verify', async () => {
      // node collapses most dup headers, but authorization can arrive as an array;
      // an ambiguous request must fail closed rather than pick one.
      assertEq(
        await verifyRestBearer(auth, {
          authorization: [`Bearer ${validToken}`, 'Bearer other'] as unknown as string
        }),
        false,
        'array header → false'
      )
    })

    await test('a null hubAuth does NOT verify (fail-closed, no crash)', async () => {
      assertEq(
        await verifyRestBearer(null, { authorization: `Bearer ${validToken}` }),
        false,
        'no auth instance → false'
      )
    })

    await test('end-to-end: WAN request to /api/tasks → verify → real token admits it', async () => {
      const action = remoteWan('/api/tasks')
      assertEq(action, 'verify', 'gate demands verification')
      assertEq(
        await verifyRestBearer(auth, { authorization: `Bearer ${validToken}` }),
        true,
        'the CLI bearer (SLAYZONE_HUB_TOKEN / hub.json) is now honoured'
      )
      assertEq(
        await verifyRestBearer(auth, { authorization: 'Bearer forged' }),
        false,
        'a forged bearer is rejected → 401'
      )
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

        const forged = await h.get('/api/tasks', 'Bearer forged')
        assertEq(forged.status, 401, 'forged bearer → 401')
        assertEq(forged.reached, false, 'the inner handler never ran')

        const good = await h.get('/api/tasks', `Bearer ${validToken}`)
        assertEq(good.status, 200, 'valid bearer → 200')
        assertEq(good.reached, true, 'the inner handler ran')
      } finally {
        await h.close()
      }
    })

    await test('withRestAuth: exempt + ungated paths pass through with no bearer', async () => {
      const h = await mountGate({ required: true, auth, forceOffBox: true })
      try {
        for (const path of ['/api/auth/sign-in/email', '/api/runners/join-token', '/whatever']) {
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

    await test('withRestAuth: a real loopback peer is allowed with no bearer', async () => {
      // No override — the peer address is genuinely 127.0.0.1, proving the
      // loopback bypass works against a live socket (this is the path the
      // desktop host / supervised runner / in-task `slay` take).
      const h = await mountGate({ required: true, auth, forceOffBox: false })
      try {
        const res = await h.get('/api/tasks')
        assertEq(res.status, 200, 'loopback bypasses the gate')
        assertEq(res.reached, true, 'inner handler ran')
      } finally {
        await h.close()
      }
    })

    await test('withRestAuth: a null hubAuth 401s a guarded route (fail-closed)', async () => {
      const h = await mountGate({ required: true, auth: null, forceOffBox: true })
      try {
        const res = await h.get('/api/tasks', `Bearer ${validToken}`)
        assertEq(res.status, 401, 'no auth instance → 401, never open')
        assertEq(res.reached, false, 'inner handler never ran')
      } finally {
        await h.close()
      }
    })
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }

  console.log(`\n${passed} passed, ${failed} failed\n`)
  if (failed > 0) process.exit(1)
}

void main()
