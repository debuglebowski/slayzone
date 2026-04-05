import { test, expect, seed, resetApp} from '../fixtures/electron'
import { TEST_PROJECT_PATH } from '../fixtures/electron'
import {
  getMainSessionId,
  getTabSessionId,
  openTaskTerminal,
  runCommand,
  waitForNoPtySession,
  waitForPtySession,
} from '../fixtures/terminal'

test.describe('Terminal exit closes tab', () => {
  let projectAbbrev: string
  let taskId: string

  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
    const s = seed(mainWindow)
    const p = await s.createProject({ name: 'Exit Close', color: '#16a34a', path: TEST_PROJECT_PATH })
    projectAbbrev = p.name.slice(0, 2).toUpperCase()

    const t = await s.createTask({ projectId: p.id, title: 'Close on exit', status: 'in_progress' })
    taskId = t.id

    await mainWindow.evaluate((id) => window.api.db.updateTask({ id, terminalMode: 'terminal' }), taskId)
    await mainWindow.evaluate(() => window.api.pty.setShellOverride('/bin/sh'))
    await s.refreshData()
  })

  test.afterAll(async ({ mainWindow }) => {
    await mainWindow.evaluate(() => window.api.pty.setShellOverride(null))
  })

  test('exiting a secondary pure terminal closes its tab', async ({ mainWindow }) => {
    await openTaskTerminal(mainWindow, { projectAbbrev, taskTitle: 'Close on exit' })

    const mainSessionId = getMainSessionId(taskId)
    await waitForPtySession(mainWindow, mainSessionId, 20_000)

    await mainWindow.locator('[data-testid="terminal-tabbar"]:visible [data-testid="terminal-tab-add"]').first().click()

    await expect
      .poll(async () => {
        const tabs = await mainWindow.evaluate((id) => window.api.tabs.list(id), taskId)
        const nonMain = tabs.find((tab: { id: string; isMain: boolean }) => !tab.isMain)
        return nonMain?.id ?? null
      })
      .not.toBeNull()

    const tabsAfterCreate = await mainWindow.evaluate((id) => window.api.tabs.list(id), taskId)
    const nonMainTabId = tabsAfterCreate.find((tab: { id: string; isMain: boolean }) => !tab.isMain)!.id as string

    const nonMainSessionId = getTabSessionId(taskId, nonMainTabId)
    await waitForPtySession(mainWindow, nonMainSessionId, 20_000)

    await runCommand(mainWindow, nonMainSessionId, 'exit')

    await expect
      .poll(async () => {
        const tabs = await mainWindow.evaluate((id) => window.api.tabs.list(id), taskId)
        return tabs.length
      })
      .toBe(1)

    await waitForNoPtySession(mainWindow, nonMainSessionId, 20_000)
  })
})
