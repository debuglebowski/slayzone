import { spawn, type ChildProcess } from 'child_process'
import fs from 'fs'
import net from 'net'
import os from 'os'
import path from 'path'
import { fileURLToPath } from 'url'
import { createRequire } from 'module'
import { chromium, test, expect, type Browser, type Page } from '@playwright/test'

/**
 * The hub's Content-Security-Policy against the REAL web shell bundle in a real
 * browser (apps/hub/src/security-headers.ts). A policy that is too tight shows up
 * only here: as `securitypolicyviolation` events and "Refused to …" console errors,
 * while the shell itself may look fine. So every case records both, through the
 * flows that load the most code: boot, password sign-in, the project board and a
 * task's terminal (xterm), and asserts zero.
 *
 * Two hubs, like the two ways the shell boots:
 *   - login required: the login screen and `/api/auth/web-login`.
 *   - login off: no token, so settings load and the shell starts PostHog. The test
 *     checks it contacts only the hosts the CSP names, and never loads its scripts.
 *
 * Hermetic: every request that leaves the hub's origin is answered here (PostHog with
 * `{}`) or aborted, never sent. A request the CSP blocks never reaches the route.
 *
 * Both hubs set PLAYWRIGHT=1 for `/api/dev/sql` (seeds `onboarding_completed`, so no
 * onboarding dialog covers the board). The task's terminal is a plain shell
 * (`terminalMode: 'terminal'`) in a temp project dir, never an agent.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)
const HUB_DIR = path.resolve(__dirname, '..', '..', '..', 'hub')
const HUB_BIN = path.join(HUB_DIR, 'dist', 'bin.cjs')
const WEB_INDEX = path.join(HUB_DIR, 'dist', 'web', 'index.html')

/** The PostHog hosts the hub's CSP allows (`POSTHOG_ORIGINS` in security-headers.ts). */
const POSTHOG_HOSTS = ['eu.i.posthog.com', 'eu-assets.i.posthog.com']

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

function scrubbedEnv(): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v == null) continue
    if (/^(ELECTRON_|SLAYZONE_)/.test(k)) continue
    out[k] = v
  }
  return out
}

async function until<T>(fn: () => Promise<T | null> | T | null, label: string): Promise<T> {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    try {
      const v = await fn()
      if (v != null) return v
    } catch {
      /* not yet */
    }
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error(`timed out waiting for ${label}`)
}

interface Hub {
  base: string
  root: string
  /** Owner credentials (login-required hub only). */
  owner: { email: string; password: string; token: string } | null
  stop: () => Promise<void>
}

async function spawnHub(requireLogin: boolean): Promise<Hub> {
  if (!fs.existsSync(HUB_BIN) || !fs.existsSync(WEB_INDEX)) {
    throw new Error(`hub or web shell not built (${HUB_BIN}, ${WEB_INDEX}): run pnpm build`)
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'slz-web-shell-csp-'))
  const port = await freePort()
  const proc: ChildProcess = spawn(require('electron') as unknown as string, [HUB_BIN], {
    env: {
      ...scrubbedEnv(),
      ELECTRON_RUN_AS_NODE: '1',
      PLAYWRIGHT: '1',
      SLAYZONE_ROOT: root,
      SLAYZONE_HUB_LISTEN_ADDRESS: `127.0.0.1:${port}`,
      SLAYZONE_HUB_REQUIRE_LOGIN: requireLogin ? '1' : '0'
    },
    stdio: ['pipe', 'pipe', 'pipe']
  })
  proc.stdout?.on('data', () => undefined)
  proc.stderr?.on('data', () => undefined)
  const stop = (): Promise<void> =>
    new Promise<void>((resolve) => {
      if (proc.exitCode !== null || proc.signalCode !== null) return resolve()
      const t = setTimeout(() => proc.kill('SIGKILL'), 3_000)
      proc.once('exit', () => {
        clearTimeout(t)
        resolve()
      })
      proc.kill('SIGTERM')
    })
  const base = `http://127.0.0.1:${port}`
  try {
    await until(async () => ((await fetch(`${base}/health`)).ok ? true : null), 'hub /health')
    const owner = requireLogin
      ? await until(() => {
          const o = JSON.parse(fs.readFileSync(path.join(root, 'hub.owner.json'), 'utf8'))
          return o.token && o.email && o.password ? o : null
        }, 'bootstrap owner')
      : null
    return { base, root, owner, stop }
  } catch (err) {
    await stop()
    throw err
  }
}

