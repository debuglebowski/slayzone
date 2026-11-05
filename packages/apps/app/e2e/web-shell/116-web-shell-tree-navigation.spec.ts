import { spawn, type ChildProcess } from 'child_process'
import fs from 'fs'
import net from 'net'
import os from 'os'
import path from 'path'
import { fileURLToPath } from 'url'
import { createRequire } from 'module'
import { chromium, test, expect, type Browser } from '@playwright/test'

/**
 * Task navigation from the tree sidebar in the REAL web shell bundle, served by a
 * real hub, in a real browser. The web shell renders its own AppSidebar
 * (renderer-app HomeView), so the Electron tree specs do not cover its wiring:
 * the web shell once shipped without `onTaskClick`, and a click on a task row
 * only drew the selection outline, never opened the task.
 *
 * Hermetic: every off-origin request is aborted; the hub has no computer.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)
const HUB_DIR = path.resolve(__dirname, '..', '..', '..', 'hub')
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
  /** Temp dir holding this hub's state (`hub/`). */
  scratch: string
  root: string
  stop: () => Promise<void>
}

async function spawnHub(): Promise<Hub> {
  if (!fs.existsSync(HUB_BIN) || !fs.existsSync(WEB_INDEX)) {
    throw new Error(`hub or web shell not built (${HUB_BIN}, ${WEB_INDEX}): run pnpm build`)
  }
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'slz-web-shell-tree-nav-'))
  const root = path.join(scratch, 'hub')
  fs.mkdirSync(root)
  const port = await freePort()
  const proc: ChildProcess = spawn(require('electron') as unknown as string, [HUB_BIN], {
    env: {
      ...scrubbedEnv(),
      ELECTRON_RUN_AS_NODE: '1',
      PLAYWRIGHT: '1',
      SLAYZONE_ROOT: root,
      SLAYZONE_HUB_LISTEN_ADDRESS: `127.0.0.1:${port}`,
      SLAYZONE_HUB_REQUIRE_LOGIN: '0'
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
    return { base, scratch, root, stop }
  } catch (err) {
    await stop()
    throw err
  }
}

/** One project with two in-progress tasks, shown in the tree sidebar view. */
async function seed(hub: Hub): Promise<void> {
  const post = async (url: string, body: unknown): Promise<{ data?: { id: string } }> => {
    const r = await fetch(`${hub.base}${url}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    })
    if (!r.ok) throw new Error(`${url}: ${r.status} ${await r.text()}`)
    return (await r.json()) as { data?: { id: string } }
  }
  const setSetting = (key: string, value: string) =>
    post('/api/dev/sql', {
      sql: 'INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)',
      params: [key, value],
      method: 'run'
    })
  await setSetting('onboarding_completed', 'true')
  // Tree sidebar, no saved tabs: only the Home tab is open at boot.
  await setSetting('viewState', JSON.stringify({ sidebarView: 'tree' }))
  const project = await post('/api/projects', { name: 'Nav Project' })
  // The tree lists only projects with an open tab or a star; star it so its rows
  // are on screen before any task is open.
  await post('/api/dev/sql', {
    sql: 'UPDATE projects SET starred = 1 WHERE id = ?',
    params: [project.data?.id],
    method: 'run'
  })
  for (const title of ['Nav Alpha', 'Nav Beta']) {
    const task = await post('/api/tasks', { projectId: project.data?.id, title })
    // The tree's default status filter shows in-progress tasks only.
    await post('/api/dev/sql', {
      sql: "UPDATE tasks SET status = 'in_progress' WHERE id = ?",
      params: [task.data?.id],
      method: 'run'
    })
  }
}

test.describe('web shell tree sidebar — task navigation', () => {
  let browser: Browser
  let hub: Hub

  test.beforeAll(async () => {
    browser = await chromium.launch()
    hub = await spawnHub()
    await seed(hub)
  })

  test.afterAll(async () => {
    await browser?.close()
    await hub?.stop()
    if (hub) fs.rmSync(hub.scratch, { recursive: true, force: true })
  })

  test('clicking a task row opens it, clicking another switches to it', async () => {
    const context = await browser.newContext()
    await context.route(
      (url) => !url.href.startsWith(hub.base),
      (route) => void route.abort()
    )
    const page = await context.newPage()
    await page.goto(`${hub.base}/`)

    const row = (title: string) =>
      page.locator('[data-sidebar-tree-item="task"]', { hasText: title }).first()
    await expect(row('Nav Alpha')).toBeVisible({ timeout: 30_000 })

    await row('Nav Alpha').click()
    await expect(row('Nav Alpha')).toHaveAttribute('data-active', 'true', { timeout: 10_000 })

    await row('Nav Beta').click()
    await expect(row('Nav Beta')).toHaveAttribute('data-active', 'true', { timeout: 10_000 })
    await expect(row('Nav Alpha')).not.toHaveAttribute('data-active', 'true')

    await context.close()
  })
})
