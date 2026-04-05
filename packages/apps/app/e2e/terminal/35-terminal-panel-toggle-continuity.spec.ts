import { test, expect, seed, resetApp} from '../fixtures/electron'
import { TEST_PROJECT_PATH } from '../fixtures/electron'
import {
  getMainSessionId,
  openTaskTerminal,
  readFullBuffer,
  runCommand,
  waitForBufferContains,
  waitForPtySession,
} from '../fixtures/terminal'

const panelBtn = (page: import('@playwright/test').Page, label: string) =>
  page
    .locator('.bg-surface-2.rounded-lg:visible')
    .filter({ has: page.locator('button:has-text("Terminal")') })
    .locator(`button:has-text("${label}")`)

test.describe('Terminal panel toggle continuity', () => {
  let projectAbbrev: string
  let taskId: string

  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
    const s = seed(mainWindow)
    const p = await s.createProject({ name: 'Panel Continuity', color: '#8b5cf6', path: TEST_PROJECT_PATH })
    projectAbbrev = p.name.slice(0, 2).toUpperCase()

    const t = await s.createTask({ projectId: p.id, title: 'Panel continuity task', status: 'in_progress' })
    taskId = t.id

    await mainWindow.evaluate((id) => window.api.db.updateTask({ id, terminalMode: 'terminal' }), taskId)
    await s.refreshData()
  })

  test('terminal session and buffer survive panel off/on toggles', async ({ mainWindow }) => {
    const marker = `PANEL_${Date.now()}`

    await openTaskTerminal(mainWindow, { projectAbbrev, taskTitle: 'Panel continuity task' })

    const sessionId = getMainSessionId(taskId)
    await waitForPtySession(mainWindow, sessionId)

    await runCommand(mainWindow, sessionId, `echo ${marker}`)
    await waitForBufferContains(mainWindow, sessionId, marker)

    await panelBtn(mainWindow, 'Terminal').click()
    await expect(panelBtn(mainWindow, 'Terminal')).not.toHaveClass(/(?:^|\s)bg-muted(?:\s|$)/)

    await panelBtn(mainWindow, 'Terminal').click()
    await expect(panelBtn(mainWindow, 'Terminal')).toHaveClass(/bg-muted/)

    await waitForPtySession(mainWindow, sessionId)
    const buffer = await readFullBuffer(mainWindow, sessionId)
    expect(buffer).toContain(marker)
  })
})