/** A project with a real (temp) path and a task whose terminal is a plain shell. */
async function seed(hub: Hub): Promise<void> {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (hub.owner) headers.authorization = `Bearer ${hub.owner.token}`
  const post = async (url: string, body: unknown): Promise<{ data?: { id: string } }> => {
    const r = await fetch(`${hub.base}${url}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body)
    })
    if (!r.ok) throw new Error(`${url}: ${r.status} ${await r.text()}`)
    return (await r.json()) as { data?: { id: string } }
  }
  await post('/api/dev/sql', {
    sql: "INSERT OR REPLACE INTO settings (key, value) VALUES ('onboarding_completed', 'true')",
    method: 'run'
  })
  const projectDir = fs.mkdtempSync(path.join(hub.root, 'project-'))
  const project = await post('/api/projects', { name: 'CSP Project', path: projectDir })
  await post('/api/tasks', {
    projectId: project.data?.id,
    title: 'CSP Task',
    terminalMode: 'terminal'
  })
}

interface Recorder {
  violations: string[]
  cspConsole: string[]
  external: string[]
}

/** A page that records CSP violations, CSP console errors and every off-origin request. */
async function recordingPage(browser: Browser, hub: Hub): Promise<{ page: Page; rec: Recorder }> {
  const context = await browser.newContext()
  const rec: Recorder = { violations: [], cspConsole: [], external: [] }
  await context.route(
    (url) => !url.href.startsWith(hub.base),
    (route) => {
      const url = new URL(route.request().url())
      rec.external.push(url.host)
      if (POSTHOG_HOSTS.includes(url.host)) {
        void route.fulfill({ status: 200, contentType: 'application/json', body: '{}' })
      } else {
        void route.abort()
      }
    }
  )
  await context.exposeBinding('__cspViolation', (_src, v: string) => rec.violations.push(v))
  await context.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (e) => {
      const report = (window as unknown as { __cspViolation: (v: string) => void }).__cspViolation
      report(`${e.violatedDirective} blocked ${e.blockedURI} at ${e.sourceFile}:${e.lineNumber}`)
    })
  })
  const page = await context.newPage()
  page.on('console', (m) => {
    if (/content security policy/i.test(m.text())) rec.cspConsole.push(m.text())
  })
  return { page, rec }
}

/** The board shows the seeded project, then the task's terminal mounts xterm. */
async function openBoardAndTerminal(page: Page): Promise<void> {
  await expect(page.getByText('CSP Project').first()).toBeVisible({ timeout: 30_000 })
  await page.getByText('CSP Task').first().click()
  await expect(page.locator('.xterm-screen').first()).toBeVisible({ timeout: 20_000 })
  // Let lazy chunks, the terminal's renderer and telemetry settle before counting.
  await page.waitForTimeout(3_000)
}

function expectClean(rec: Recorder): void {
  expect(rec.violations, 'securitypolicyviolation events').toEqual([])
  expect(rec.cspConsole, 'CSP console errors').toEqual([])
  for (const host of rec.external) expect(POSTHOG_HOSTS, `off-origin request`).toContain(host)
}

test.describe('web shell under the hub CSP — real hub, real browser', () => {
  let browser: Browser
  const hubs: Hub[] = []

  test.beforeAll(async () => {
    browser = await chromium.launch()
  })

  test.afterAll(async () => {
    await browser.close()
    for (const hub of hubs) {
      await hub.stop()
      fs.rmSync(hub.root, { recursive: true, force: true })
    }
  })

  test('login required: load, password sign-in, board and terminal, zero violations', async () => {
    const hub = await spawnHub(true)
    hubs.push(hub)
    await seed(hub)
    const { page, rec } = await recordingPage(browser, hub)

    const doc = await page.goto(`${hub.base}/`)
    const csp = (await doc?.allHeaders())?.['content-security-policy'] ?? ''
    expect(csp).toContain("script-src 'self'")
    expect(csp).not.toContain('unsafe-eval')

    await expect(page.getByTestId('web-login-screen')).toBeVisible({ timeout: 15_000 })
    await page.getByTestId('web-login-email').fill(hub.owner!.email)
    await page.getByTestId('web-login-password').fill(hub.owner!.password)
    await Promise.all([
      page.waitForEvent('framenavigated'),
      page.getByTestId('web-login-submit').click()
    ])
    await expect(page.getByTestId('web-login-screen')).toHaveCount(0, { timeout: 30_000 })

    await openBoardAndTerminal(page)
    expectClean(rec)
  })

  test('login off: PostHog only at the allowed hosts, no remote script, zero violations', async () => {
    const hub = await spawnHub(false)
    hubs.push(hub)
    await seed(hub)
    const { page, rec } = await recordingPage(browser, hub)

    await page.goto(`${hub.base}/`)
    await openBoardAndTerminal(page)
    expectClean(rec)
    // PostHog started (remote config JSON from the assets host, flags from ingestion),
    // and no `<script>` from its CDN.
    expect(rec.external).toContain('eu-assets.i.posthog.com')
    expect(rec.external).toContain('eu.i.posthog.com')
    const remoteScripts = await page.evaluate(
      () => [...document.scripts].filter((s) => s.src && !s.src.startsWith(location.origin)).length
    )
    expect(remoteScripts).toBe(0)
  })
})
