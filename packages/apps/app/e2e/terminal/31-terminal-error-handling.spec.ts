import { test, expect, seed, resetApp} from '../fixtures/electron'
import { TEST_PROJECT_PATH } from '../fixtures/electron'
import {
  getMainSessionId,
  openTaskTerminal
} from '../fixtures/terminal'

test.describe('Terminal error handling', () => {
  let projectAbbrev: string
  let taskId: string

  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
    const s = seed(mainWindow)
    const p = await s.createProject({ name: 'Echo Error', color: '#ef4444', path: TEST_PROJECT_PATH })
    projectAbbrev = p.name.slice(0, 2).toUpperCase()

    const t = await s.createTask({ projectId: p.id, title: 'Terminal error task', status: 'todo' })
    taskId = t.id

    await mainWindow.evaluate((id) => window.api.db.updateTask({ id, terminalMode: 'terminal' }), taskId)
    await s.refreshData()
  })

  test.afterAll(async ({ mainWindow }) => {
    await mainWindow.evaluate(() => window.api.pty.setShellOverride(null))
  })

  test('invalid shell override falls back to the user shell and still allows recreation after reset', async ({ mainWindow }) => {
    const sessionId = getMainSessionId(taskId)

    await mainWindow.evaluate(() => window.api.pty.setShellOverride('/definitely/not/a/real/shell'))

    await openTaskTerminal(mainWindow, { projectAbbrev, taskTitle: 'Terminal error task' })

    await expect
      .poll(async () => mainWindow.evaluate((id) => window.api.pty.exists(id), sessionId))
      .toBe(true)
    await expect(mainWindow.getByText(/Failed to start terminal:/)).toHaveCount(0)

    await mainWindow.evaluate(() => window.api.pty.setShellOverride(null))
    const createResult = await mainWindow.evaluate(
      ({ id, cwd }) => window.api.pty.create({ sessionId: id, cwd, mode: 'terminal' }),
      { id: sessionId, cwd: TEST_PROJECT_PATH }
    )
    expect(createResult.success).toBe(true)
    await expect
      .poll(async () => mainWindow.evaluate((id) => window.api.pty.exists(id), sessionId))
      .toBe(true)
  })
})
