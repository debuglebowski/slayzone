import { test, expect, seed, goHome, clickProject, resetApp} from '../fixtures/electron'
import { TEST_PROJECT_PATH } from '../fixtures/electron'
import { openTaskTerminal, switchTerminalMode } from '../fixtures/terminal'

// Simulate native menu accelerators by sending IPC directly from main process.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function sendAppShortcut(electronApp: any, channel: string): Promise<void> {
  await electronApp.evaluate(
    ({ BrowserWindow }: { BrowserWindow: typeof Electron.CrossProcessExports.BrowserWindow }, ch: string) => {
      BrowserWindow.getAllWindows()
        .find((w) => !w.isDestroyed() && !w.webContents.getURL().startsWith('data:'))
        ?.webContents.send(ch)
    },
    channel
  )
}

test.describe('Terminal mode switching', () => {
  let projectAbbrev: string
  let projectId: string
  let taskId: string

  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
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

    // Switch to codex and back
    await switchTerminalMode(mainWindow, 'codex')
    await expect(modeTrigger(mainWindow)).toHaveText(/Codex/)

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

  test('switching back to a mode restores that mode default flags', async ({ mainWindow }) => {
    // Set custom flags for claude-code
    await mainWindow.evaluate((id) =>
      window.api.db.updateTask({ id, claudeFlags: '--custom-flag-test' }), taskId)

    // Switch to codex then back
    await switchTerminalMode(mainWindow, 'codex')
    await expect(modeTrigger(mainWindow)).toHaveText(/Codex/)

    await switchTerminalMode(mainWindow, 'claude-code')
    await expect(modeTrigger(mainWindow)).toHaveText(/Claude( Code)?/)

    const claudeMode = await mainWindow.evaluate(() => window.api.terminalModes.get('claude-code'))
    const expectedDefaultFlags = claudeMode?.defaultFlags ?? ''

    // Returning to claude-code should re-apply the mode default flags
    const task = await mainWindow.evaluate((id) => window.api.db.getTask(id), taskId)
    expect(task?.claude_flags).toBe(expectedDefaultFlags)
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

  test('toggling chat on temporary task does not delete the task', async ({ mainWindow }) => {
    const s = seed(mainWindow)
    const temp = await s.createTask({
      projectId,
      title: 'Chat toggle temp survives',
      status: 'in_progress',
      isTemporary: true,
      terminalMode: 'claude-code',
    })
    await s.refreshData()

    await openTaskTerminal(mainWindow, { projectAbbrev, taskTitle: 'Chat toggle temp survives' })

    // Open terminal menu, enable chat
    await mainWindow.locator('[data-testid="terminal-menu-trigger"]:visible').first().click()
    await mainWindow.getByRole('menuitem', { name: /Enable chat/ }).click()
    await mainWindow.getByRole('button', { name: 'Enable' }).click()

    // displayMode flips to 'chat' in DB
    await expect.poll(async () => {
      const list = await mainWindow.evaluate((id) => window.api.tabs.list(id), temp.id)
      return list.find((t) => t.isMain)?.displayMode
    }, { timeout: 5_000 }).toBe('chat')

    // Task still exists — auto-close hook must NOT have deleted it
    // Poll a few cycles to ensure the PTY exit handler had time to fire.
    await mainWindow.waitForTimeout(500)
    const tasks = await mainWindow.evaluate(() => window.api.db.getTasks())
    expect(tasks.some((t) => t.id === temp.id)).toBe(true)

    // Now toggle back to xterm via ChatPanel's "Disable chat" button.
    await mainWindow.getByRole('button', { name: 'Disable chat' }).click()
    await mainWindow.getByRole('button', { name: 'Disable' }).click()

    await expect.poll(async () => {
      const list = await mainWindow.evaluate((id) => window.api.tabs.list(id), temp.id)
      return list.find((t) => t.isMain)?.displayMode
    }, { timeout: 5_000 }).toBe('xterm')

    // Task still alive
    await mainWindow.waitForTimeout(500)
    const tasksAfter = await mainWindow.evaluate(() => window.api.db.getTasks())
    expect(tasksAfter.some((t) => t.id === temp.id)).toBe(true)
  })

  test('temporary terminal task is removed from active task list when tab is closed', async ({ mainWindow, electronApp }) => {
    const s = seed(mainWindow)
    const temp = await s.createTask({
      projectId,
      title: 'Mode switch temporary auto-delete',
      status: 'in_progress',
      isTemporary: true,
      terminalMode: 'claude-code',
    })
    await s.refreshData()

    await openTaskTerminal(mainWindow, { projectAbbrev, taskTitle: 'Mode switch temporary auto-delete' })
    await sendAppShortcut(electronApp, 'app:close-active-task')

    await expect.poll(async () => {
      const activeTasks = await mainWindow.evaluate(() => window.api.db.getTasks())
      return !activeTasks.some((task) => task.id === temp.id)
    }, { timeout: 15_000 }).toBe(true)
  })
})
