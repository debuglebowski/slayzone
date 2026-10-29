/**
 * The security headers on a REAL spawned hub, through every handler that writes a
 * response: the web shell document and a hashed asset (`web-assets.ts`), better-auth
 * (`/api/auth/get-session`), our own `/api/auth/web-login` (sets the session cookie), a REST
 * route, express's 404, `/trpc` over plain HTTP and `/health` (before the gate).
 * `security-headers.test.ts` covers the header logic itself.
 *
 * Two hubs: one on loopback (no public address → never HSTS) and one with an https
 * public address (`hub.example.com` → HSTS on every response). Both require login,
 * so the bearer gate's own answers are on the path too.
 *
 * Run with: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron node_modules/vitest/vitest.mjs run \
 *   --config packages/shared/test-utils/vitest.harness.config.ts \
 *   packages/apps/hub/src/security-headers-served.test.ts
 */
import { spawn, execFileSync, type ChildProcess } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, assert, expect, test } from 'vitest'
import { deriveBootstrapOwnerPassword } from '@slayzone/platform/hub-auth-secret'
import { BOOTSTRAP_OWNER_EMAIL } from '@slayzone/platform/hub-owner-file'
import { API_CSP, webShellCsp } from './security-headers.js'

const require = createRequire(import.meta.url)
const __dirname = dirname(fileURLToPath(import.meta.url))
const HUB_DIR = join(__dirname, '..')
const HUB_BIN = join(HUB_DIR, 'dist', 'bin.cjs')
const WEB_INDEX = join(HUB_DIR, 'dist', 'web', 'index.html')
const ELECTRON_BIN = require('electron') as unknown as string

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
  if (needs) {
    console.log('  … building hub bundle (bin missing or stale)')
    execFileSync('node', ['build.mjs'], { cwd: HUB_DIR, stdio: 'inherit' })
  }
  if (!existsSync(WEB_INDEX)) {
    console.log('  … building the web shell (dist/web missing)')
    execFileSync('pnpm', ['--filter', '@slayzone/web-shell', 'build'], {
      cwd: join(HUB_DIR, '..', '..', '..'),
      stdio: 'inherit'
    })
  }
  if (!existsSync(HUB_BIN) || !existsSync(WEB_INDEX)) throw new Error('hub or web shell not built')
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

async function poll<T>(fn: () => Promise<T | null>, timeoutMs: number, label: string): Promise<T> {
  const start = Date.now()
  for (;;) {
    const v = await fn().catch(() => null)
    if (v != null) return v
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${label}`)
    await new Promise((r) => setTimeout(r, 200))
  }
}

interface Hub {
  base: string
  root: string
  owner: { email: string; password: string; token: string }
  stop: () => Promise<void>
}

/** The bootstrap owner of a reachable hub: derived password, then a bearer. */
async function signInOwner(
  base: string,
  publicAddress: string,
  secret: string
): Promise<Hub['owner']> {
  const owner = { email: BOOTSTRAP_OWNER_EMAIL, password: deriveBootstrapOwnerPassword(secret) }
  const res = await poll(
    async () => {
      const r = await fetch(`${base}/api/auth/sign-in/email`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: `https://${publicAddress}` },
        body: JSON.stringify(owner)
      })
      return r.ok ? r : null
    },
    20_000,
    'bootstrap owner sign-in'
  )
  const token = res.headers.get('set-auth-token')
  assert(token, 'sign-in answers a bearer')
  return { ...owner, token }
}

/** Spawn a login-required hub on loopback, wait for /health and its bootstrap owner. */
async function spawnHub(extraEnv: Record<string, string>): Promise<Hub> {
  const root = mkdtempSync(join(tmpdir(), 'slz-security-headers-'))
  const logs: string[] = []
  // stdin stays an open pipe: a hub treats stdin EOF as "the parent died".
  const proc: ChildProcess = spawn(ELECTRON_BIN, [HUB_BIN], {
    env: {
      ...scrubbedEnv(),
      ELECTRON_RUN_AS_NODE: '1',
      SLAYZONE_ROOT: root,
      SLAYZONE_HUB_LISTEN_ADDRESS: '127.0.0.1:0',
      SLAYZONE_HUB_REQUIRE_LOGIN: '1',
      ...extraEnv
    },
    stdio: ['pipe', 'pipe', 'pipe']
  })
  proc.stdout?.on('data', (d) => logs.push(String(d)))
  proc.stderr?.on('data', (d) => logs.push(String(d)))
  const stop = (): Promise<void> =>
    new Promise((resolve) => {
      if (proc.exitCode !== null || proc.signalCode !== null) return resolve()
      proc.once('exit', () => resolve())
      proc.kill('SIGTERM')
      setTimeout(() => {
        if (!proc.killed) proc.kill('SIGKILL')
      }, 3_000)
    })
  try {
    const listen = await poll(
      async () => logs.find((l) => l.includes('listening on http://')) ?? null,
      20_000,
      'hub listening line'
    )
    const port = Number(listen.match(/http:\/\/127\.0\.0\.1:(\d+)/)?.[1])
    expect(port, `hub listening line parseable: ${listen}`).toBeGreaterThan(0)
    const base = `http://127.0.0.1:${port}`
    await poll(
      async () => ((await fetch(`${base}/health`)).ok ? true : null),
      15_000,
      'hub /health ok'
    )
    // A reachable hub (public address) keeps no owner file (T-11): its owner's password
    // derives from the secret and it signs in like any client.
    const secret = extraEnv.SLAYZONE_HUB_AUTH_SECRET
    const owner = secret
      ? await signInOwner(base, extraEnv.SLAYZONE_HUB_PUBLIC_ADDRESS ?? '', secret)
      : await poll(
          async () => {
            const o = JSON.parse(readFileSync(join(root, 'hub.owner.json'), 'utf8')) as Hub['owner']
            return o.token && o.email && o.password ? o : null
          },
          20_000,
          'bootstrap owner file'
        )
    return { base, root, owner, stop }
  } catch (err) {
    await stop()
    console.error(logs.join('').slice(-2000))
    throw err
  }
}

