import type { Page } from '@playwright/test'
import { test, expect, seed, openTaskById, resetApp, TEST_PROJECT_PATH } from '../fixtures/electron'
import { pressShortcut } from '../fixtures/shortcuts'

// Undo of "Complete & Close Tab" (⌘⇧D) must put back everything the action did:
// the status AND the closed tab. For a temporary task the close also DELETES the
// task (scratch tasks have no home outside their tab), so undo must restore it —
// before the fix, undo only re-set the status on the soft-deleted row, toasted
// "Undid", and left the task gone.
test.describe('Complete & Close Tab: undo/redo', () => {
  type TabStoreWindow = Window & {
    __slayzone_tabStore?: {
      getState: () => {
        tabs: Array<{ type: string; taskId?: string }>
        activeTabIndex: number
        setActiveTabIndex: (index: number) => void
      }
    }
  }
  type Row = { status: string; deleted_at: string | null } | null

  let projectId: string

  const getTask = (page: Page, id: string) =>
    page.evaluate(
      (i) => window.getTrpcVanillaClient().task.get.query({ id: i }) as Promise<Row>,
      id
    )

  const tabState = (page: Page, taskId: string) =>
    page.evaluate((id) => {
      const s = (window as TabStoreWindow).__slayzone_tabStore!.getState()
      const index = s.tabs.findIndex((t) => t.type === 'task' && t.taskId === id)
      return index < 0 ? 'closed' : index === s.activeTabIndex ? 'active' : 'background'
    }, taskId)

  /**
   * Completes the active task. Undo goes by keyboard (`undo` below), not the
   * toast's Undo button: the toast auto-dismisses after sonner's 4s, which a
   * loaded box can spend before the dialog has even finished closing. The button
   * calls the same `undo.undo()` — covered by useCompleteAndCloseTask.test.tsx.
   */
  const completeActiveTask = async (page: Page) => {
    await pressShortcut(page, 'complete-close-tab')
    const dialog = page.locator('[data-slot="alert-dialog-content"]')
    await expect(dialog.getByText('Mark as complete and close tab?')).toBeVisible({
      timeout: 5_000
    })
    await dialog.getByRole('button', { name: 'Complete' }).click()
    await expect(dialog).not.toBeVisible({ timeout: 5_000 })
  }

  /**
   * ⌘Z/⌘⇧Z are ignored while focus sits in an input/editor/terminal, and a live
   * terminal takes focus back whenever it blurs to <body> (Terminal's focus
   * self-heal) — so with a restored scratch terminal on screen there's nowhere
   * neutral to park focus. Press from Home, as a user would: the task's terminal
   * is hidden there and can't reclaim it.
   */
  const pressFromHome = async (page: Page, shortcut: 'undo' | 'redo') => {
    await page.evaluate(() => {
      const s = (window as TabStoreWindow).__slayzone_tabStore!.getState()
      s.setActiveTabIndex(s.tabs.findIndex((t) => t.type === 'home'))
    })
    await expect
      .poll(
        () =>
          page.evaluate(() => {
            ;(document.activeElement as HTMLElement | null)?.blur()
            return !!document.activeElement?.closest('.xterm')
          }),
        poll
      )
      .toBe(false)
    await pressShortcut(page, shortcut)
  }
  const undo = (page: Page) => pressFromHome(page, 'undo')
  const redo = (page: Page) => pressFromHome(page, 'redo')

  const poll = { timeout: 10_000, intervals: [250, 500, 1_000] }

  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
    const p = await seed(mainWindow).createProject({
      name: 'Complete Undo',
      color: '#22c55e',
      path: TEST_PROJECT_PATH
    })
    projectId = p.id
  })

  test('undo restores the status and reopens the tab; redo completes + closes again', async ({
    mainWindow
  }) => {
    const s = seed(mainWindow)
    const task = await s.createTask({
      projectId,
      title: 'CU regular task',
      status: 'in_progress',
      agentId: 'terminal'
    })
    await s.refreshData()
    await openTaskById(mainWindow, task.id)

    await completeActiveTask(mainWindow)
    await expect.poll(async () => (await getTask(mainWindow, task.id))?.status, poll).toBe('done')
    await expect.poll(() => tabState(mainWindow, task.id), poll).toBe('closed')

    await undo(mainWindow)
    await expect
      .poll(async () => (await getTask(mainWindow, task.id))?.status, poll)
      .toBe('in_progress')
    await expect.poll(() => tabState(mainWindow, task.id), poll).toBe('active')

    await redo(mainWindow)
    await expect.poll(async () => (await getTask(mainWindow, task.id))?.status, poll).toBe('done')
    await expect.poll(() => tabState(mainWindow, task.id), poll).toBe('closed')
  })

  test('undo of a scratch terminal reverts completion and reopens its preserved tab', async ({
    mainWindow
  }) => {
    const s = seed(mainWindow)
    const task = await s.createTask({
      projectId,
      title: 'CU temporary task',
      status: 'in_progress',
      isTemporary: true,
      agentId: 'terminal'
    })
    await s.refreshData()
    await openTaskById(mainWindow, task.id)

    // Completing closes the view and preserves the scratch terminal.
    await completeActiveTask(mainWindow)
    await expect
      .poll(async () => !!(await getTask(mainWindow, task.id))?.deleted_at, poll)
      .toBe(false)
    await expect.poll(() => tabState(mainWindow, task.id), poll).toBe('closed')

    await undo(mainWindow)
    await expect
      .poll(async () => (await getTask(mainWindow, task.id))?.deleted_at ?? null, poll)
      .toBeNull()
    await expect
      .poll(async () => (await getTask(mainWindow, task.id))?.status, poll)
      .toBe('in_progress')
    await expect.poll(() => tabState(mainWindow, task.id), poll).toBe('active')
    // The restored task is back on the board data the rest of the app reads.
    await expect
      .poll(
        () =>
          mainWindow.evaluate(
            (id) =>
              window
                .getTrpcVanillaClient()
                .task.getAll.query()
                .then((all: Array<{ id: string }>) => all.some((t) => t.id === id)),
            task.id
          ),
        poll
      )
      .toBe(true)

    // Redo completes it again and closes only the view.
    await redo(mainWindow)
    await expect
      .poll(async () => !!(await getTask(mainWindow, task.id))?.deleted_at, poll)
      .toBe(false)
    await expect.poll(() => tabState(mainWindow, task.id), poll).toBe('closed')
  })
})
