import { spawn, type ChildProcess } from 'child_process'
import fs from 'fs'
import net from 'net'
import os from 'os'
import https from 'https'
import path from 'path'
import { fileURLToPath } from 'url'
import { createRequire } from 'module'
import { chromium, test, expect, type Browser, type BrowserContext } from '@playwright/test'

/**
 * Web-access plan, open question #7 — the web shell gets its OWN e2e group
 * rather than extending the hub specs, because it drives a genuinely
 * different client: a plain Playwright BROWSER context (not the Electron
 * fixture every other spec in this suite uses) against a REAL standalone hub
 * booted in `SLAYZONE_MODE=remote`.
 *
 * `remote` is not incidental here — it's the one thing this group exists to
 * prove end to end: `handleWebAssets` only serves `dist/web` under `remote`
 * (see `web-assets-remote-gate.test.ts` for the unit-level negative case),
 * and `remote` is TLS-or-refuses-to-boot (`loadOrCreateHubIdentity` mints a
 * self-signed leaf on first boot — no manual cert step, see
 * hub-identity.ts). So a real browser reaching a real `https://` origin,
 * completing the actual `/api/auth/web-login` flow, and mounting the actual
 * `renderer-app` bundle is the one path no unit test can stand in for.
 *
 * Scope deliberately stops at "the web shell's own plumbing works" — it does
 * not re-derive coverage the Electron suite already owns (board rendering,
 * task CRUD, etc.). `ignoreHTTPSErrors: true` accepts the hub's self-signed
 * leaf the same way a real deployment would pin its fingerprint or front it
 * with a CA-issued cert; this test cares that TLS terminates and the shell
 * answers, not that the leaf chains to a public root.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)
const APP_DIR = path.resolve(__dirname, '..', '..')
const HUB_DIR = path.resolve(APP_DIR, '..', 'hub')
const HUB_BIN = path.join(HUB_DIR, 'dist', 'bin.cjs')
const WEB_INDEX = path.join(HUB_DIR, 'dist', 'web', 'index.html')

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      srv.close(() => resolve(port))
    })
  })
}

/** Strip inherited SLAYZONE_ and ELECTRON_ vars so a hub spawned from inside a
 *  supervised dev/e2e terminal can't inherit the real install's root — same
 *  guard `112-multi-hub-federation.spec.ts` uses for its second hub. */
function scrubbedEnv(): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v == null) continue
    if (/^(ELECTRON_|SLAYZONE_)/.test(k)) continue
    out[k] = v
  }
  return out
}

/** GET a `https://127.0.0.1:<port>` path, trusting the hub's self-signed
 *  leaf explicitly (Node's `fetch` has no per-call TLS override, so this
 *  uses `node:https` directly rather than a process-wide
 *  `NODE_TLS_REJECT_UNAUTHORIZED=0`, which would also weaken every other
 *  TLS check this worker process makes). */
function httpsGetJson(port: number, urlPath: string): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const req = https.get(
      { hostname: '127.0.0.1', port, path: urlPath, rejectUnauthorized: false },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          try {
            resolve({ status: res.statusCode ?? 0, body: JSON.parse(text) })
          } catch {
            resolve({ status: res.statusCode ?? 0, body: text })
          }
        })
      }
    )
    req.on('error', reject)
  })
}

async function waitForRemoteHubHealth(port: number, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const { status, body } = await httpsGetJson(port, '/health')
      if (status === 200 && (body as { ok?: boolean } | null)?.ok) return
    } catch {
      /* TLS/listener not up yet */
    }
    await new Promise((r) => setTimeout(r, 300))
  }
  throw new Error(`remote hub /health not ready on :${port} within ${timeoutMs}ms`)
}

interface OwnerCreds {
  email: string
  password: string
  token: string
}

/** Read the bootstrap owner a standalone hub provisions on first boot — same
 *  pattern as `112-multi-hub-federation.spec.ts`'s `readOwner`. */
async function readOwner(root: string, timeoutMs = 30_000): Promise<OwnerCreds> {
  const file = path.join(root, 'hub.owner.json')
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<OwnerCreds>
      if (parsed.token && parsed.email && parsed.password) {
        return { token: parsed.token, email: parsed.email, password: parsed.password }
      }
    } catch {
      /* not written yet */
    }
    await new Promise((r) => setTimeout(r, 200))
  }
  throw new Error(`hub owner file not usable within ${timeoutMs}ms: ${file}`)
}

interface RemoteHub {
  port: number
  root: string
  owner: OwnerCreds
  stop: () => Promise<void>
}

/** Spawn the hub bundle standalone, in `SLAYZONE_MODE=remote` — TLS terminated
 *  with a freshly-minted self-signed identity, `dist/web` served, auth
 *  unconditionally required (every non-supervised hub). Bound to loopback:
 *  `assertModeHostConsistency` only restricts `local` mode's bind, and remote
 *  + loopback-bind + a same-host public address is exactly the shape a
 *  reverse-proxied deployment has (see server.ts's own comments) — this test
 *  just collapses proxy and hub onto one box. */
