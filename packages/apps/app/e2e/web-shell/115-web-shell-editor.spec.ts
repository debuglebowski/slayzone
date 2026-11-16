import { spawn, type ChildProcess } from 'child_process'
import fs from 'fs'
import net from 'net'
import os from 'os'
import path from 'path'
import { fileURLToPath } from 'url'
import { createRequire } from 'module'
import { chromium, test, expect, type Browser } from '@playwright/test'
import { attachComputer, scrubbedEnv, until } from '../fixtures/web-shell-computer'

/**
 * The file editor in the REAL web shell bundle, served by a real hub, in a real
 * browser. The desktop editor spec (core/44) runs inside Electron; nothing else
 * proves the editor panel mounts and reads/writes files when the renderer is the
 * web shell talking tRPC to the hub.
 *
 * Hermetic: every off-origin request is aborted. The task gets its own temp
 * working folder beside the hub root, never an agent. Project files are read and
 * written only on a computer (the hub has no local fallback), so every hub here gets
 * one real computer, jailed to the hub's scratch dir.
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

interface Hub {
  base: string
  /** Temp dir holding this hub's state (`hub/`) and its seeded projects, side by side. */
  scratch: string
  root: string
  /** Owner credentials (login-required hub only). */
  owner: { email: string; password: string; token: string } | null
  stop: () => Promise<void>
}

async function spawnHub(requireLogin: boolean): Promise<Hub> {
  if (!fs.existsSync(HUB_BIN) || !fs.existsSync(WEB_INDEX)) {
    throw new Error(`hub or web shell not built (${HUB_BIN}, ${WEB_INDEX}): run pnpm build`)
  }
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'slz-web-shell-editor-'))
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
    return { base, scratch, root, owner, stop }
  } catch (err) {
    await stop()
    throw err
  }
}

/** A project and a task whose terminal is a plain shell in a real (temp) folder. */
async function seed(hub: Hub, name: string): Promise<string> {
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
  // The task gets its own working folder rather than a project folder placement —
  // beside the hub root, never inside it: the owner gate refuses any path in the
  // hub's own state directory. The hub's one computer (attachComputer) reads it.
  const workDir = fs.mkdtempSync(path.join(hub.scratch, 'project-'))
  const project = await post('/api/projects', { name: `${name} Project` })
  const task = await post('/api/tasks', {
    projectId: project.data?.id,
    title: `${name} Task`,
    agentId: 'terminal'
  })
  // Its folder lives on the computer (the hub keeps no task path, §9 7e): set as a
  // user sets it, judged there.
  const r = await fetch(`${hub.base}/api/tasks/${task.data?.id}`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({ baseDir: workDir })
  })
  if (!r.ok) throw new Error(`PATCH task baseDir: ${r.status} ${await r.text()}`)
  return workDir
}

