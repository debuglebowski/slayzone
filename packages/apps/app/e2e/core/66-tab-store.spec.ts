import { test, expect, seed, goHome, clickProject, resetApp } from '../fixtures/electron'
import { TEST_PROJECT_PATH } from '../fixtures/electron'
import { pressShortcut } from '../fixtures/shortcuts'
import type { Page } from '@playwright/test'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function sendIPC(electronApp: any, channel: string): Promise<void> {
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

// Invoke the real menu item from the main process. The renderer consumes
// close-active-task via the tRPC `menu.onCloseActiveTask` subscription (fed by
// menuEvents); the legacy `app:close-active-task` webContents broadcast has no
// renderer consumer post slice-5, so `sendIPC` of it is a no-op.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function clickMenuItem(electronApp: any, labels: string[]): Promise<void> {
  await electronApp.evaluate(
    ({ Menu }: { Menu: typeof Electron.CrossProcessExports.Menu }, path: string[]) => {
      let items = Menu.getApplicationMenu()?.items ?? []
      let current: Electron.MenuItem | undefined
      for (const label of path) {
        current = items.find((item) => item.label === label)
        if (!current) throw new Error(`Menu item not found: ${label}`)
        items = current.submenu?.items ?? []
      }
      current?.click?.(undefined as never, undefined as never, undefined as never)
    },
    labels
  )
}

/** Read persisted viewState from settings */
async function getPersistedViewState(page: Page) {
  const raw = await page.evaluate(() =>
    window.getTrpcVanillaClient().settings.get.query({ key: 'viewState' })
  )
  return raw ? JSON.parse(raw) : null
}

/** Get the title shown in the visible task title input */
async function getVisibleTaskTitle(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const inputs = document.querySelectorAll<HTMLInputElement>('input')
    for (const input of inputs) {
      if (input.offsetParent !== null && input.value) return input.value
    }
    return null
  })
}

/** Open a task from kanban via search if not visible */
const openTaskViaSearch = async (page: Page, title: string) => {
  const card = page.getByText(title).first()
  if (await card.isVisible({ timeout: 1_500 }).catch(() => false)) {
    await card.click()
  } else {
    await pressShortcut(page, 'search')
    const input = page.getByPlaceholder('Search files, folders, commands, projects, and tasks...')
    await expect(input).toBeVisible({ timeout: 5_000 })
    await input.fill(title)
    await page.getByRole('dialog').last().getByText(title).first().click()
  }
  await expect(page.locator('[data-testid="terminal-mode-trigger"]:visible').first()).toBeVisible({
    timeout: 5_000
  })
}

