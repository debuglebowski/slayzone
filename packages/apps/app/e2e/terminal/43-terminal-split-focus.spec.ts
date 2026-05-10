import { getTrpcVanillaClient } from '@slayzone/transport/client'
import { test, expect, seed, resetApp } from '../fixtures/electron'
import { TEST_PROJECT_PATH } from '../fixtures/electron'
import { openTaskTerminal, waitForPtySession, getMainSessionId } from '../fixtures/terminal'

test.describe('Terminal split focus', () => {
  let projectAbbrev: string
  let taskId: string

  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
    const s = seed(mainWindow)
    const p = await s.createProject({ name: 'Split Focus', color: '#3b82f6', path: TEST_PROJECT_PATH })
    projectAbbrev = p.name.slice(0, 2).toUpperCase()
    const t = await s.createTask({ projectId: p.id, title: 'SplitTask', status: 'todo' })
    taskId = t.id
    await mainWindow.evaluate((id) => getTrpcVanillaClient().task.update.mutate({ id, terminalMode: 'terminal' }), taskId)
    await s.refreshData()
  })

  test('Cmd+D split focuses the new pane', async ({ mainWindow }) => {
    await openTaskTerminal(mainWindow, { projectAbbrev, taskTitle: 'SplitTask' })
    await waitForPtySession(mainWindow, getMainSessionId(taskId), 20_000)

    // Split via Cmd+D
    await mainWindow.evaluate(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'd', metaKey: true, bubbles: true }))
    })

    // Wait for second tab to appear
    await expect.poll(async () => {
      const tabs = await mainWindow.evaluate((id) => getTrpcVanillaClient().taskTerminals.list.query({ taskId: id }), taskId)
      return tabs.length
    }).toBe(2)

    // Get the new tab's ID (the non-main tab)
    const newTabId = await mainWindow.evaluate(async (id) => {
      const tabs = await getTrpcVanillaClient().taskTerminals.list.query({ taskId: id })
      return tabs.find((t: any) => !t.isMain)?.id
    }, taskId)
    expect(newTabId).toBeTruthy()

    const newSessionId = `${taskId}:${newTabId}`

    // Wait for the new PTY session
    await waitForPtySession(mainWindow, newSessionId, 20_000)

    // Verify focus is inside the new pane
    await expect.poll(async () => {
      return mainWindow.evaluate(() => {
        return document.activeElement?.closest('[data-session-id]')?.getAttribute('data-session-id')
      })
    }, { timeout: 5_000 }).toBe(newSessionId)
  })
})