async function spawnRemoteHub(): Promise<RemoteHub> {
  if (!fs.existsSync(HUB_BIN)) {
    throw new Error(`hub bin missing: ${HUB_BIN} (run pnpm build)`)
  }
  if (!fs.existsSync(WEB_INDEX)) {
    throw new Error(
      `web shell bundle missing: ${WEB_INDEX} (run pnpm build, which builds it via ` +
        "@slayzone/app's prebuild — or just pnpm --filter @slayzone/web-shell build)"
    )
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'slz-web-shell-e2e-'))
  const port = await freePort()
  const electronPath = require('electron') as unknown as string
  const proc: ChildProcess = spawn(electronPath, [HUB_BIN], {
    env: {
      ...scrubbedEnv(),
      ELECTRON_RUN_AS_NODE: '1',
      SLAYZONE_ROOT: root,
      SLAYZONE_HUB_ADDRESS: `127.0.0.1:${port}`,
      SLAYZONE_MODE: 'remote',
      SLAYZONE_HUB_PUBLIC_ADDRESS: `127.0.0.1:${port}`
    },
    stdio: ['pipe', 'pipe', 'pipe']
  })
  proc.stdout?.on('data', () => undefined)
  proc.stderr?.on('data', () => undefined)

  const stop = (): Promise<void> =>
    new Promise<void>((resolve) => {
      if (proc.exitCode !== null || proc.signalCode !== null) return resolve()
      const t = setTimeout(() => {
        try {
          proc.kill('SIGKILL')
        } catch {
          /* gone */
        }
      }, 3_000)
      proc.once('exit', () => {
        clearTimeout(t)
        resolve()
      })
      try {
        proc.kill('SIGTERM')
      } catch {
        clearTimeout(t)
        resolve()
      }
    })

  try {
    await waitForRemoteHubHealth(port)
    const owner = await readOwner(root)
    return { port, root, owner, stop }
  } catch (err) {
    await stop()
    throw err
  }
}

test.describe('web shell — real remote-mode hub, real TLS, real browser', () => {
  let hub: RemoteHub
  let browser: Browser

  test.beforeAll(async () => {
    hub = await spawnRemoteHub()
    browser = await chromium.launch()
  })

  test.afterAll(async () => {
    await browser.close()
    await hub.stop()
    fs.rmSync(hub.root, { recursive: true, force: true })
  })

  let context: BrowserContext

  test.afterEach(async () => {
    await context?.close()
  })

  test('unauthenticated GET / over TLS renders the login screen (never the app)', async () => {
    context = await browser.newContext({ ignoreHTTPSErrors: true })
    const page = await context.newPage()
    await page.goto(`https://127.0.0.1:${hub.port}/`)
    await expect(page.getByTestId('web-login-screen')).toBeVisible({ timeout: 15_000 })
    // The regression this whole group exists to guard: local mode used to
    // (and per web-assets-remote-gate.test.ts, still would if the gate broke)
    // serve nothing meaningful at all. Confirming the LOGIN screen (not a 404,
    // not a blank page) proves the static bundle + SPA fallback + remote gate
    // all composed correctly for an unauthenticated request.
    await expect(page.locator('#root')).not.toBeEmpty()
  })

  test('wrong password is rejected; login screen stays; no session token stored', async () => {
    context = await browser.newContext({ ignoreHTTPSErrors: true })
    const page = await context.newPage()
    await page.goto(`https://127.0.0.1:${hub.port}/`)
    await page.getByTestId('web-login-email').fill(hub.owner.email)
    await page.getByTestId('web-login-password').fill('definitely-not-the-password')
    await page.getByTestId('web-login-submit').click()
    await expect(page.getByTestId('web-login-error')).toBeVisible({ timeout: 10_000 })
    await expect(page.getByTestId('web-login-screen')).toBeVisible()
    const token = await page.evaluate(() =>
      window.localStorage.getItem('slayzone-web-session-token')
    )
    expect(token).toBeNull()
  })

  test('correct sign-in reaches /api/auth/web-login, stores a scoped token, and mounts the real app', async () => {
    context = await browser.newContext({ ignoreHTTPSErrors: true })
    const page = await context.newPage()
    await page.goto(`https://127.0.0.1:${hub.port}/`)
    await page.getByTestId('web-login-email').fill(hub.owner.email)
    await page.getByTestId('web-login-password').fill(hub.owner.password)

    // LoginScreen calls `window.location.reload()` on a successful sign-in —
    // wait for that navigation explicitly rather than racing the click's own
    // (already-resolved) promise against an async fetch + reload.
    await Promise.all([
      page.waitForEvent('framenavigated'),
      page.getByTestId('web-login-submit').click()
    ])

    // Real end-to-end proof the scoped session actually authenticates:
    // `useTasksData`'s mount effect wires this bridge unconditionally, on
    // every renderer-app consumer, the instant HomeView mounts — reaching it
    // means the reloaded page found its stored token, `initTrpcClient`
    // connected authed over `wss://`, and the real app (not the login
    // screen, not a crash boundary) rendered.
    await page.waitForFunction(
      () =>
        typeof (window as unknown as Record<string, unknown>).__slayzone_refreshData === 'function',
      undefined,
      { timeout: 30_000 }
    )
    await expect(page.getByTestId('web-login-screen')).toHaveCount(0)

    const token = await page.evaluate(() =>
      window.localStorage.getItem('slayzone-web-session-token')
    )
    expect(token).toBeTruthy()
    expect(token).toMatch(/^szw_/)

    // Defense-in-depth check on the dual-credential design (Phase 1): the
    // response also sets an HttpOnly `slayzone_web_session` cookie for `/api/*`
    // REST, distinct from the token this page just read out of localStorage
    // for `/trpc` (see web-login.ts / web-sessions.ts's WEB_SESSION_COOKIE_NAME).
    const cookies = await context.cookies(`https://127.0.0.1:${hub.port}`)
    const sessionCookie = cookies.find((c) => c.name === 'slayzone_web_session')
    expect(sessionCookie?.value).toMatch(/^szw_/)
    expect(sessionCookie?.httpOnly).toBe(true)
    expect(sessionCookie?.secure).toBe(true)
  })
})
