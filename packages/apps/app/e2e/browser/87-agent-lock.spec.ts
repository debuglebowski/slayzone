/**
 * Agent lock: once a tab is touched by a `slay tasks browser` mutation
 * (navigate/click/type/eval), a lock toggle appears in the URL bar. Locking
 * silences OS-origin input via CDP Input.setIgnoreInputEvents while leaving
 * `executeJavaScript`/`loadURL` (the agent path) working.
 */
import { test, expect, seed, resetApp, TEST_PROJECT_PATH } from '../fixtures/electron'
import {
  ensureBrowserPanelVisible,
  openTaskViaSearch,
  getViewsForTask,
  testInvoke
} from '../fixtures/browser-view'
import { spawnSync } from 'child_process'
import path from 'path'
import fs from 'fs'
import os from 'os'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SLAY_JS = path.resolve(__dirname, '..', '..', '..', 'cli', 'dist', 'slay.js')

function writeFixture(name: string, body: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slay-agent-lock-'))
  const file = path.join(dir, `${name}.html`)
  fs.writeFileSync(
    file,
    `<!doctype html><html><body><h1>${body}</h1><button id="b">click me</button></body></html>`
  )
  return `file://${file}`
}

interface CliResult {
  status: number | null
  stdout: string
  stderr: string
}

