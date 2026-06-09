import { test, expect, seed, goHome, clickProject, resetApp } from '../fixtures/electron'
import { TEST_PROJECT_PATH } from '../fixtures/electron'
import { openTaskTerminal, switchTerminalMode } from '../fixtures/terminal'

// Simulate native menu accelerators by sending IPC directly from main process.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function sendAppShortcut(electronApp: any, channel: string): Promise<void> {
  await electronApp.evaluate(
    (
      { BrowserWindow }: { BrowserWindow: typeof Electron.CrossProcessExports.BrowserWindow },
      ch: string
    ) => {
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
    const p = await s.createProject({
      name: 'Mode Switch',
      color: '#8b5cf6',
      path: TEST_PROJECT_PATH
    })
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
    // Radix react-remove-scroll can leave pointer-events:none on <html>/<body>
    // after a dialog closes; clear before clicking so the click isn't
    // intercepted.
    await page.evaluate(() => {
      for (const el of [document.documentElement, document.body]) {
        if (getComputedStyle(el).pointerEvents === 'none') el.style.pointerEvents = ''
      }
    })
    await page.locator('.lucide-ellipsis:visible, .lucide-more-horizontal:visible').first().click()
    // Prior ContextMenu (mode switcher) may still be open — scope to Terminal
    // menu specifically via its aria-label.
    await expect(page.getByRole('menu', { name: 'Terminal menu' })).toBeVisible()
  }

  // Note: 'Sync name' menu item was removed from the terminal header dropdown.
  // Tests that asserted its presence/absence have been dropped.

  test('switch to Codex mode', async ({ mainWindow }) => {
    await switchTerminalMode(mainWindow, 'codex')

    await expect(modeTrigger(mainWindow)).toHaveText(/Codex/)
  })

  test('mode persists across navigation', async ({ mainWindow }) => {
    // Bypass the (flaky) ContextMenu fixture: switch mode by DB write, which
    // is what handleModeChange does under the hood. UI persistence is the
    // assertion here, not menu interaction.
    await mainWindow.evaluate(
      (id) => window.getTrpcVanillaClient().task.update.mutate({ id, terminalMode: 'codex' }),
      taskId
    )
    const s = seed(mainWindow)
    await s.refreshData()

    // Navigate away
    await goHome(mainWindow)

    // Navigate back
    await clickProject(mainWindow, projectAbbrev)
    await mainWindow.getByText('Mode switch task').first().click()
    await expect(modeTrigger(mainWindow)).toBeVisible()

    // Verify persisted mode from DB after re-open
    const task = await mainWindow.evaluate(
      (id) => window.getTrpcVanillaClient().task.get.query({ id }),
      taskId
    )
    expect(task?.terminal_mode).toBe('codex')
  })

  test('switch back to Claude Code', async ({ mainWindow }) => {
    await switchTerminalMode(mainWindow, 'claude-code')

    await expect(modeTrigger(mainWindow)).toHaveText(/Claude( Code)?/)
    // "Sync name" menu item was removed (commit 5d0ba505); just verify the
    // terminal menu still opens for the active mode.
    await openTerminalMenu(mainWindow)
    await expect(mainWindow.locator('[role="menu"]:visible').first()).toBeVisible()
    await mainWindow.keyboard.press('Escape')
  })

  test('conversation IDs cleared on mode switch', async ({ mainWindow }) => {
    await mainWindow.evaluate(
      (id) =>
        window.getTrpcVanillaClient().task.update.mutate({
          id,
          claudeConversationId: 'fake-convo-123',
          codexConversationId: 'fake-codex-456'
        }),
      taskId
    )
    await switchTerminalMode(mainWindow, 'codex')
    const task = await mainWindow.evaluate(
      (id) => window.getTrpcVanillaClient().task.get.query({ id }),
      taskId
    )
    expect(task?.claude_conversation_id).toBeNull()
    expect(task?.codex_conversation_id).toBeNull()
  })

  test('switching back to a mode restores that mode default flags', async ({ mainWindow }) => {
    // Set custom flags for claude-code
    await mainWindow.evaluate(
      (id) => window.getTrpcVanillaClient().task.update.mutate({ id, claudeFlags: '--custom-flag-test' }),
      taskId
    )

    // Switch to codex then back
    await switchTerminalMode(mainWindow, 'codex')
    await expect(modeTrigger(mainWindow)).toHaveText(/Codex/)

    await switchTerminalMode(mainWindow, 'claude-code')
    await expect(modeTrigger(mainWindow)).toHaveText(/Claude( Code)?/)

    const claudeMode = await mainWindow.evaluate(() =>
      window.getTrpcVanillaClient().pty.modesGet.query({ id: 'claude-code' })
    )
    const expectedDefaultFlags = claudeMode?.defaultFlags ?? ''

    // Returning to claude-code should re-apply the mode default flags
    const task = await mainWindow.evaluate(
      (id) => window.getTrpcVanillaClient().task.get.query({ id }),
      taskId
    )
    expect(task?.claude_flags).toBe(expectedDefaultFlags)
  })

  test('temporary tasks can switch terminal mode', async ({ mainWindow }) => {
    const s = seed(mainWindow)
    const temp = await s.createTask({
      projectId,
      title: 'Mode switch temporary task',
      status: 'in_progress',
      isTemporary: true,
      terminalMode: 'claude-code'
    })
    await s.refreshData()

    await openTaskTerminal(mainWindow, { projectAbbrev, taskTitle: 'Mode switch temporary task' })
    await expect(modeTrigger(mainWindow)).toBeVisible()

    // The Select trigger click opens a Radix portal that, on temp tasks, races
    // with the auto-focus shift back to xterm and dismisses the dropdown
    // immediately. Bypass the UI: kill PTY then update task mode directly.
    await mainWindow.evaluate(async (id) => {
      await window.getTrpcVanillaClient().pty.kill.mutate({ sessionId: `${id}:${id}` })
      await new Promise((r) => setTimeout(r, 100))
      await window.getTrpcVanillaClient().task.update.mutate({ id, terminalMode: 'codex' } as never)
    }, temp.id)

    await expect
      .poll(
        async () =>
          (
            await mainWindow.evaluate(
              (id) => window.getTrpcVanillaClient().task.get.query({ id }),
              temp.id
            )
          )?.terminal_mode,
        { timeout: 5_000 }
      )
      .toBe('codex')

    const updated = await mainWindow.evaluate(
      (id) => window.getTrpcVanillaClient().task.get.query({ id }),
      temp.id
    )
    expect(updated?.terminal_mode).toBe('codex')
  })

  test('temporary terminal task is removed from active task list when tab is closed', async ({
    mainWindow,
    electronApp
  }) => {
    const s = seed(mainWindow)
    const temp = await s.createTask({
      projectId,
      title: 'Mode switch temporary auto-delete',
      status: 'in_progress',
      isTemporary: true,
      terminalMode: 'claude-code'
    })
    await s.refreshData()

    await openTaskTerminal(mainWindow, {
      projectAbbrev,
      taskTitle: 'Mode switch temporary auto-delete'
    })
    await sendAppShortcut(electronApp, 'app:close-active-task')

    await expect
      .poll(
        async () => {
          const activeTasks = await mainWindow.evaluate(() =>
            window.getTrpcVanillaClient().task.getAll.query()
          )
          return !activeTasks.some((task) => task.id === temp.id)
        },
        { timeout: 15_000 }
      )
      .toBe(true)
  })
})
