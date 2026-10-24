/**
 * Agent startup mode (`terminal_agent_startup`, plans/agent-startup-mode.md):
 * whether opening a task starts its main agent, by mode × how the agent last ended
 * (`terminal_tabs.agent_state`).
 *
 *   | mode    | running | auto_stopped | stopped | new   |
 *   | manual  | gate    | gate         | gate    | gate  |
 *   | auto    | start   | gate         | gate    | start |
 *   | instant | start   | start        | start   | start |
 *
 * Spawns run under the sidecar createPty capture (no real CLI): "start" = a
 * pty.create is recorded for the main session without a click; "gate" = the
 * "Open/Reopen <agent>" button shows and nothing was created.
 *
 * `new` comes from task create itself. The other states are written straight
 * into the hub DB — under the capture stub no real spawn/exit records them.
 */
// `node:sqlite`, not better-sqlite3: the latter's native binding is compiled for
// Electron's ABI and will not load in the Playwright runner's plain node.
import { DatabaseSync } from 'node:sqlite'
import { test, expect, seed, resetApp, TEST_PROJECT_PATH, cliDbPath } from '../fixtures/electron'
import { openTaskTerminal, getMainSessionId, closeAllTaskTabs } from '../fixtures/terminal'

type Mode = 'manual' | 'auto' | 'instant'
type State = 'new' | 'running' | 'auto_stopped' | 'stopped'

const CASES: Array<{ mode: Mode; state: State; starts: boolean }> = [
  { mode: 'manual', state: 'new', starts: false },
  { mode: 'manual', state: 'running', starts: false },
  { mode: 'auto', state: 'new', starts: true },
  { mode: 'auto', state: 'running', starts: true },
  { mode: 'auto', state: 'stopped', starts: false },
  { mode: 'auto', state: 'auto_stopped', starts: false },
  { mode: 'instant', state: 'stopped', starts: true },
  { mode: 'instant', state: 'auto_stopped', starts: true }
]

test.describe('Agent startup mode', () => {
  let projectAbbrev = ''
  let projectId = ''

  const setMode = (page: import('@playwright/test').Page, mode: Mode) =>
    page.evaluate(
      (m) =>
        window
          .getTrpcVanillaClient()
          .settings.set.mutate({ key: 'terminal_agent_startup', value: m }),
      mode
    )

  const createCount = (page: import('@playwright/test').Page, sessionId: string) =>
    page.evaluate(async (sid) => {
      const all = (await window.getTrpcVanillaClient().pty.testTakePtyCreateOpts.query()) as Array<{
        sessionId: string
      }>
      return all.filter((o) => o.sessionId === sid).length
    }, sessionId)

  async function setAgentState(
    electronApp: import('@playwright/test').ElectronApplication,
    taskId: string,
    state: State
  ): Promise<void> {
    const userData = (await electronApp.evaluate(async ({ app }) =>
      app.getPath('userData')
    )) as string
    const db = new DatabaseSync(cliDbPath(userData))
    try {
      db.exec('PRAGMA busy_timeout = 5000')
      db.prepare('UPDATE terminal_tabs SET agent_state = ? WHERE id = ?').run(state, taskId)
    } finally {
      db.close()
    }
  }

  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
    const p = await seed(mainWindow).createProject({
      name: 'StartupMode',
      color: '#0ea5e9',
      path: TEST_PROJECT_PATH
    })
    projectId = p.id
    projectAbbrev = p.name.slice(0, 2).toUpperCase()
    await mainWindow.evaluate(() =>
      window.getTrpcVanillaClient().pty.testSetPtyCreateCapture.mutate({ enabled: true })
    )
  })

  test.afterEach(async ({ mainWindow }) => {
    await closeAllTaskTabs(mainWindow)
  })

  test.afterAll(async ({ mainWindow }) => {
    await setMode(mainWindow, 'manual')
    await mainWindow.evaluate(() =>
      window.getTrpcVanillaClient().pty.testSetPtyCreateCapture.mutate({ enabled: false })
    )
  })

  for (const c of CASES) {
    test(`${c.mode} + ${c.state} → ${c.starts ? 'starts' : 'Start gate'}`, async ({
      mainWindow,
      electronApp
    }) => {
      const title = `Startup ${c.mode} ${c.state}`
      // Mode set BEFORE create: in `auto`/`instant` the pool may reserve the new
      // task's id; in `manual` nothing does.
      await setMode(mainWindow, c.mode)
      const s = seed(mainWindow)
      const task = await s.createTask({ projectId, title, status: 'in_progress' })
      if (c.state !== 'new') await setAgentState(electronApp, task.id, c.state)
      await s.refreshData()

      const sessionId = getMainSessionId(task.id)
      await openTaskTerminal(mainWindow, { projectAbbrev, taskTitle: title })

      if (c.starts) {
        await expect
          .poll(() => createCount(mainWindow, sessionId), { timeout: 10_000 })
          .toBeGreaterThan(0)
        return
      }
      // Same matcher as `startAgentTerminal` (fixtures/terminal.ts).
      const gate = mainWindow
        .locator('button:visible')
        .filter({ hasText: /(Open|Reopen) Claude/ })
        .last()
      await expect(gate).toBeVisible({ timeout: 10_000 })
      // (The icon contributes its own "Claude" text, so anchor on "Reopen" only.)
      if (c.state === 'auto_stopped') await expect(gate).toHaveText(/Reopen Claude/)
      else await expect(gate).not.toHaveText(/Reopen/)
      expect(await createCount(mainWindow, sessionId)).toBe(0)
    })
  }
})
