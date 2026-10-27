import { spawn, type ChildProcess } from 'child_process'
import fs from 'fs'
import net from 'net'
import os from 'os'
import path from 'path'
import { fileURLToPath } from 'url'
import { createRequire } from 'module'
import { chromium, test, expect, type Browser, type BrowserContext } from '@playwright/test'

/**
 * Web-access plan, open question #7 — the web shell gets its OWN e2e group
 * rather than extending the hub specs, because it drives a genuinely
 * different client: a plain Playwright BROWSER context (not the Electron
 * fixture every other spec in this suite uses) against a REAL standalone hub
 * booted with `SLAYZONE_HUB_REQUIRE_LOGIN=1`.
 *
 * Login being required is the point: it is what makes the shell show its login
 * screen and what makes `/api/auth/web-login` mint a scoped session. The hub
 * serves plain http — it never terminates TLS (a front end does in a real
 * deployment) — so this spec reaches it at `http://127.0.0.1:<port>`, a loopback
 * origin browsers treat as secure. A real browser completing the actual
 * `/api/auth/web-login` flow and mounting the actual `renderer-app` bundle is the
 * one path no unit test can stand in for.
 *
 * Scope deliberately stops at "the web shell's own plumbing works" — it does
 * not re-derive coverage the Electron suite already owns (board rendering,
 * task CRUD, etc.).
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

async function waitForHubHealth(port: number, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`, {
        signal: AbortSignal.timeout(1_000)
      })
      if (res.status === 200 && ((await res.json()) as { ok?: boolean } | null)?.ok) return
    } catch {
      /* listener not up yet */
    }
    await new Promise((r) => setTimeout(r, 300))
  }
  throw new Error(`hub /health not ready on :${port} within ${timeoutMs}ms`)
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

interface LoginHub {
  port: number
  root: string
  owner: OwnerCreds
  /** Everything the hub has written to stdout + stderr so far (its security log included). */
  output: () => string
  stop: () => Promise<void>
}

/** Spawn the hub bundle standalone with login required: `dist/web` served, a bootstrap
 *  owner provisioned, plain http on loopback. */
async function spawnLoginHub(): Promise<LoginHub> {
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
      SLAYZONE_HUB_LISTEN_ADDRESS: `127.0.0.1:${port}`,
      SLAYZONE_HUB_REQUIRE_LOGIN: '1'
    },
    stdio: ['pipe', 'pipe', 'pipe']
  })
  let output = ''
  proc.stdout?.on('data', (chunk: Buffer) => {
    output += chunk.toString()
  })
  proc.stderr?.on('data', (chunk: Buffer) => {
    output += chunk.toString()
  })

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
    await waitForHubHealth(port)
    const owner = await readOwner(root)
    return { port, root, owner, output: () => output, stop }
  } catch (err) {
    await stop()
    throw err
  }
}

/** The hub's `authz.denied` lines for a scope refusal (security log, one JSON line each). */
function scopeDenials(output: string): Array<{ targetId?: string; detail?: { setting?: string } }> {
  return output
    .split('\n')
    .filter((line) => line.includes('"authz.denied"'))
    .map((line) => {
      try {
        return JSON.parse(line.slice(line.indexOf('{'))) as {
          targetId?: string
          detail?: { reason?: string; setting?: string }
        }
      } catch {
        return null
      }
    })
    .filter((e): e is NonNullable<typeof e> => e?.detail?.reason === 'scope')
}

