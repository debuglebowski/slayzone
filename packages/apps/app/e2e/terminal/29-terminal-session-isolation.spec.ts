import { test, expect, seed, resetApp} from '../fixtures/electron'
import { TEST_PROJECT_PATH } from '../fixtures/electron'
import {
  getMainSessionId,
  getTabSessionId,
  openTaskTerminal,
  readFullBuffer,
  runCommand,
  waitForBufferContains,
  waitForPtySession,
} from '../fixtures/terminal'

test.describe('Terminal session isolation', () => {
  let projectAbbrev: string
  let taskAId: string
  let taskBId: string

  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
    const s = seed(mainWindow)
    const p = await s.createProject({ name: 'Bravo Isolation', color: '#84cc16', path: TEST_PROJECT_PATH })
    projectAbbrev = p.name.slice(0, 2).toUpperCase()

    const taskA = await s.createTask({ projectId: p.id, title: 'Isolation task A', status: 'in_progress' })
    const taskB = await s.createTask({ projectId: p.id, title: 'Isolation task B', status: 'in_progress' })
    taskAId = taskA.id
    taskBId = taskB.id

    await mainWindow.evaluate((ids) => {
      return Promise.all([
        window.api.db.updateTask({ id: ids.a, terminalMode: 'terminal' }),
        window.api.db.updateTask({ id: ids.b, terminalMode: 'terminal' }),
      ])
    }, { a: taskAId, b: taskBId })

    await s.refreshData()
  })

  test('keeps PTY output isolated across tabs and tasks', async ({ mainWindow }) => {
    const markerA1 = `A_MAIN_${Date.now()}`
    const markerA2 = `A_TAB2_${Date.now()}`
    const markerB1 = `B_MAIN_${Date.now()}`

    await openTaskTerminal(mainWindow, { projectAbbrev, taskTitle: 'Isolation task A' })

    const sessionA1 = getMainSessionId(taskAId)
    await waitForPtySession(mainWindow, sessionA1)
    await runCommand(mainWindow, sessionA1, `echo ${markerA1}`)
    await waitForBufferContains(mainWindow, sessionA1, markerA1)

    await mainWindow.locator('[data-testid="terminal-tabbar"]:visible [data-testid="terminal-tab-add"]').first().click()

    await expect
      .poll(async () => {
        const tabs = await mainWindow.evaluate((id) => window.api.tabs.list(id), taskAId)
        const nonMain = tabs.find((tab: { id: string; isMain: boolean }) => !tab.isMain)
        return nonMain?.id ?? null
      })
      .not.toBeNull()

    const taskATabs = await mainWindow.evaluate((id) => window.api.tabs.list(id), taskAId)
    const nonMainTab = taskATabs.find((tab: { id: string; isMain: boolean }) => !tab.isMain)
    expect(nonMainTab).toBeTruthy()

    const sessionA2 = getTabSessionId(taskAId, nonMainTab!.id)
    await waitForPtySession(mainWindow, sessionA2)
    await runCommand(mainWindow, sessionA2, `echo ${markerA2}`)
    await waitForBufferContains(mainWindow, sessionA2, markerA2)

    const bufferA1 = await readFullBuffer(mainWindow, sessionA1)
    const bufferA2 = await readFullBuffer(mainWindow, sessionA2)
    expect(bufferA1).toContain(markerA1)
    expect(bufferA1).not.toContain(markerA2)
    expect(bufferA2).toContain(markerA2)
    expect(bufferA2).not.toContain(markerA1)

    await openTaskTerminal(mainWindow, { projectAbbrev, taskTitle: 'Isolation task B' })

    const sessionB1 = getMainSessionId(taskBId)
    await waitForPtySession(mainWindow, sessionB1)
    await runCommand(mainWindow, sessionB1, `echo ${markerB1}`)
    await waitForBufferContains(mainWindow, sessionB1, markerB1)

    const bufferB1 = await readFullBuffer(mainWindow, sessionB1)
    expect(bufferB1).toContain(markerB1)
    expect(bufferB1).not.toContain(markerA1)
    expect(bufferB1).not.toContain(markerA2)

    const bufferA1AfterB = await readFullBuffer(mainWindow, sessionA1)
    expect(bufferA1AfterB).toContain(markerA1)
    expect(bufferA1AfterB).not.toContain(markerB1)
  })
})