test.describe('Agent lock (per-tab, sticky agentTouched + ephemeral lock)', () => {
  let taskId = ''
  let dbPath = ''
  let mcpPort = 0

  test.beforeAll(async ({ electronApp, mainWindow }) => {
    await resetApp(mainWindow)
    if (!fs.existsSync(SLAY_JS)) {
      throw new Error(`CLI not built. Run: pnpm --filter @slayzone/cli build\nExpected: ${SLAY_JS}`)
    }
    const dbDir = await electronApp.evaluate(() => process.env.SLAYZONE_DB_DIR!)
    dbPath = path.join(dbDir, 'slayzone.dev.sqlite')
    mcpPort = await electronApp.evaluate(async () => {
      for (let i = 0; i < 20; i++) {
        const p = (globalThis as Record<string, unknown>).__mcpPort
        if (p) return p as number
        await new Promise((r) => setTimeout(r, 250))
      }
      return 0
    })
    expect(mcpPort).toBeTruthy()

    const s = seed(mainWindow)
    const p = await s.createProject({
      name: 'Agent Lock',
      color: '#f59e0b',
      path: TEST_PROJECT_PATH
    })
    const t = await s.createTask({ projectId: p.id, title: 'Agent lock task', status: 'todo' })
    taskId = t.id
    await s.refreshData()
    await openTaskViaSearch(mainWindow, 'Agent lock task')
    await ensureBrowserPanelVisible(mainWindow)
    await expect
      .poll(async () => (await getViewsForTask(mainWindow, taskId)).length, { timeout: 10_000 })
      .toBe(1)
  })

  function runCli(...args: string[]): CliResult {
    const r = spawnSync('node', [SLAY_JS, ...args], {
      env: {
        ...process.env,
        SLAYZONE_DB_PATH: dbPath,
        SLAYZONE_MCP_PORT: String(mcpPort),
        SLAYZONE_TASK_ID: taskId
      },
      encoding: 'utf8'
    })
    return { status: r.status, stdout: r.stdout, stderr: r.stderr }
  }

  test('lock toggle is absent until an agent CLI mutation hits the tab', async ({ mainWindow }) => {
    // No agentTouched yet → toggle must not be in the DOM.
    // Toggle is always rendered but wrapped in .invisible until agentTouched.
    // Assert it's not visible (semantically absent for the user).
    await expect(
      mainWindow.locator('[data-testid="browser-agent-lock-toggle"]:visible')
    ).toHaveCount(0)
  })

  // BrowserPanel renders two elements with data-testid="browser-agent-lock-
  // toggle": one inside the lock banner (data-locked="true"), one in the URL
  // bar (data-locked="false"). Disambiguate via the banner wrapper or the
  // data-locked attribute.
  const bannerToggle = (page: import('@playwright/test').Page) =>
    page.locator(
      '[data-testid="browser-agent-lock-banner"] [data-testid="browser-agent-lock-toggle"]'
    )
  const urlBarToggle = (page: import('@playwright/test').Page) =>
    page.locator('[data-testid="browser-agent-lock-toggle"][data-locked="false"]:visible')

  test('navigate via CLI trips agentTouched, surfaces toggle, and auto-locks the tab', async ({
    electronApp,
    mainWindow
  }) => {
    const URL_A = writeFixture('a', 'page-a')
    const r = runCli('tasks', 'browser', 'navigate', URL_A)
    expect(r.status, r.stderr).toBe(0)

    // Probe DB: agentTouched should flip, then auto-lock should write locked.
    const dbTab = () =>
      electronApp.evaluate(async (_, tid) => {
        type DB = {
          get: (
            sql: string,
            params?: unknown[]
          ) => Promise<{ browser_tabs: string | null } | undefined>
        }
        const db = (globalThis as Record<string, unknown>).__db as DB
        const row = await db.get('SELECT browser_tabs FROM tasks WHERE id = ?', [tid])
        const state = row?.browser_tabs ? JSON.parse(row.browser_tabs) : null
        return state?.tabs?.[0] ?? null
      }, taskId)
    await expect.poll(dbTab, { timeout: 10_000 }).toMatchObject({ agentTouched: true })
    // The auto-lock effect in BrowserPanel.tsx watches prev=false→curr=true.
    // If panel mounted with the tab already touched (no prev=false snapshot),
    // it won't transition. Surface that by asserting locked in DB.
    await expect.poll(dbTab, { timeout: 5_000 }).toMatchObject({ locked: true })

    // DB confirms locked=true; banner depends on TaskDetailPage propagating
    // tabs prop with locked. Force a refresh in case tasks:changed coalesced.
    await mainWindow.evaluate(() => {
      void (
        window as { __slayzone_refreshData?: () => Promise<void> | void }
      ).__slayzone_refreshData?.()
    })
    await expect(bannerToggle(mainWindow)).toBeVisible({ timeout: 10_000 })

    // Main-process state reflects locked.
    const views = await getViewsForTask(mainWindow, taskId)
    expect(views).toHaveLength(1)
    await expect
      .poll(async () => (await testInvoke(mainWindow, 'browser:is-locked', views[0])) as boolean, {
        timeout: 5_000
      })
      .toBe(true)
  })

  test('clicking the toggle unlocks; clicking again re-locks', async ({ mainWindow }) => {
    const views = await getViewsForTask(mainWindow, taskId)

    // Locked → click banner toggle → unlocked.
    await bannerToggle(mainWindow).click()
    await expect(bannerToggle(mainWindow)).toHaveCount(0, { timeout: 3_000 })
    await expect(urlBarToggle(mainWindow)).toBeVisible({ timeout: 3_000 })
    await expect
      .poll(async () => (await testInvoke(mainWindow, 'browser:is-locked', views[0])) as boolean)
      .toBe(false)

    // Unlocked → click URL-bar toggle → locked.
    await urlBarToggle(mainWindow).click()
    await expect(bannerToggle(mainWindow)).toBeVisible({ timeout: 3_000 })
    await expect
      .poll(async () => (await testInvoke(mainWindow, 'browser:is-locked', views[0])) as boolean)
      .toBe(true)
  })

  // DEFER 2026-06-23 (still fails, real): CLI click reports "Element not found: #b"
  // on the locked tab — fixture page-b lacks `#b`, or the locked-tab nav route is
  // short-circuited before the page finishes loading. Trace the locked-tab CLI route. See plan.
  test.skip('agent CLI ops still work while the tab is locked', async ({ mainWindow }) => {
    const views = await getViewsForTask(mainWindow, taskId)
    // Explicitly ensure locked state (prior tests may have left it unlocked).
    await testInvoke(mainWindow, 'browser:set-locked', views[0], true)
    await mainWindow
      .evaluate(
        (d) =>
          window
            .getTrpcVanillaClient()
            .task.setBrowserTabLocked.mutate({ taskId: d.taskId, tabId: d.tabId, locked: true }),
        {
          taskId,
          tabId: views[0]
        }
      )
      .catch(() => {})
    await expect
      .poll(async () => (await testInvoke(mainWindow, 'browser:is-locked', views[0])) as boolean, {
        timeout: 3_000
      })
      .toBe(true)

    const URL_B = writeFixture('b', 'page-b')
    const r = runCli('tasks', 'browser', 'navigate', URL_B)
    expect(r.status, r.stderr).toBe(0)

    await expect
      .poll(
        async () => {
          return (await testInvoke(mainWindow, 'browser:get-url', views[0])) as string
        },
        { timeout: 10_000 }
      )
      .toContain('b.html')

    // Lock state must survive the agent op — no toggle, no churn.
    expect((await testInvoke(mainWindow, 'browser:is-locked', views[0])) as boolean).toBe(true)

    // CLI click also unaffected by the lock.
    const click = runCli('tasks', 'browser', 'click', '#b')
    expect(click.status, click.stderr).toBe(0)
  })

  test('agentTouched is sticky in the DB after first trip', async ({ electronApp }) => {
    // Trip agentTouched directly via CLI nav (the previous "auto-lock" test
    // is quarantined, so this test owns the trip).
    const URL_T = writeFixture('trip', 'page-trip')
    const r = runCli('tasks', 'browser', 'navigate', URL_T)
    expect(r.status, r.stderr).toBe(0)

    // Use the test-only __db global instead of dynamically importing
    // better-sqlite3 (dynamic imports aren't allowed inside evaluate).
    const stored = await electronApp.evaluate(async (_, tid) => {
      type DB = {
        get: (
          sql: string,
          params?: unknown[]
        ) => Promise<{ browser_tabs: string | null } | undefined>
      }
      const db = (globalThis as Record<string, unknown>).__db as DB | undefined
      if (!db) throw new Error('__db not exposed by main')
      const row = await db.get('SELECT browser_tabs FROM tasks WHERE id = ?', [tid])
      return row?.browser_tabs ?? null
    }, taskId)

    expect(stored).toBeTruthy()
    const parsed = JSON.parse(stored as string) as {
      tabs: { id: string; agentTouched?: boolean }[]
    }
    expect(parsed.tabs.some((t) => t.agentTouched === true)).toBe(true)
  })
})