test.describe('web shell — real login-required hub, real browser', () => {
  let hub: LoginHub
  let browser: Browser

  test.beforeAll(async () => {
    hub = await spawnLoginHub()
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

  test('unauthenticated GET / renders the login screen (never the app)', async () => {
    context = await browser.newContext()
    const page = await context.newPage()
    await page.goto(`http://127.0.0.1:${hub.port}/`)
    await expect(page.getByTestId('web-login-screen')).toBeVisible({ timeout: 15_000 })
    // Confirming the LOGIN screen (not a 404, not a blank page) proves the static
    // bundle + SPA fallback + the `authRequired` boot branch all composed
    // correctly for an unauthenticated request.
    await expect(page.locator('#root')).not.toBeEmpty()
  })

  test('wrong password is rejected; login screen stays; no session token stored', async () => {
    context = await browser.newContext()
    const page = await context.newPage()
    await page.goto(`http://127.0.0.1:${hub.port}/`)
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

  test('correct sign-in reaches /api/auth/web-login, sets the scoped cookie, and mounts the real app', async () => {
    context = await browser.newContext()
    const page = await context.newPage()
    await page.goto(`http://127.0.0.1:${hub.port}/`)
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
    // means the reloaded page found its session (the hub's cookie), the
    // websocket connected authed by that cookie, and the real app (not the
    // login screen, not a crash boundary) rendered.
    await page.waitForFunction(
      () =>
        typeof (window as unknown as Record<string, unknown>).__slayzone_refreshData === 'function',
      undefined,
      { timeout: 30_000 }
    )
    await expect(page.getByTestId('web-login-screen')).toHaveCount(0)

    // T-13: the cookie is the ONLY carrier — nothing a script can read.
    const stored = await page.evaluate(() => ({
      local: window.localStorage.getItem('slayzone-web-session-token'),
      session: window.sessionStorage.getItem('slayzone-web-session-token')
    }))
    expect(stored).toEqual({ local: null, session: null })

    const cookies = await context.cookies()
    const sessionCookie = cookies.find((c) => c.name === 'slayzone_web_session')
    expect(sessionCookie?.value).toMatch(/^szw_/)
    expect(sessionCookie?.httpOnly).toBe(true)
    expect(sessionCookie?.sameSite).toBe('Lax')
    // A loopback hub with no public address is plain http: not Secure (an https
    // public address makes it Secure — web-sessions.ts `webSessionCookieSecure`).
    expect(sessionCookie?.secure).toBe(false)
  })

  // #164: the hub refused a web session's `settings.get`, `settings.getAll` and
  // `pty.warmSetProjectTabCounts` (one `authz.denied` line each), and `settings.set`
  // too, so its layout never persisted. Now it reads and writes its OWN settings, and
  // the client no longer pushes warm-pool counts it would only be refused. Later the
  // same for `app.meta.getVersion` (now `read`), `app.auth.onCallback` and
  // `telemetry.onIpcEvent` (still `never`, the client skips them): the hub refuses a
  // web session NOTHING, so any new call a web session cannot make fails here.
  test('a web session keeps its layout across a reload, and the hub refuses none of its calls', async () => {
    context = await browser.newContext()
    const page = await context.newPage()
    await page.goto(`http://127.0.0.1:${hub.port}/`)
    await page.getByTestId('web-login-email').fill(hub.owner.email)
    await page.getByTestId('web-login-password').fill(hub.owner.password)
    await Promise.all([
      page.waitForEvent('framenavigated'),
      page.getByTestId('web-login-submit').click()
    ])

    type TabStore = {
      getState: () => {
        isLoaded: boolean
        treeGroupBy: string
        setTreeGroupBy: (g: string) => void
      }
    }
    const tabStoreLoaded = () =>
      page.waitForFunction(
        () =>
          (window as unknown as { __slayzone_tabStore?: TabStore }).__slayzone_tabStore?.getState()
            .isLoaded === true,
        undefined,
        { timeout: 30_000 }
      )
    await tabStoreLoaded()
    // A layout change: the tab store saves it as `viewState`, a per-user setting.
    await page.evaluate(() =>
      (window as unknown as { __slayzone_tabStore: TabStore }).__slayzone_tabStore
        .getState()
        .setTreeGroupBy('priority')
    )
    // Past the store's 500 ms save debounce.
    await page.waitForTimeout(1_500)

    await page.reload()
    await tabStoreLoaded()
    const groupBy = await page.evaluate(
      () =>
        (window as unknown as { __slayzone_tabStore: TabStore }).__slayzone_tabStore.getState()
          .treeGroupBy
    )
    expect(groupBy).toBe('priority')

    // Past the warm-pool push debounce (150 ms) and its `hub.describe` round trip.
    await page.waitForTimeout(1_500)
    const refused = scopeDenials(hub.output()).map((e) => e.targetId)
    expect(refused).toEqual([])
  })
})
