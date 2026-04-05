import { test, expect, seed, resetApp} from '../fixtures/electron'
import { TEST_PROJECT_PATH } from '../fixtures/electron'
import { openTaskTerminal, waitForPtySession, getMainSessionId } from '../fixtures/terminal'

test.describe('Terminal tab keyboard isolation', () => {
  let projectAbbrev: string
  let taskIdA: string
  let taskIdB: string

  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
    const s = seed(mainWindow)
    const p = await s.createProject({ name: 'Isolation Tabs', color: '#8b5cf6', path: TEST_PROJECT_PATH })
    projectAbbrev = p.name.slice(0, 2).toUpperCase()

    const a = await s.createTask({ projectId: p.id, title: 'IsoTask Alpha', status: 'todo' })
    const b = await s.createTask({ projectId: p.id, title: 'IsoTask Bravo', status: 'todo' })
    taskIdA = a.id
    taskIdB = b.id

    await mainWindow.evaluate((id) => window.api.db.updateTask({ id, terminalMode: 'terminal' }), taskIdA)
    await mainWindow.evaluate((id) => window.api.db.updateTask({ id, terminalMode: 'terminal' }), taskIdB)
    await s.refreshData()
  })

  test('Cmd+T only creates tab in active task, not hidden ones', async ({ mainWindow }) => {
    // Open task A
    await openTaskTerminal(mainWindow, { projectAbbrev, taskTitle: 'IsoTask Alpha' })
    await waitForPtySession(mainWindow, getMainSessionId(taskIdA), 20_000)

    // Open task B (both tasks now mounted, A hidden)
    await openTaskTerminal(mainWindow, { projectAbbrev, taskTitle: 'IsoTask Bravo' })
    await waitForPtySession(mainWindow, getMainSessionId(taskIdB), 20_000)

    // Task B is active. Dispatch Cmd+T directly (Electron native menu may intercept keyboard.press).
    await mainWindow.evaluate(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 't', metaKey: true, bubbles: true }))
    })

    // Wait for the new tab to appear in task B
    await expect
      .poll(async () => {
        const tabs = await mainWindow.evaluate((id) => window.api.tabs.list(id), taskIdB)
        return tabs.length
      })
      .toBe(2)

    // Task A should still have only 1 tab (the main tab)
    const tabsA = await mainWindow.evaluate((id) => window.api.tabs.list(id), taskIdA)
    expect(tabsA.length).toBe(1)
  })
})
