import { test, expect, seed, resetApp, TEST_PROJECT_PATH } from '../fixtures/electron'
import { getMainSessionId, waitForPtySession } from '../fixtures/terminal'
import type { Page } from '@playwright/test'

/**
 * Opening a task is a React transition (App `openTask` → `startTransition`, plus
 * `useDeferredValue` in TabPanes), so the tab swap can commit AFTER input the user
 * gave later. A double-click on a tree title is exactly that: its first click
 * opens the task, the double-click opens the inline rename, and when the swap
 * commits afterwards the activated tab focused its terminal — blurring the rename
 * input, whose blur commits and closes it. Under full-suite load that closed
 * spec 99's rename in two runs in a row (2026-10-29).
 *
 * Deterministic stand-in for the late commit: with the rename open, activate a
 * task tab that has a live terminal. The activation must not take focus from a
 * text field the user moved into after their last gesture.
 */

async function patchStore(page: Page, patch: Record<string, unknown>) {
  await page.evaluate((p) => {
    const store = (
      window as unknown as { __slayzone_tabStore?: { setState: (s: unknown) => void } }
    ).__slayzone_tabStore
    if (!store) throw new Error('__slayzone_tabStore not exposed')
    store.setState(p)
  }, patch)
}

function taskRow(page: Page, taskId: string) {
  return page.locator(`[data-sidebar-tree-item="task"][data-task-id="${taskId}"]`)
}

async function terminalShown(page: Page, taskId: string) {
  await expect(
    page.locator(`[data-session-id="${getMainSessionId(taskId)}"] .xterm:visible`).first()
  ).toBeVisible({ timeout: 10_000 })
}

test.describe('Tree rename vs a late tab activation', () => {
  let terminalTask: string
  let renamedTask: string

  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
    const s = seed(mainWindow)
    const p = await s.createProject({
      name: 'Late Activation',
      color: '#0ea5e9',
      path: TEST_PROJECT_PATH
    })
    terminalTask = (
      await s.createTask({
        projectId: p.id,
        title: 'LA terminal',
        status: 'in_progress',
        terminalMode: 'terminal'
      })
    ).id
    renamedTask = (
      await s.createTask({ projectId: p.id, title: 'LA rename', status: 'in_progress' })
    ).id

    // Open the terminal task once so its pty is live, then go back home: it stays
    // mounted hidden, ready to be activated.
    await patchStore(mainWindow, {
      tabs: [{ type: 'home' }, { type: 'task', taskId: terminalTask, title: 'tab' }],
      activeTabIndex: 1
    })
    await s.refreshData()
    await waitForPtySession(mainWindow, getMainSessionId(terminalTask))
    await terminalShown(mainWindow, terminalTask)
    await patchStore(mainWindow, { activeTabIndex: 0 })

    await patchStore(mainWindow, {
      sidebarView: 'tree',
      selectedProjectId: p.id,
      treeStatusFilter: ['in_progress', 'todo', 'done'],
      treeShowOnlyActive: false,
      treeGroupBy: 'none',
      treeOrderBy: 'manual'
    })
    const expand = mainWindow.getByRole('button', { name: 'Expand Late Activation' }).first()
    if (await expand.isVisible({ timeout: 500 }).catch(() => false)) await expand.click()
    await expect(taskRow(mainWindow, renamedTask)).toBeVisible({ timeout: 5_000 })
  })

  test('activating a task tab mid-rename leaves the rename focused and committable', async ({
    mainWindow
  }) => {
    const row = taskRow(mainWindow, renamedTask)
    await row.getByText('LA rename', { exact: true }).dblclick()
    const input = row.locator('input[type="text"]')
    await expect(input).toBeVisible({ timeout: 3_000 })
    await expect(input).toBeFocused()

    // The late commit: the terminal task's tab activates while the rename is open.
    await mainWindow.evaluate((taskId) => {
      const store = (
        window as unknown as {
          __slayzone_tabStore: {
            getState: () => { tabs: Array<{ type: string; taskId?: string }> }
            setState: (s: unknown) => void
          }
        }
      ).__slayzone_tabStore
      const index = store.getState().tabs.findIndex((t) => t.taskId === taskId)
      if (index < 0) throw new Error('terminal task tab not open')
      store.setState({ activeTabIndex: index })
    }, terminalTask)
    await terminalShown(mainWindow, terminalTask)
    // Let the activation's focus effect and any attach run.
    await mainWindow.evaluate(
      () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(null))))
    )
    await mainWindow.waitForTimeout(300)

    await expect(input, 'the rename is still open').toBeVisible()
    await expect(input, 'and still has focus').toBeFocused()

    // The input lives inside the dnd-sortable row <button> (aria-disabled while
    // editing), which Playwright's fill() treats as disabled. Commit the way
    // spec 99 does: React's native value setter + input event, then Enter.
    await input.evaluate((el: HTMLInputElement) => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      setter.call(el, 'LA renamed')
      el.dispatchEvent(new Event('input', { bubbles: true }))
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })
    await expect
      .poll(
        async () =>
          (await seed(mainWindow).getTasks()).find((t: { id: string }) => t.id === renamedTask)
            ?.title,
        { timeout: 5_000 }
      )
      .toBe('LA renamed')
  })
})
