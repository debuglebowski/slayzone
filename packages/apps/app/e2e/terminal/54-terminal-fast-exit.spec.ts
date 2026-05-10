import { test, expect, seed, resetApp} from '../fixtures/electron'
import { getTrpcVanillaClient } from '@slayzone/transport/client'
import { TEST_PROJECT_PATH } from '../fixtures/electron'
import {
  getMainSessionId,
  openTaskTerminal,
  waitForNoPtySession,
} from '../fixtures/terminal'

test.describe('Terminal fast exit', () => {
  let projectAbbrev: string
  let taskId: string

  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
    const s = seed(mainWindow)
    const p = await s.createProject({ name: 'Fast Exit', color: '#dc2626', path: TEST_PROJECT_PATH })
    projectAbbrev = p.name.slice(0, 2).toUpperCase()

    const t = await s.createTask({ projectId: p.id, title: 'Instant exit task', status: 'in_progress' })
    taskId = t.id

    // Terminal mode with /usr/bin/true as shell — exits immediately with code 0
    await mainWindow.evaluate((id) => getTrpcVanillaClient().task.update.mutate({ id, terminalMode: 'terminal' }), taskId)
    await mainWindow.evaluate(() => getTrpcVanillaClient().pty.setShellOverride.mutate({ value: '/usr/bin/true' }))
    await s.refreshData()
  })

  test.afterAll(async ({ mainWindow }) => {
    await mainWindow.evaluate(() => getTrpcVanillaClient().pty.setShellOverride.mutate({ value: null }))
  })

  test('UI does not stay stuck on Starting when PTY exits immediately', async ({ mainWindow }) => {
    const sessionId = getMainSessionId(taskId)

    await openTaskTerminal(mainWindow, { projectAbbrev, taskTitle: 'Instant exit task' })

    await waitForNoPtySession(mainWindow, sessionId)

    const spinner = mainWindow.locator('text="Starting terminal..."')
    await expect(spinner).not.toBeVisible({ timeout: 5_000 })
  })
})
