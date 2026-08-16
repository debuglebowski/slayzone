/**
 * `/api/auth/web-login` dispatch routing — a REAL standalone hub, not a unit
 * test of a pure function.
 *
 * WHY THIS FILE EXISTS. `dispatchRequest` (server.ts) routes every
 * `/api/auth/*` path to `authApp` (better-auth's own express app) BEFORE
 * `mcpRest.app` ever sees it. `registerWebLoginRoute` mounts `POST
 * /api/auth/web-login` on `mcpRest.app` — a route better-auth's `authApp`
 * knows nothing about. Without an explicit carve-out, EVERY web-login
 * request 404s against `authApp` and never reaches its real handler: the
 * entire scoped-web-session login path (and therefore the whole web shell)
 * was unreachable on a real running hub despite `web-login.ts`'s own unit
 * tests passing (they exercise the route handler directly, never the
 * dispatcher in front of it). Only a real boot + real HTTP request catches
 * this class of bug — hence a full standalone hub here, mirroring
 * `install-handshake.test.ts`'s pattern, not a mocked-app test.
 *
 * Also proves the carve-out is SURGICAL: better-auth's own
 * `/api/auth/sign-in/email` must still route to `authApp` as before.
 *
 * ISOLATION: SLAYZONE_ROOT under a throwaway mkdtemp dir, env scrubbed of
 * inherited SLAYZONE_/ELECTRON_ vars, port 0 (OS-assigned) — same discipline
 * as install-handshake.test.ts. Native ABI: better-sqlite3 needs Electron's
 * node ABI, so this runs under `ELECTRON_RUN_AS_NODE=1 electron`
 * (run_test_electron_strict_loader in run-all.sh).
 *
 * Run with: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron --import tsx/esm \
 *   packages/apps/hub/src/web-login-routing.test.ts
 */
import { spawn, execFileSync, type ChildProcess } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const __dirname = dirname(fileURLToPath(import.meta.url))
const HUB_DIR = join(__dirname, '..')
const HUB_BIN = join(HUB_DIR, 'dist', 'bin.cjs')
const ELECTRON_BIN = require('electron') as unknown as string

let passed = 0
let failed = 0
async function test(name: string, fn: () => Promise<void>): Promise<void> {
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

function newestMtime(dir: string): number {
  let newest = 0
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    newest = Math.max(newest, entry.isDirectory() ? newestMtime(full) : statSync(full).mtimeMs)
  }
  return newest
}

function ensureBuilt(): void {
  let needs = !existsSync(HUB_BIN)
  if (!needs) needs = newestMtime(join(HUB_DIR, 'src')) > statSync(HUB_BIN).mtimeMs
  if (!needs) return
  console.log('  … building hub bundle (bin missing or stale)')
  execFileSync('node', ['build.mjs'], { cwd: HUB_DIR, stdio: 'inherit' })
  if (!existsSync(HUB_BIN)) throw new Error(`hub build did not produce ${HUB_BIN}`)
}

function scrubbedEnv(): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v == null) continue
    if (/^(SLAYZONE_|ELECTRON_)/.test(k)) continue
    out[k] = v
  }
  return out
}

