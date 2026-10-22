import type { Page } from '@playwright/test'
import { test, expect, seed, openTaskById, resetApp, TEST_PROJECT_PATH } from '../fixtures/electron'
import {
  readFullBuffer,
  runCommand,
  waitForBufferContains,
  waitForPtySession
} from '../fixtures/terminal'

// ⌘Z / ⌘⇧Z run the app's task undo/redo even while a terminal has focus. A task's
// live terminal holds focus almost permanently (it reclaims it whenever it blurs
// to <body>), so the old "skip when the target is an xterm" guard made task
// undo/redo unreachable from any task with a running terminal. xterm sends the
// shell nothing for ⌘+letter, so there's nothing in the terminal to defer to.
// macOS only: elsewhere mod+Z is Ctrl+Z, which in a terminal is the shell's.
test.describe('Undo/redo from a focused terminal (⌘Z / ⌘⇧Z)', () => {
  test.skip(process.platform !== 'darwin', '⌘ is macOS; elsewhere mod+Z is the shell’s Ctrl+Z')

  type TabStoreWindow = Window & {
    __slayzone_tabStore?: {
      getState: () => {
        tabs: Array<{ type: string; taskId?: string }>
        setActiveTabIndex: (index: number) => void
      }
    }
  }

  let projectId: string

  const status = (page: Page, id: string) =>
    page.evaluate(
      (i) =>
        (
          window.getTrpcVanillaClient().task.get.query({ id: i }) as Promise<{
            status: string
          } | null>
        ).then((t) => t?.status ?? null),
      id
    )

  const focusInTerminal = (page: Page) =>
    page.evaluate(() => !!document.activeElement?.closest('.xterm'))

  /** Activate an open task's tab, then put focus in its terminal the way a user would. */
  const focusTerminalOf = async (page: Page, taskId: string) => {
    await page.evaluate((id) => {
      const s = (window as TabStoreWindow).__slayzone_tabStore!.getState()
      s.setActiveTabIndex(s.tabs.findIndex((t) => t.type === 'task' && t.taskId === id))
    }, taskId)
    await page.locator('.xterm:visible').first().click()
    await expect.poll(() => focusInTerminal(page), poll).toBe(true)
  }

  const poll = { timeout: 10_000, intervals: [250, 500, 1_000] }

  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
    const p = await seed(mainWindow).createProject({
      name: 'Terminal Undo',
      color: '#a855f7',
      path: TEST_PROJECT_PATH
    })
    projectId = p.id
  })

  test('undoes and redoes a task action while a scratch terminal has focus', async ({
    mainWindow: page
  }) => {
    const s = seed(page)
    const task = await s.createTask({
      projectId,
      title: 'TU regular',
      status: 'in_progress',
      terminalMode: 'terminal'
    })
    const scratch = await s.createTask({
      projectId,
      title: 'TU scratch',
      status: 'in_progress',
      isTemporary: true,
      terminalMode: 'terminal'
    })
    await s.refreshData()

    // An undoable task action: Complete & Close Tab.
    await openTaskById(page, task.id)
    await page.keyboard.press('Meta+Shift+d')
    const dialog = page.locator('[data-slot="alert-dialog-content"]')
    await expect(dialog.getByText('Mark as complete and close tab?')).toBeVisible({
      timeout: 5_000
    })
    await dialog.getByRole('button', { name: 'Complete' }).click()
    await expect.poll(() => status(page, task.id), poll).toBe('done')

    await openTaskById(page, scratch.id)
    // `cat -v` in the scratch terminal shows anything the keys send the shell.
    const sessionId = `${scratch.id}:${scratch.id}`
    await waitForPtySession(page, sessionId)
    await runCommand(page, sessionId, 'cat -v')
    await runCommand(page, sessionId, 'TU-BEFORE')
    await waitForBufferContains(page, sessionId, 'TU-BEFORE')

    await focusTerminalOf(page, scratch.id)
    await page.keyboard.press('Meta+z')
    await expect.poll(() => status(page, task.id), poll).toBe('in_progress')

    // Undo reopened the completed task's tab; back into the scratch terminal.
    await focusTerminalOf(page, scratch.id)
    await page.keyboard.press('Meta+Shift+z')
    await expect.poll(() => status(page, task.id), poll).toBe('done')

    // Neither key reached the shell: no ^Z (suspend) or escape sequence, and
    // `cat` is still the foreground program reading input.
    await runCommand(page, sessionId, 'TU-AFTER')
    await waitForBufferContains(page, sessionId, 'TU-AFTER')
    const buffer = await readFullBuffer(page, sessionId)
    const between = buffer.slice(buffer.indexOf('TU-BEFORE'), buffer.lastIndexOf('TU-AFTER'))
    expect(between).not.toMatch(/\^Z|\^\[|suspended|not found/)
  })
})
