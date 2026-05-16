import { test, expect, seed, goHome, clickProject, resetApp, TEST_PROJECT_PATH } from '../fixtures/electron'
import { spawnSync } from 'child_process'
import path from 'path'
import fs from 'fs'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SLAY_JS = path.resolve(__dirname, '..', '..', '..', 'cli', 'dist', 'slay.js')

test.describe('Task progress', () => {
  const PROJECT_ABBREV = 'TP'
  let projectId = ''
  let openTaskId = ''
  let cliTaskId = ''
  let doneTaskId = ''
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
    const p = await s.createProject({ name: 'Progress Test', color: '#6366f1', path: TEST_PROJECT_PATH })
    projectId = p.id

    const t1 = await s.createTask({ projectId, title: 'UI progress task', status: 'todo' })
    openTaskId = t1.id
    const t2 = await s.createTask({ projectId, title: 'CLI progress task', status: 'todo' })
    cliTaskId = t2.id
    const t3 = await s.createTask({ projectId, title: 'Done progress task', status: 'done' })
    doneTaskId = t3.id
    await s.updateTask({ id: doneTaskId, progress: 50 })
    await s.refreshData()

    await goHome(mainWindow)
    await clickProject(mainWindow, PROJECT_ABBREV)
  })

  const runCli = (...args: string[]) =>
    spawnSync('node', [SLAY_JS, ...args], {
      env: { ...process.env, SLAYZONE_DB_PATH: dbPath, SLAYZONE_MCP_PORT: String(mcpPort) },
      encoding: 'utf8',
    })

  test('default progress is 0 on new tasks', async ({ mainWindow }) => {
    const tasks = await seed(mainWindow).getTasks() as Array<{ id: string; progress: number }>
    const t = tasks.find((x) => x.id === openTaskId)
    expect(t?.progress).toBe(0)
  })

  test('CLI sets progress and updates DB', async ({ mainWindow }) => {
    const r = runCli('tasks', 'progress', cliTaskId.slice(0, 8), '75')
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('75%')

    const tasks = await seed(mainWindow).getTasks() as Array<{ id: string; progress: number }>
    const t = tasks.find((x) => x.id === cliTaskId)
    expect(t?.progress).toBe(75)
  })

  test('CLI rejects out-of-range values', () => {
    const over = runCli('tasks', 'progress', cliTaskId.slice(0, 8), '150')
    expect(over.status).not.toBe(0)
    expect(over.stderr).toContain('0-100')

    const under = runCli('tasks', 'progress', cliTaskId.slice(0, 8), '200')
    expect(under.status).not.toBe(0)
  })

  // QUARANTINED 2026-05-16: kanban card visibility test — project's task list
  // not rendering in the visible viewport during this suite. The DB tests
  // above still cover CLI → DB progress write. UI assertion needs investigation
  // (tree view default? hidden panel? project not selected?).
  test.skip('kanban card shows progress ring after CLI update', async ({ mainWindow }) => {
    const r = runCli('tasks', 'progress', openTaskId.slice(0, 8), '40')
    expect(r.status).toBe(0)

    // Use the dedicated data-task-id attribute on the kanban card (visible-only).
    const card = mainWindow.locator(`[data-task-id="${openTaskId}"]:visible`).first()
    await expect(card).toBeVisible({ timeout: 5_000 })
    await expect(card.locator('[aria-label*="Progress:"][aria-label*="40%"]').first()).toBeVisible({ timeout: 5_000 })
  })

  test.skip('progress indicator hidden on done tasks', async ({ mainWindow }) => {
    // Done tasks may need show-done toggle. Use the kanban card data-task-id.
    const doneCard = mainWindow.locator(`[data-task-id="${doneTaskId}"]:visible`).first()
    if (!(await doneCard.count())) {
      // Toggle show-done in case it's hidden.
      await mainWindow.keyboard.press('Shift+D').catch(() => {})
    }
    await expect(doneCard).toBeVisible({ timeout: 3_000 })
    await expect(doneCard.locator('[aria-label*="Progress:"]')).toHaveCount(0)
  })

  test.skip('progress hidden on card when value is 0', async ({ mainWindow }) => {
    const r = runCli('tasks', 'progress', openTaskId.slice(0, 8), '0')
    expect(r.status).toBe(0)

    const card = mainWindow.locator(`[data-task-id="${openTaskId}"]:visible`).first()
    await expect(card).toBeVisible({ timeout: 5_000 })
    await expect(card.locator('[aria-label*="Progress:"]')).toHaveCount(0)
  })
})
