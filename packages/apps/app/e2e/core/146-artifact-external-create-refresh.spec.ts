import { spawnSync } from 'child_process'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import type { Page } from '@playwright/test'
import {
  test,
  expect,
  seed,
  resetApp,
  cliRoot,
  cliEnv,
  openTaskById,
  goHome,
  TEST_PROJECT_PATH
} from '../fixtures/electron'

/**
 * An artifact created OUTSIDE the app (`slay tasks artifacts create`) shows up in
 * the task's already-open artifacts panel without a reload.
 *
 * Packaged pilot 2026-11-03: the CLI-created report was in the REST and tRPC
 * listings at once, but the open panel only showed it after Reload App.
 * No `refreshData()` here — it invalidates every query and would hide exactly that.
 */
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SLAY_JS = path.resolve(__dirname, '..', '..', '..', 'cli', 'dist', 'slay.js')

const artifactsPanel = (page: Page) => page.locator('[data-panel-id="artifacts"]:visible')
const sidebar = (page: Page) => artifactsPanel(page).locator('[data-testid="artifacts-sidebar"]')
const artifactRow = (page: Page, title: string) =>
  sidebar(page)
    .locator('[data-testid^="artifact-row-"]')
    .filter({ has: page.locator('span', { hasText: title }) })
    .first()

test.describe('artifact created outside the app', () => {
  let rootDir = ''
  let taskId = ''

  test.beforeAll(async ({ electronApp, mainWindow }) => {
    if (!fs.existsSync(SLAY_JS)) {
      throw new Error(`CLI not built. Run: pnpm --filter @slayzone/cli build\nExpected: ${SLAY_JS}`)
    }
    await resetApp(mainWindow)
    rootDir = await cliRoot(electronApp)
    const s = seed(mainWindow)
    const p = await s.createProject({
      name: 'ExtArt Test',
      color: '#0ea5e9',
      path: TEST_PROJECT_PATH
    })
    const t = await s.createTask({
      projectId: p.id,
      title: 'External artifact task',
      status: 'todo'
    })
    taskId = t.id
    await s.refreshData()
    await openTaskById(mainWindow, taskId)
    await mainWindow.keyboard.press('Meta+Shift+A')
    await expect(artifactsPanel(mainWindow)).toBeVisible({ timeout: 5_000 })
    await expect(sidebar(mainWindow).getByText('No artifacts yet')).toBeVisible({ timeout: 5_000 })
  })

  test('slay tasks artifacts create appears in the open panel', async ({ mainWindow }) => {
    const env: Record<string, string> = cliEnv(rootDir)
    delete env.SLAYZONE_PROJECT_ID
    delete env.SLAYZONE_TASK_ID
    const r = spawnSync(
      'node',
      [SLAY_JS, 'tasks', 'artifacts', 'create', 'External report.md', '--task', taskId, '--json'],
      { env, encoding: 'utf8', input: '# from the CLI\n' }
    )
    expect(r.status, r.stderr).toBe(0)

    await expect(artifactRow(mainWindow, 'External report.md')).toBeVisible({ timeout: 5_000 })
  })

  // The pilot's order: the app booted with its tabs restored and Home in front,
  // then the task tab was brought forward, then the CLI wrote.
  test('appears after a boot that restored the tab in the background', async ({ mainWindow }) => {
    await goHome(mainWindow)
    await mainWindow.reload({ waitUntil: 'domcontentloaded' })
    await mainWindow.waitForSelector('#root', { timeout: 10_000 })
    await openTaskById(mainWindow, taskId)
    await expect(artifactRow(mainWindow, 'External report.md')).toBeVisible({ timeout: 10_000 })

    const env: Record<string, string> = cliEnv(rootDir)
    delete env.SLAYZONE_PROJECT_ID
    delete env.SLAYZONE_TASK_ID
    const r = spawnSync(
      'node',
      [SLAY_JS, 'tasks', 'artifacts', 'create', 'After boot.md', '--task', taskId, '--json'],
      { env, encoding: 'utf8', input: '# after boot\n' }
    )
    expect(r.status, r.stderr).toBe(0)

    await expect(artifactRow(mainWindow, 'After boot.md')).toBeVisible({ timeout: 5_000 })
  })

  // A task opened in its own window is a separate renderer: it needs its own
  // `tasks-changed` refresh, the main window's does not reach it.
  test('appears in a secondary task window', async ({ electronApp, mainWindow }) => {
    const windowPromise = electronApp.waitForEvent('window', {
      predicate: (p) => p.url().includes(`taskWindow=${taskId}`)
    })
    await mainWindow.evaluate(
      (id) => window.getTrpcVanillaClient().app.taskWindows.open.mutate({ taskId: id }),
      taskId
    )
    const win = await windowPromise
    try {
      // Show the Artifacts panel here: open it, or take it over from the main
      // window when that one has it open.
      const toggle = win.getByRole('button', { name: /^Artifacts/ })
      const takeOver = win.getByRole('button', { name: 'Take over', exact: true })
      await expect(toggle).toBeVisible({ timeout: 10_000 })
      await expect(async () => {
        if (await takeOver.isVisible()) await takeOver.click()
        else if (!(await sidebar(win).isVisible())) await toggle.click()
        await expect(sidebar(win)).toBeVisible({ timeout: 2_000 })
      }).toPass({ timeout: 15_000 })

      const env: Record<string, string> = cliEnv(rootDir)
      delete env.SLAYZONE_PROJECT_ID
      delete env.SLAYZONE_TASK_ID
      const r = spawnSync(
        'node',
        [SLAY_JS, 'tasks', 'artifacts', 'create', 'In window.md', '--task', taskId, '--json'],
        { env, encoding: 'utf8', input: '# in window\n' }
      )
      expect(r.status, r.stderr).toBe(0)

      await expect(artifactRow(win, 'In window.md')).toBeVisible({ timeout: 5_000 })
    } finally {
      await win.close().catch(() => {})
    }
  })
})
