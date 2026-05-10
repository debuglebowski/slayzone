import { test, expect, seed, resetApp} from '../fixtures/electron'
import { getTrpcVanillaClient } from '@slayzone/transport/client'
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

    await mainWindow.evaluate((id) => getTrpcVanillaClient().task.update.mutate({ id, terminalMode: 'terminal' }), taskId)
    await s.refreshData()
  })

  test.afterAll(async ({ mainWindow }) => {
    await mainWindow.evaluate(() => getTrpcVanillaClient().pty.setShellOverride.mutate({ value: null }))
  })

  test('invalid shell override falls back to the user shell and still allows recreation after reset', async ({ mainWindow }) => {
    const sessionId = getMainSessionId(taskId)

    await mainWindow.evaluate(() => getTrpcVanillaClient().pty.setShellOverride.mutate({ value: '/definitely/not/a/real/shell' }))

    await openTaskTerminal(mainWindow, { projectAbbrev, taskTitle: 'Terminal error task' })

    await expect
      .poll(async () => mainWindow.evaluate((id) => getTrpcVanillaClient().pty.exists.query({ sessionId: id }), sessionId))
      .toBe(true)
    await expect(mainWindow.getByText(/Failed to start terminal:/)).toHaveCount(0)

    await mainWindow.evaluate(() => getTrpcVanillaClient().pty.setShellOverride.mutate({ value: null }))
    const createResult = await mainWindow.evaluate(
      ({ id, cwd }) => getTrpcVanillaClient().pty.create.mutate({ sessionId: id, cwd, mode: 'terminal' }),
      { id: sessionId, cwd: TEST_PROJECT_PATH }
    )
    expect(createResult.success).toBe(true)
    await expect
      .poll(async () => mainWindow.evaluate((id) => getTrpcVanillaClient().pty.exists.query({ sessionId: id }), sessionId))
      .toBe(true)
  })
})