test.describe('web shell file editor — real hub, real browser', () => {
  let browser: Browser
  // One hub per test: the shell restores the last-open task's layout, so a second
  // seeded project on a shared hub is not on screen to click.
  let hub: Hub
  let stopComputer: (() => Promise<void>) | null = null

  test.beforeAll(async () => {
    browser = await chromium.launch()
  })

  test.beforeEach(async () => {
    hub = await spawnHub(false)
    stopComputer = await attachComputer(hub, 'e2e-editor-computer')
  })

  test.afterEach(async () => {
    await stopComputer?.()
    stopComputer = null
    await hub?.stop()
    if (hub) fs.rmSync(hub.scratch, { recursive: true, force: true })
  })

  test.afterAll(async () => {
    await browser?.close()
  })

  /** Open `<name> Task`'s editor panel in a fresh hermetic page. */
  async function openEditor(name: string) {
    const context = await browser.newContext()
    await context.route(
      (url) => !url.href.startsWith(hub.base),
      (route) => void route.abort()
    )
    const page = await context.newPage()
    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(`console: ${m.text()}`)
    })

    await page.goto(`${hub.base}/`)
    await expect(page.getByText(`${name} Project`).first()).toBeVisible({ timeout: 30_000 })
    await page.getByText(`${name} Task`).first().click()
    await page
      .locator('button:visible', { hasText: /^Editor/ })
      .first()
      .click({ timeout: 20_000 })

    return { page, errors }
  }

  test('opens the editor, shows the tree, opens a file, saves an edit to disk', async () => {
    const workDir = await seed(hub, 'Editor')
    fs.writeFileSync(path.join(workDir, 'hello.ts'), 'export const hello = "world"\n')

    const { page, errors } = await openEditor('Editor')
    const panel = page.locator('[data-panel-id="editor"]:visible')
    const treeFile = panel.locator('button.w-full:has-text("hello.ts")').first()
    await expect(treeFile, `editor never mounted; page errors:\n${errors.join('\n')}`).toBeVisible({
      timeout: 20_000
    })

    await treeFile.click()
    const content = panel.locator('.cm-content').first()
    await expect(content).toContainText('export const hello', { timeout: 10_000 })

    await content.click()
    await page.keyboard.press('ControlOrMeta+End')
    await page.keyboard.type('// edited in the browser')
    await page.keyboard.press('ControlOrMeta+s')
    await expect
      .poll(() => fs.readFileSync(path.join(workDir, 'hello.ts'), 'utf8'), { timeout: 10_000 })
      .toContain('// edited in the browser')
  })

  test('a file tree the hub cannot read shows the error and retries, never spins forever', async () => {
    const workDir = await seed(hub, 'Unreadable')
    fs.writeFileSync(path.join(workDir, 'later.ts'), 'export const later = 1\n')
    fs.chmodSync(workDir, 0o000)
    try {
      const { page } = await openEditor('Unreadable')
      const panel = page.locator('[data-panel-id="editor"]:visible')
      const failure = panel.getByTestId('editor-tree-error')
      await expect(failure).toBeVisible({ timeout: 20_000 })
      await expect(failure).toContainText(/EACCES|permission denied/i)

      await expect(failure.getByRole('button', { name: 'Retry' })).toBeVisible()

      // Readable again: the tree's poll (or Retry) recovers without a reload.
      fs.chmodSync(workDir, 0o755)
      await expect(panel.locator('button.w-full:has-text("later.ts")').first()).toBeVisible({
        timeout: 10_000
      })
      await expect(failure).toHaveCount(0)
    } finally {
      fs.chmodSync(workDir, 0o755)
    }
  })

  test("a signed-in browser session (login-required hub) edits its own task's files", async () => {
    await stopComputer?.()
    stopComputer = null
    await hub.stop()
    fs.rmSync(hub.scratch, { recursive: true, force: true })
    hub = await spawnHub(true)
    stopComputer = await attachComputer(hub, 'e2e-editor-computer')
    await signedInEdit()
  })

  async function signedInEdit(): Promise<void> {
    const workDir = await seed(hub, 'Signed')
    fs.writeFileSync(path.join(workDir, 'hello.ts'), 'export const hello = "world"\n')

    const context = await browser.newContext()
    await context.route(
      (url) => !url.href.startsWith(hub.base),
      (route) => void route.abort()
    )
    const page = await context.newPage()
    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(e.message))
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text())
    })
    await page.goto(`${hub.base}/`)
    await expect(page.getByTestId('web-login-screen')).toBeVisible({ timeout: 15_000 })
    await page.getByTestId('web-login-email').fill(hub.owner!.email)
    await page.getByTestId('web-login-password').fill(hub.owner!.password)
    await Promise.all([
      page.waitForEvent('framenavigated'),
      page.getByTestId('web-login-submit').click()
    ])
    await expect(page.getByText('Signed Project').first()).toBeVisible({ timeout: 30_000 })
    await page.getByText('Signed Task').first().click()
    await page
      .locator('button:visible', { hasText: /^Editor/ })
      .first()
      .click({ timeout: 20_000 })

    const panel = page.locator('[data-panel-id="editor"]:visible')
    const treeFile = panel.locator('button.w-full:has-text("hello.ts")').first()
    await treeFile.waitFor({ timeout: 20_000 }).catch(() => undefined)
    const panelText = await panel.innerText().catch(() => '<no editor panel>')
    await expect(
      treeFile,
      `editor tree never loaded:\n${panelText}\n${errors.join('\n')}`
    ).toBeVisible()
    await treeFile.click()
    const content = panel.locator('.cm-content').first()
    await expect(content).toContainText('export const hello', { timeout: 10_000 })
    await content.click()
    await page.keyboard.press('ControlOrMeta+End')
    await page.keyboard.type('// signed-in edit')
    await page.keyboard.press('ControlOrMeta+s')
    await expect
      .poll(() => fs.readFileSync(path.join(workDir, 'hello.ts'), 'utf8'), { timeout: 10_000 })
      .toContain('// signed-in edit')
    expect(errors.filter((e) => /scope for fileEditor|task's folders/.test(e))).toEqual([])
  }
})
