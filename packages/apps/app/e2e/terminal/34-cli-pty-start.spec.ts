import { test, expect, seed, resetApp, TEST_PROJECT_PATH } from '../fixtures/electron'
import { spawnSync } from 'child_process'
import path from 'path'
import fs from 'fs'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SLAY_JS = path.resolve(__dirname, '..', '..', '..', 'cli', 'dist', 'slay.js')

/**
 * CLI cold-start flows:
 *   - `slay tasks open --start <id>` opens task AND spawns its main PTY without
 *     a user click. Backed by POST /api/pty/start.
 *   - `slay pty start <id>` is idempotent — second call says "Already alive".
 *   - `slay pty submit <id> <text>` against a cold main task auto-spawns the PTY
 *     before submitting, instead of 404'ing.
 *   - Split-pane misses still 404 (auto-start scoped to main sessionId).
 */
test.describe('CLI: PTY start + auto-spawn on submit', () => {
  let dbPath = ''
  let projectId = ''
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
    const p = await s.createProject({ name: 'CLI PTY Start', color: '#10b981', path: TEST_PROJECT_PATH })
    projectId = p.id
    await s.refreshData()
  })

  const runCli = (...args: string[]) =>
    spawnSync('node', [SLAY_JS, ...args], {
      env: { ...process.env, SLAYZONE_DB_PATH: dbPath, SLAYZONE_MCP_PORT: String(mcpPort) },
      encoding: 'utf8',
    })

  const ptyExists = async (electronApp: import('playwright').ElectronApplication, sessionId: string) =>
    electronApp.evaluate(async (_, { port, sid }) => {
      const r = await fetch(`http://127.0.0.1:${port}/api/pty`)
      const list = (await r.json()) as { sessionId: string }[]
      return list.some((s) => s.sessionId === sid)
    }, { port: mcpPort, sid: sessionId })

  test('slay tasks open --start cold-spawns main PTY', async ({ electronApp, mainWindow }) => {
    const s = seed(mainWindow)
    const task = await s.createTask({ projectId, title: 'Cold start via open --start', status: 'in_progress' })
    await mainWindow.evaluate((id) => window.api.db.updateTask({ id, terminalMode: 'terminal' }), task.id)
    await s.refreshData()

    expect(await ptyExists(electronApp, `${task.id}:${task.id}`)).toBe(false)

    const r = runCli('tasks', 'open', task.id, '--start')
    expect(r.status).toBe(0)
    expect(r.stdout).toMatch(/Opening \+ (started|already alive)/)

    await expect.poll(() => ptyExists(electronApp, `${task.id}:${task.id}`), { timeout: 10_000 }).toBe(true)
  })

  test('slay pty start is idempotent', async ({ electronApp, mainWindow }) => {
    const s = seed(mainWindow)
    const task = await s.createTask({ projectId, title: 'Idempotent start', status: 'in_progress' })
    await mainWindow.evaluate((id) => window.api.db.updateTask({ id, terminalMode: 'terminal' }), task.id)
    await s.refreshData()

    // First open the task so the tab page can mount.
    runCli('tasks', 'open', task.id)
    await new Promise((r) => setTimeout(r, 500))

    const first = runCli('pty', 'start', task.id.slice(0, 8))
    expect(first.status).toBe(0)
    expect(first.stdout).toMatch(/Started|Already alive/)

    await expect.poll(() => ptyExists(electronApp, `${task.id}:${task.id}`), { timeout: 10_000 }).toBe(true)

    const second = runCli('pty', 'start', task.id.slice(0, 8))
    expect(second.status).toBe(0)
    expect(second.stdout).toMatch(/Already alive/)
  })

  test('slay pty submit auto-spawns cold main PTY', async ({ electronApp, mainWindow }) => {
    const s = seed(mainWindow)
    const task = await s.createTask({ projectId, title: 'Auto-spawn on submit', status: 'in_progress' })
    await mainWindow.evaluate((id) => window.api.db.updateTask({ id, terminalMode: 'terminal' }), task.id)
    await s.refreshData()

    runCli('tasks', 'open', task.id)
    expect(await ptyExists(electronApp, `${task.id}:${task.id}`)).toBe(false)

    // Use --no-wait so submit doesn't block on AI idle check (mode=terminal).
    const r = runCli('pty', 'submit', task.id.slice(0, 8), 'echo hi', '--no-wait')
    expect(r.status).toBe(0)
    await expect.poll(() => ptyExists(electronApp, `${task.id}:${task.id}`), { timeout: 10_000 }).toBe(true)
  })

  test('slay pty submit against unknown id still 404s (no auto-spawn)', async () => {
    const fakeId = '00000000-0000-0000-0000-000000000000'
    const r = runCli('pty', 'submit', fakeId, 'x', '--no-wait')
    expect(r.status).not.toBe(0)
  })
})
