import { test, expect, seed, goHome, clickProject } from './fixtures/electron'
import { TEST_PROJECT_PATH } from './fixtures/electron'
import { getMainSessionId, openTaskTerminal, runCommand, switchTerminalMode, waitForPtySession } from './fixtures/terminal'

test.describe('Terminal mode switching', () => {
  let projectAbbrev: string
  let projectId: string
  let taskId: string

  test.beforeAll(async ({ mainWindow }) => {
    const s = seed(mainWindow)
    const p = await s.createProject({ name: 'Mode Switch', color: '#8b5cf6', path: TEST_PROJECT_PATH })
    projectAbbrev = p.name.slice(0, 2).toUpperCase()
    projectId = p.id
    const t = await s.createTask({ projectId: p.id, title: 'Mode switch task', status: 'todo' })
    taskId = t.id
    await s.refreshData()

    await openTaskTerminal(mainWindow, { projectAbbrev, taskTitle: 'Mode switch task' })
  })

  /** Find the terminal mode select trigger in the bottom bar */
  const modeTrigger = (page: import('@playwright/test').Page) =>
    page.locator('[data-testid="terminal-mode-trigger"]:visible').first()

  test('default mode is Claude Code', async ({ mainWindow }) => {
    await expect(modeTrigger(mainWindow)).toHaveText(/Claude( Code)?/)
  })

  /** Open the terminal header dropdown (MoreHorizontal trigger) */
  const openTerminalMenu = async (page: import('@playwright/test').Page) => {
    await page.locator('.lucide-ellipsis:visible, .lucide-more-horizontal:visible').first().click()
    await expect(page.locator('[role="menu"]')).toBeVisible()
  }

  test('claude-code mode shows Sync name action in menu', async ({ mainWindow }) => {
    await openTerminalMenu(mainWindow)
    await expect(mainWindow.getByRole('menuitem', { name: 'Sync name' })).toBeVisible()
    await mainWindow.keyboard.press('Escape')
  })

  test('switch to Terminal mode', async ({ mainWindow }) => {
    await switchTerminalMode(mainWindow, 'terminal')

    // Select now shows Terminal
    await expect(modeTrigger(mainWindow)).toHaveText(/Terminal/)
  })

  test('terminal mode hides Sync name and Flags', async ({ mainWindow }) => {
    await openTerminalMenu(mainWindow)
    await expect(mainWindow.getByRole('menuitem', { name: 'Sync name' })).not.toBeVisible()
    await mainWindow.keyboard.press('Escape')
    await expect(mainWindow.locator('input[placeholder="Flags"]')).not.toBeVisible()
  })

  test('mode persists in DB', async ({ mainWindow }) => {
    const task = await mainWindow.evaluate((id) => window.api.db.getTask(id), taskId)
    expect(task?.terminal_mode).toBe('terminal')
  })

  test('switch to Codex mode', async ({ mainWindow }) => {
    await switchTerminalMode(mainWindow, 'codex')

    await expect(modeTrigger(mainWindow)).toHaveText(/Codex/)
  })

  test('codex mode hides Sync name', async ({ mainWindow }) => {
    await openTerminalMenu(mainWindow)
    await expect(mainWindow.getByRole('menuitem', { name: 'Sync name' })).not.toBeVisible()
    await mainWindow.keyboard.press('Escape')
  })

  test('mode persists across navigation', async ({ mainWindow }) => {
    // Navigate away
    await goHome(mainWindow)

    // Navigate back
    await clickProject(mainWindow, projectAbbrev)
    await mainWindow.getByText('Mode switch task').first().click()
    await expect(modeTrigger(mainWindow)).toBeVisible()

    // Verify persisted mode from DB after re-open
    const task = await mainWindow.evaluate((id) => window.api.db.getTask(id), taskId)
    expect(task?.terminal_mode).toBe('codex')
  })

  test('switch back to Claude Code', async ({ mainWindow }) => {
    await switchTerminalMode(mainWindow, 'claude-code')

    await expect(modeTrigger(mainWindow)).toHaveText(/Claude( Code)?/)
    await openTerminalMenu(mainWindow)
    await expect(mainWindow.getByRole('menuitem', { name: 'Sync name' })).toBeVisible()
    await mainWindow.keyboard.press('Escape')
  })

  test('conversation IDs cleared on mode switch', async ({ mainWindow }) => {
    // Set fake conversation IDs for multiple providers
    await mainWindow.evaluate((id) =>
      window.api.db.updateTask({
        id,
        claudeConversationId: 'fake-convo-123',
        codexConversationId: 'fake-codex-456',
        cursorConversationId: 'fake-cursor-789',
        geminiConversationId: 'fake-gemini-abc',
        opencodeConversationId: 'fake-opencode-def',
      }), taskId)

    // Switch to terminal and back
    await switchTerminalMode(mainWindow, 'terminal')
    await expect(modeTrigger(mainWindow)).toHaveText(/Terminal/)

    // Verify ALL conversation IDs cleared
    const task = await mainWindow.evaluate((id) => window.api.db.getTask(id), taskId)
    expect(task?.claude_conversation_id).toBeNull()
    expect(task?.codex_conversation_id).toBeNull()
    expect(task?.cursor_conversation_id).toBeNull()
    expect(task?.gemini_conversation_id).toBeNull()
    expect(task?.opencode_conversation_id).toBeNull()

    // Switch back to claude-code for clean state
    await switchTerminalMode(mainWindow, 'claude-code')
    await expect(modeTrigger(mainWindow)).toHaveText(/Claude( Code)?/)
  })

  test('flags persist through mode changes', async ({ mainWindow }) => {
    // Set custom flags for claude-code
    await mainWindow.evaluate((id) =>
      window.api.db.updateTask({ id, claudeFlags: '--custom-flag-test' }), taskId)

    // Switch to codex then back
    await switchTerminalMode(mainWindow, 'codex')
    await expect(modeTrigger(mainWindow)).toHaveText(/Codex/)

    await switchTerminalMode(mainWindow, 'claude-code')
    await expect(modeTrigger(mainWindow)).toHaveText(/Claude( Code)?/)

    // Flags should persist (mode switch clears conversation IDs, not flags)
    const task = await mainWindow.evaluate((id) => window.api.db.getTask(id), taskId)
    expect(task?.claude_flags).toBe('--custom-flag-test')
  })

  test('temporary tasks can switch terminal mode', async ({ mainWindow }) => {
    const s = seed(mainWindow)
    const temp = await s.createTask({
      projectId,
      title: 'Mode switch temporary task',
      status: 'in_progress',
      isTemporary: true,
    })
    await s.refreshData()

    await openTaskTerminal(mainWindow, { projectAbbrev, taskTitle: 'Mode switch temporary task' })
    await expect(modeTrigger(mainWindow)).toBeVisible()

    await switchTerminalMode(mainWindow, 'codex')
    await expect(modeTrigger(mainWindow)).toHaveText(/Codex/)

    const updated = await mainWindow.evaluate((id) => window.api.db.getTask(id), temp.id)
    expect(updated?.terminal_mode).toBe('codex')
  })

  test('temporary terminal task is removed from active task list on clean exit', async ({ mainWindow }) => {
    const s = seed(mainWindow)
    const temp = await s.createTask({
      projectId,
      title: 'Mode switch temporary auto-delete',
      status: 'in_progress',
      isTemporary: true,
      terminalMode: 'terminal',
    })
    await s.refreshData()

    await openTaskTerminal(mainWindow, { projectAbbrev, taskTitle: 'Mode switch temporary auto-delete' })
    const sessionId = getMainSessionId(temp.id)
    await waitForPtySession(mainWindow, sessionId, 20_000)
    await runCommand(mainWindow, sessionId, 'exit')

    await expect.poll(async () => {
      const activeTasks = await mainWindow.evaluate(() => window.api.db.getTasks())
      return !activeTasks.some((task) => task.id === temp.id)
    }, { timeout: 15_000 }).toBe(true)
  })
})
