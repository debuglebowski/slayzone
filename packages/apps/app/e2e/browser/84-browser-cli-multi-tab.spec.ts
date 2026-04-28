/**
 * Verifies that the slay browser CLI can target individual tabs (not just the
 * active one) via the global `--tab <idOrIdx>` flag.
 */
import { test, expect, seed, resetApp, TEST_PROJECT_PATH } from '../fixtures/electron'
import {
  newTabBtn,
  ensureBrowserPanelVisible,
  openTaskViaSearch,
  getViewsForTask,
  testInvoke,
} from '../fixtures/browser-view'
import { spawnSync } from 'child_process'
import path from 'path'
import fs from 'fs'
import os from 'os'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SLAY_JS = path.resolve(__dirname, '..', '..', '..', 'cli', 'dist', 'slay.js')

function writeFixture(name: string, body: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slay-browser-cli-'))
  const file = path.join(dir, `${name}.html`)
  fs.writeFileSync(file, `<!doctype html><html><body><h1>${body}</h1></body></html>`)
  return `file://${file}`
}

interface CliResult {
  status: number | null
  stdout: string
  stderr: string
}

test.describe('Browser CLI multi-tab targeting', () => {
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
    const p = await s.createProject({ name: 'Browser CLI', color: '#0ea5e9', path: TEST_PROJECT_PATH })
    const t = await s.createTask({ projectId: p.id, title: 'Browser CLI task', status: 'todo' })
    taskId = t.id
    await s.refreshData()
    await openTaskViaSearch(mainWindow, 'Browser CLI task')
    await ensureBrowserPanelVisible(mainWindow)

    // Add a second tab so we have something to target other than the active tab.
    await newTabBtn(mainWindow).click()
    await expect.poll(async () => (await getViewsForTask(mainWindow, taskId)).length, { timeout: 10_000 }).toBe(2)
  })

  function runCli(...args: string[]): CliResult {
    const r = spawnSync('node', [SLAY_JS, ...args], {
      env: {
        ...process.env,
        SLAYZONE_DB_PATH: dbPath,
        SLAYZONE_MCP_PORT: String(mcpPort),
        SLAYZONE_TASK_ID: taskId,
      },
      encoding: 'utf8',
    })
    return { status: r.status, stdout: r.stdout, stderr: r.stderr }
  }

  test('tabs subcommand lists both tabs with idx + active marker', () => {
    const r = runCli('tasks', 'browser', 'tabs')
    expect(r.status, r.stderr).toBe(0)
    // Two tabs: idx 0 and idx 1. One should be marked active (`*`).
    expect(r.stdout).toMatch(/\b0:/)
    expect(r.stdout).toMatch(/\b1:/)
    expect(r.stdout).toContain('*')
  })

  test('navigate --tab targets the inactive tab without affecting the active tab', async ({ mainWindow }) => {
    const URL_TAB_0 = writeFixture('tab0', 'tab-zero')
    const URL_TAB_1 = writeFixture('tab1', 'tab-one')

    const navTab0 = runCli('tasks', 'browser', 'navigate', '--tab', '0', URL_TAB_0)
    expect(navTab0.status, navTab0.stderr).toBe(0)
    const navTab1 = runCli('tasks', 'browser', 'navigate', '--tab', '1', URL_TAB_1)
    expect(navTab1.status, navTab1.stderr).toBe(0)

    const views = await getViewsForTask(mainWindow, taskId)
    expect(views).toHaveLength(2)

    await expect.poll(async () => {
      return (await testInvoke(mainWindow, 'browser:get-url', views[0])) as string
    }, { timeout: 15_000 }).toContain('tab0.html')

    await expect.poll(async () => {
      return (await testInvoke(mainWindow, 'browser:get-url', views[1])) as string
    }, { timeout: 15_000 }).toContain('tab1.html')
  })

  test('url --tab returns the targeted tab url', () => {
    const r0 = runCli('tasks', 'browser', 'url', '--tab', '0')
    expect(r0.status, r0.stderr).toBe(0)
    expect(r0.stdout).toContain('tab0.html')

    const r1 = runCli('tasks', 'browser', 'url', '--tab', '1')
    expect(r1.status, r1.stderr).toBe(0)
    expect(r1.stdout).toContain('tab1.html')
  })

  test('out-of-range --tab idx errors with available tabs listed', () => {
    const r = runCli('tasks', 'browser', 'url', '--tab', '99')
    expect(r.status).not.toBe(0)
    expect(r.stderr).toMatch(/Tab index 99 not found/)
  })
})