interface Proc {
  proc: ChildProcess
  logs: string[]
  stop: () => Promise<void>
}
function spawnChild(bin: string, env: Record<string, string>): Proc {
  const logs: string[] = []
  const proc = spawn(ELECTRON_BIN, [bin], {
    env: { ...env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  proc.stdout?.on('data', (d) => logs.push(String(d)))
  proc.stderr?.on('data', (d) => logs.push(String(d)))
  return {
    proc,
    logs,
    stop: () =>
      new Promise((resolve) => {
        proc.once('exit', () => resolve())
        proc.kill('SIGTERM')
        setTimeout(() => {
          if (!proc.killed) proc.kill('SIGKILL')
        }, 3_000)
      })
  }
}

async function poll<T>(fn: () => Promise<T | null>, timeoutMs: number, label: string): Promise<T> {
  const start = Date.now()
  for (;;) {
    const v = await fn().catch(() => null)
    if (v != null) return v
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${label}`)
    await new Promise((r) => setTimeout(r, 200))
  }
}

async function main(): Promise<void> {
  console.log('\n/api/auth/web-login dispatch routing (real standalone hub)\n')
  ensureBuilt()

  const root = mkdtempSync(join(tmpdir(), 'slz-web-login-routing-'))
  let hub: Proc | null = null
  let wsClient: { close: () => void } | null = null

  try {
    hub = spawnChild(HUB_BIN, {
      ...scrubbedEnv(),
      SLAYZONE_ROOT: root,
      SLAYZONE_HUB_ADDRESS: '127.0.0.1:0'
    })

    const listen = await poll(
      async () => hub!.logs.find((l) => l.includes('listening on http://')) ?? null,
      20_000,
      'hub listening line'
    )
    const m = listen.match(/http:\/\/(127\.0\.0\.1):(\d+)/)
    assert(m, `hub listening line parseable: ${listen}`)
    const port = Number(m![2])

    const ownerPath = join(root, 'hub.owner.json')
    const owner = await poll(
      async () => {
        const raw = readFileSync(ownerPath, 'utf-8')
        return JSON.parse(raw) as { email: string; password: string }
      },
      15_000,
      'hub.owner.json written'
    )

    await test('POST /api/auth/web-login with the WRONG password → 401, not 404', async () => {
      const res = await fetch(`http://127.0.0.1:${port}/api/auth/web-login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: owner.email, password: 'definitely-wrong' })
      })
      // 404 is exactly the regression: it means the request reached authApp
      // (better-auth's OWN app, which has no /web-login route) instead of
      // mcpRest.app's real handler.
      assert(res.status === 401, `expected 401, got ${res.status} (404 = the routing regression)`)
    })

    let scopedToken = ''
    await test('POST /api/auth/web-login with REAL credentials → 200 + scoped token + cookie', async () => {
      const res = await fetch(`http://127.0.0.1:${port}/api/auth/web-login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: owner.email, password: owner.password })
      })
      assert(res.status === 200, `expected 200, got ${res.status}`)
      const body = (await res.json()) as { ok: boolean; token?: string }
      assert(body.ok === true, 'ok=true')
      assert(typeof body.token === 'string' && body.token.startsWith('szw_'), 'scoped token issued')
      assert(Boolean(res.headers.get('set-cookie')), 'Set-Cookie header present')
      scopedToken = body.token!
    })

    await test("better-auth's OWN /api/auth/sign-in/email still routes to authApp (carve-out is surgical)", async () => {
      const res = await fetch(`http://127.0.0.1:${port}/api/auth/sign-in/email`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: owner.email, password: owner.password })
      })
      // NOT asserting 200: better-auth's own CSRF/trusted-origins plugin
      // separately rejects a bare fetch() with no matching Origin — that
      // behavior is real, pre-existing, and out of scope here (it's what a
      // real browser's automatic same-origin Origin header satisfies). What
      // THIS test guards is narrower and exactly the regression: the request
      // must reach authApp's real handler chain — evidenced by a
      // better-auth-shaped error body (a `code` field) — rather than 404ing
      // because it never got past the /web-login carve-out.
      assert(res.status !== 404, 'must not 404 — that would mean it never reached authApp')
      const body = (await res.json()) as { code?: string }
      assert(
        typeof body.code === 'string',
        `expected a better-auth error shape, got ${JSON.stringify(body)}`
      )
    })

    // Set up the WS connection OUTSIDE the `test()` callback, in the same
    // scope as `wsClient`'s declaration — matching install-handshake.test.ts's
    // structure exactly (assigning `wsClient` from within a nested callback
    // passed to `test()` confuses tsgo's narrowing of the outer `let` binding
    // by the time the `finally` block reads it).
    const { createTRPCClient, createWSClient, wsLink } = await import('@trpc/client')
    const superjson = (await import('superjson')).default
    const ws = createWSClient({
      url: `ws://127.0.0.1:${port}/trpc`,
      connectionParams: async () => ({ token: scopedToken })
    })
    wsClient = ws
    const rawClient = createTRPCClient({ links: [wsLink({ client: ws, transformer: superjson })] })
    // Untyped test-only client (no AppRouter import here) — cast to the
    // narrow shape each call actually needs.
    const client = rawClient as unknown as {
      hub: { describe: { query: () => Promise<{ authRequired: boolean }> } }
      pty: { create: { mutate: (i: unknown) => Promise<unknown> } }
    }

    await test('the scoped token actually authenticates a real tRPC connection', async () => {
      // Open procedure: works regardless.
      const describe = await client.hub.describe.query()
      assert(describe.authRequired === true, 'standalone hub enforces auth')

      // A `never`-scoped procedure must still be refused for a scoped session
      // — the login route working must not silently widen what the token can do.
      let rejected = false
      try {
        await client.pty.create.mutate({ sessionId: 'x', cwd: '/tmp' })
      } catch {
        rejected = true
      }
      assert(rejected, 'pty.create (never-scoped) rejected for a scoped session')
    })
  } finally {
    wsClient?.close()
    if (hub) await hub.stop()
    rmSync(root, { recursive: true, force: true })
  }

  console.log(`\n${passed} passed, ${failed} failed\n`)
  if (failed > 0) process.exit(1)
}

void main()
