import { test, expect, seed, goHome, clickProject, resetApp } from '../fixtures/electron'
import { TEST_PROJECT_PATH } from '../fixtures/electron'

/**
 * Chat-mode toggle UI test (no live claude spawn).
 *
 * Live transport is covered by unit tests:
 *   packages/domains/terminal/src/main/agents/claude-code-adapter.test.ts
 *   packages/domains/terminal/src/main/chat-transport-manager.test.ts
 *   packages/domains/terminal/src/client/chat-timeline.test.ts
 *
 * This spec covers the UI wiring: toggle button visibility, confirm dialog,
 * DB persistence of display_mode, panel swap on toggle.
 */
test.describe('Chat-mode toggle', () => {
  let projectAbbrev: string
  let taskId: string

  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
    const s = seed(mainWindow)
    const p = await s.createProject({ name: 'Chat Mode', color: '#8b5cf6', path: TEST_PROJECT_PATH })
    projectAbbrev = p.name.slice(0, 2).toUpperCase()

    const task = await s.createTask({ projectId: p.id, title: 'Chat toggle task', status: 'in_progress' })
    taskId = task.id
    // Force terminal_mode = claude-code so the chat toggle is visible
    await mainWindow.evaluate(
      async (id) => window.api.db.updateTask({ id, terminalMode: 'claude-code' } as never),
      taskId
    )
    await s.refreshData()

    await goHome(mainWindow)
    await clickProject(mainWindow, projectAbbrev)
    await mainWindow.getByText('Chat toggle task').first().click()
    await expect(
      mainWindow.locator('[data-testid="terminal-mode-trigger"]:visible').first()
    ).toBeVisible({ timeout: 10_000 })
  })

  test('toggle icon appears on claude-code main tab', async ({ mainWindow }) => {
    const toggle = mainWindow.locator(`[data-testid="terminal-display-mode-toggle-${taskId}"]`)
    await expect(toggle).toBeVisible({ timeout: 5_000 })
  })

  test('clicking toggle shows confirm dialog; cancel preserves xterm', async ({ mainWindow }) => {
    const toggle = mainWindow.locator(`[data-testid="terminal-display-mode-toggle-${taskId}"]`)
    await toggle.click()

    await expect(mainWindow.getByText('Switch to chat view?')).toBeVisible({ timeout: 5_000 })
    await mainWindow.getByRole('button', { name: 'Cancel' }).click()
    await expect(mainWindow.getByText('Switch to chat view?')).toBeHidden({ timeout: 2_000 })

    // DB still xterm
    const row = await mainWindow.evaluate(
      async (tid) => window.api.tabs.list(tid),
      taskId
    )
    const mainTab = row.find((t) => t.isMain)!
    expect(mainTab.displayMode).toBe('xterm')
  })

  test('confirming toggle flips displayMode to chat in DB', async ({ mainWindow }) => {
    const toggle = mainWindow.locator(`[data-testid="terminal-display-mode-toggle-${taskId}"]`)
    await toggle.click()

    await expect(mainWindow.getByText('Switch to chat view?')).toBeVisible({ timeout: 5_000 })
    await mainWindow.getByRole('button', { name: 'Switch' }).click()
    await expect(mainWindow.getByText('Switch to chat view?')).toBeHidden({ timeout: 2_000 })

    // DB updated
    await expect
      .poll(
        async () => {
          const tabs = await mainWindow.evaluate(
            async (tid) => window.api.tabs.list(tid),
            taskId
          )
          const mainTab = tabs.find((t) => t.isMain)
          return mainTab?.displayMode
        },
        { timeout: 5_000 }
      )
      .toBe('chat')
  })

  test('toggle icon flips to terminal icon after switching to chat', async ({ mainWindow }) => {
    const toggle = mainWindow.locator(`[data-testid="terminal-display-mode-toggle-${taskId}"]`)
    await expect(toggle).toBeVisible({ timeout: 5_000 })
    // Icon swap: in chat mode we render lucide terminal icon (class .lucide-terminal)
    await expect(toggle.locator('.lucide-terminal')).toBeVisible({ timeout: 5_000 })
  })
})