test.describe('Tab store — persistence, sync, and side effects', () => {
  let projectId: string
  let projectAbbrev: string

  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
    const s = seed(mainWindow)
    const p = await s.createProject({
      name: 'TabStore Test',
      color: '#8b5cf6',
      path: TEST_PROJECT_PATH
    })
    projectId = p.id
    projectAbbrev = p.name.slice(0, 2).toUpperCase()

    await s.createTask({ projectId: p.id, title: 'TS task A', status: 'in_progress' })
    await s.createTask({ projectId: p.id, title: 'TS task B', status: 'in_progress' })
    await s.createTask({ projectId: p.id, title: 'TS task C', status: 'in_progress' })
    await s.refreshData()

    await goHome(mainWindow)
    await clickProject(mainWindow, projectAbbrev)
    await expect(mainWindow.getByText('TS task A').first()).toBeVisible({ timeout: 5_000 })
  })

  // ── 1. Cmd+Shift+T reopens closed tab ─────────────────────────────────
  // Uses evaluate to invoke reopenClosedTab directly (Meta+Shift+T is flaky
  // in Electron E2E due to native accelerator interception).

  test('reopenClosedTab restores last closed tab', async ({ mainWindow, electronApp }) => {
    // Open A and C
    await openTaskViaSearch(mainWindow, 'TS task A')
    await goHome(mainWindow)
    await openTaskViaSearch(mainWindow, 'TS task C')

    // Close C
    await sendIPC(electronApp, 'app:close-active-task')
    await expect(async () => {
      expect(await getVisibleTaskTitle(mainWindow)).not.toBe('TS task C')
    }).toPass({ timeout: 3_000 })

    // Invoke reopenClosedTab via the exposed store (Meta+Shift+T is flaky in E2E)
    await mainWindow.evaluate(() => {
      ;(window as any).__slayzone_tabStore?.getState()?.reopenClosedTab()
    })

    // Verify the store activated C, then wait for its terminal to render
    await expect(async () => {
      const activeTitle = await mainWindow.evaluate(() => {
        const store = (window as any).__slayzone_tabStore
        const state = store.getState()
        const tab = state.tabs[state.activeTabIndex]
        return tab?.title ?? null
      })
      expect(activeTitle).toBe('TS task C')
    }).toPass({ timeout: 3_000 })

    // Wait for the reopened task's content to become visible
    await expect(
      mainWindow.locator('[data-testid="terminal-mode-trigger"]:visible').first()
    ).toBeVisible({ timeout: 5_000 })
  })

  // ── 2. Tab auto-closes when task deleted ───────────────────────────────

  test('deleting task auto-removes its tab', async ({ mainWindow }) => {
    const s = seed(mainWindow)
    const throwaway = await s.createTask({
      projectId,
      title: 'TS throwaway',
      status: 'in_progress'
    })
    await s.refreshData()

    await goHome(mainWindow)
    await clickProject(mainWindow, projectAbbrev)
    await openTaskViaSearch(mainWindow, 'TS throwaway')
    await expect(mainWindow.getByText('TS throwaway').first()).toBeAttached()

    await s.deleteTask(throwaway.id)
    await s.refreshData()

    await expect(mainWindow.getByText('TS throwaway')).not.toBeAttached({ timeout: 5_000 })
  })

  // ── 3. Closing temp task tab deletes it from DB ────────────────────────

  test('closing temp task tab deletes it from DB', async ({ mainWindow, electronApp }) => {
    const s = seed(mainWindow)
    const temp = await mainWindow.evaluate(
      (d: any) => window.getTrpcVanillaClient().task.create.mutate(d),
      {
        projectId,
        title: 'TS temp task',
        status: 'in_progress',
        isTemporary: true
      }
    )
    await s.refreshData()

    // Keep A open so closing temp doesn't leave only home tab → window.close()
    await goHome(mainWindow)
    await clickProject(mainWindow, projectAbbrev)
    await openTaskViaSearch(mainWindow, 'TS task A')
    await goHome(mainWindow)
    await openTaskViaSearch(mainWindow, 'TS temp task')

    await clickMenuItem(electronApp, ['Window', 'Close Task'])

    await expect
      .poll(
        async () => {
          const tasks = await mainWindow.evaluate(() =>
            window.getTrpcVanillaClient().task.getAll.query()
          )
          return tasks.some((t: any) => t.id === temp.id)
        },
        { timeout: 10_000 }
      )
      .toBe(false)
  })

  // ── 4. Tab persistence across reload ───────────────────────────────────
  // Placed after mutation tests so reloads don't affect earlier test state.

  test('tabs persist across page reload', async ({ mainWindow }) => {
    await goHome(mainWindow)
    await clickProject(mainWindow, projectAbbrev)
    await openTaskViaSearch(mainWindow, 'TS task A')
    await goHome(mainWindow)
    await openTaskViaSearch(mainWindow, 'TS task B')

    await mainWindow.waitForTimeout(800)

    const before = await getPersistedViewState(mainWindow)
    expect(before).toBeTruthy()
    expect(before.tabs.filter((t: any) => t.type === 'task').length).toBeGreaterThanOrEqual(2)

    await mainWindow.reload({ waitUntil: 'domcontentloaded' })
    await mainWindow.waitForSelector('#root', { timeout: 10_000 })

    await expect(mainWindow.getByText('TS task A').first()).toBeAttached({ timeout: 8_000 })
    await expect(mainWindow.getByText('TS task B').first()).toBeAttached({ timeout: 3_000 })
  })

  // ── 5. Tab reorder persists across reload ──────────────────────────────

  test('tab reorder persists across reload', async ({ mainWindow }) => {
    // Ensure A and B are open (carried from test 4)
    await mainWindow.waitForTimeout(800)

    const before = await getPersistedViewState(mainWindow)
    const taskTabsBefore = before.tabs
      .filter((t: any) => t.type === 'task')
      .map((t: any) => t.title)
    expect(taskTabsBefore.length).toBeGreaterThanOrEqual(2)

    // Swap the first two task tabs
    const reordered = { ...before, tabs: [...before.tabs] }
    const taskIndices = reordered.tabs
      .map((t: any, i: number) => (t.type === 'task' ? i : -1))
      .filter((i: number) => i >= 0)
    if (taskIndices.length >= 2) {
      const [i, j] = taskIndices
      const tmp = reordered.tabs[i]
      reordered.tabs[i] = reordered.tabs[j]
      reordered.tabs[j] = tmp
    }
    await mainWindow.evaluate(
      (json: string) =>
        window.getTrpcVanillaClient().settings.set.mutate({ key: 'viewState', value: json }),
      JSON.stringify(reordered)
    )

    await mainWindow.reload({ waitUntil: 'domcontentloaded' })
    await mainWindow.waitForSelector('#root', { timeout: 10_000 })
    await mainWindow.waitForTimeout(500)

    const after = await getPersistedViewState(mainWindow)
    const taskTabsAfter = after.tabs.filter((t: any) => t.type === 'task').map((t: any) => t.title)
    expect(taskTabsAfter.length).toBeGreaterThanOrEqual(2)
    expect(taskTabsAfter[0]).toBe(taskTabsBefore[1])
    expect(taskTabsAfter[1]).toBe(taskTabsBefore[0])
  })
})