interface Expected {
  csp: string
  cacheControl: string
  hsts: string | null
}

function checkHeaders(r: Response, exp: Expected, label: string): void {
  const h = r.headers
  expect(h.get('content-security-policy'), `${label}: content-security-policy`).toEqual(exp.csp)
  expect(h.get('cache-control'), `${label}: cache-control`).toEqual(exp.cacheControl)
  expect(h.get('strict-transport-security'), `${label}: strict-transport-security`).toEqual(
    exp.hsts
  )
  expect(h.get('x-content-type-options'), `${label}: x-content-type-options`).toBe('nosniff')
  expect(h.get('x-frame-options'), `${label}: x-frame-options`).toBe('DENY')
  expect(h.get('referrer-policy'), `${label}: referrer-policy`).toBe('same-origin')
  expect(h.get('x-powered-by'), `${label}: x-powered-by`).toBe(null)
  expect(h.has('access-control-allow-origin'), `${label}: no CORS header added`).toBe(false)
}

async function checkHub(name: string, hub: Hub, publicAddress: string | undefined): Promise<void> {
  const hsts = publicAddress === undefined ? null : 'max-age=31536000'
  // The spawned hubs keep the telemetry default (on).
  const shell = { csp: webShellCsp(publicAddress, true), hsts }
  const api = { csp: API_CSP, cacheControl: 'no-store', hsts }
  const bearer = { authorization: `Bearer ${hub.owner.token}` }

  test(`${name}: web shell document`, async () => {
    const r = await fetch(`${hub.base}/`)
    expect(r.status, 'status').toBe(200)
    expect(await r.text(), 'serves the shell').toContain('<div id="root">')
    checkHeaders(r, { ...shell, cacheControl: 'no-cache' }, '/')
  })

  test(`${name}: hashed asset`, async () => {
    const html = await (await fetch(`${hub.base}/`)).text()
    const asset = html.match(/src="(\/assets\/[^"]+\.js)"/)?.[1]
    assert(asset, 'index.html names its entry script')
    const r = await fetch(`${hub.base}${asset}`)
    expect(r.status, 'status').toBe(200)
    expect(r.headers.get('content-type'), 'content-type kept').toBe(
      'text/javascript; charset=utf-8'
    )
    checkHeaders(r, { ...shell, cacheControl: 'public, max-age=31536000, immutable' }, asset)
  })

  test(`${name}: /health (before the gate)`, async () => {
    const r = await fetch(`${hub.base}/health`)
    expect(r.status, 'status').toBe(200)
    checkHeaders(r, api, '/health')
  })

  test(`${name}: better-auth /api/auth/get-session`, async () => {
    const r = await fetch(`${hub.base}/api/auth/get-session`, { headers: bearer })
    expect(r.status, `status ${r.status}`).toBeLessThan(500)
    checkHeaders(r, api, '/api/auth/get-session')
  })

  test(`${name}: REST route, with and without a bearer`, async () => {
    const ok = await fetch(`${hub.base}/api/projects`, { headers: bearer })
    expect(ok.status, 'status with bearer').toBe(200)
    checkHeaders(ok, api, 'GET /api/projects')
    const denied = await fetch(`${hub.base}/api/projects`)
    expect(denied.status, 'status without bearer (the gate answers)').toBe(401)
    checkHeaders(denied, api, 'GET /api/projects (401)')
  })

  test(`${name}: express 404 under /api`, async () => {
    const r = await fetch(`${hub.base}/api/does-not-exist`, { headers: bearer })
    expect(r.status, 'status').toBe(404)
    checkHeaders(r, api, '/api/does-not-exist')
  })

  test(`${name}: /trpc over plain HTTP`, async () => {
    const r = await fetch(`${hub.base}/trpc`)
    expect(r.status, 'status (tRPC is websocket only)').toBe(404)
    checkHeaders(r, api, 'GET /trpc')
  })

  test(`${name}: a 404 outside the API`, async () => {
    const r = await fetch(`${hub.base}/`, { method: 'POST' })
    expect(r.status, 'status').toBe(404)
    checkHeaders(r, { ...shell, cacheControl: 'no-store' }, 'POST /')
  })
}

ensureBuilt()
const hubs: Hub[] = []
afterAll(async () => {
  for (const h of hubs) {
    await h.stop()
    rmSync(h.root, { recursive: true, force: true })
  }
})

const loopback = await spawnHub({})
hubs.push(loopback)
await checkHub('loopback hub', loopback, undefined)

test('loopback hub: password sign-in sets its session cookie with no-store', async () => {
  const r = await fetch(`${loopback.base}/api/auth/web-login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: loopback.base },
    body: JSON.stringify({ email: loopback.owner.email, password: loopback.owner.password })
  })
  expect(r.status, `status (${await r.clone().text()})`).toBe(200)
  expect(
    (r.headers.get('set-cookie') ?? '').startsWith('slayzone_web_session=szw_'),
    'sets the cookie'
  ).toBe(true)
  checkHeaders(r, { csp: API_CSP, cacheControl: 'no-store', hsts: null }, 'web-login')
})

const reachable = await spawnHub({
  SLAYZONE_HUB_PUBLIC_ADDRESS: 'hub.example.com',
  SLAYZONE_HUB_AUTH_SECRET: 's'.repeat(48)
})
hubs.push(reachable)
await checkHub('https public address', reachable, 'hub.example.com')
