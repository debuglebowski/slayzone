import { test, expect, seed, resetApp, TEST_PROJECT_PATH } from '../fixtures/electron'
import {
  getMainSessionId,
  openTaskTerminal,
  waitForPtySession,
  waitForBufferContains,
  readFullBuffer,
} from '../fixtures/terminal'

test.describe('Terminal shell fallback on CLI crash', () => {
  const customModeId = 'shell-fallback-e2e'
  let projectAbbrev: string
  let taskId: string

  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
    const s = seed(mainWindow)
    const p = await s.createProject({ name: 'Shell Fallback', color: '#dc2626', path: TEST_PROJECT_PATH })
    projectAbbrev = p.name.slice(0, 2).toUpperCase()

    // Create a custom terminal mode whose command always exits with code 1
    await mainWindow.evaluate((id) => {
      return window.api.terminalModes.create({
        id,
        label: 'Failing CLI',
        type: 'custom',
        initialCommand: 'false',
        resumeCommand: '',
        defaultFlags: '',
        enabled: true,
      })
    }, customModeId)

    const t = await s.createTask({ projectId: p.id, title: 'Crash recovery task', status: 'in_progress' })
    taskId = t.id

    await mainWindow.evaluate(
      ({ id, mode }) => window.api.db.updateTask({ id, terminalMode: mode }),
      { id: taskId, mode: customModeId }
    )
    await s.refreshData()
  })

  test.afterAll(async ({ mainWindow }) => {
    if (customModeId) {
      await mainWindow.evaluate((id) => window.api.terminalModes.delete(id), customModeId).catch(() => {})
    }
  })

  test('spawns interactive shell after CLI exits non-zero', async ({ mainWindow }) => {
    const sessionId = getMainSessionId(taskId)

    await openTaskTerminal(mainWindow, { projectAbbrev, taskTitle: 'Crash recovery task' })
    await waitForPtySession(mainWindow, sessionId)

    // Wait for the recovery message in the buffer
    await waitForBufferContains(mainWindow, sessionId, '[SlayZone]', 10_000)

    const buffer = await readFullBuffer(mainWindow, sessionId)
    expect(buffer).toContain('exited with code')
    expect(buffer).toContain('interactive shell for recovery')
  })
})
