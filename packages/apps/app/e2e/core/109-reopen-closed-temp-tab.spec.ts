import type { ElectronApplication, Page } from '@playwright/test'
import { test, expect, seed, openTaskById, resetApp, TEST_PROJECT_PATH } from '../fixtures/electron'
import { pressShortcut } from '../fixtures/shortcuts'

// ⌘⇧T reopens the last closed tab. Closing a temporary task's tab DELETES the task
// (scratch terminals have no home outside their tab), so reopening one has to
// restore the task first. Before, a temporary tab never made it onto the reopen
// stack at all, so ⌘⇧T skipped straight past it.
test.describe('Reopen closed temporary tab (⌘⇧T)', () => {
  type TabStoreWindow = Window & {
    __slayzone_tabStore?: {
      getState: () => {
        tabs: Array<{ type: string; taskId?: string; isTemporary?: boolean }>
        activeTabIndex: number
      }
    }
  }
  type Row = { deleted_at: string | null } | null

  let projectId: string

  const getTask = (page: Page, id: string) =>
    page.evaluate(
      (i) => window.getTrpcVanillaClient().task.get.query({ id: i }) as Promise<Row>,
      id
    )

  const isDeleted = async (page: Page, id: string) => !!(await getTask(page, id))?.deleted_at

  const tabState = (page: Page, taskId: string) =>
    page.evaluate((id) => {
      const s = (window as TabStoreWindow).__slayzone_tabStore!.getState()
      const index = s.tabs.findIndex((t) => t.type === 'task' && t.taskId === id)
      if (index < 0) return 'closed'
      const kind = s.tabs[index].isTemporary ? 'temporary' : 'regular'
      return `${index === s.activeTabIndex ? 'active' : 'background'} ${kind}`
    }, taskId)

  /** The real Window → Close Task menu item — the same close path ⌘W takes. */
  const closeActiveTab = (electronApp: ElectronApplication) =>
    electronApp.evaluate(({ Menu }) => {
      const window = Menu.getApplicationMenu()?.items.find((i) => i.label === 'Window')
      const item = window?.submenu?.items.find((i) => i.label === 'Close Task')
      if (!item) throw new Error('Menu item not found: Window → Close Task')
      item.click(undefined as never, undefined as never, undefined as never)
    })

  /** ⌘⇧T is a global shortcut; park focus on body so no editor/terminal eats it. */
  const reopen = async (page: Page) => {
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
    await pressShortcut(page, 'reopen-closed-tab')
  }

  const ptyAlive = (page: Page, taskId: string) =>
    page.evaluate(
      (id) => window.getTrpcVanillaClient().pty.exists.query({ sessionId: `${id}:${id}` }),
      taskId
    )

  const poll = { timeout: 10_000, intervals: [250, 500, 1_000] }

  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
    const p = await seed(mainWindow).createProject({
      name: 'Reopen Temp',
      color: '#0ea5e9',
      path: TEST_PROJECT_PATH
    })
    projectId = p.id
  })

  test('restores the deleted temporary task, reopens its tab, and respawns its terminal', async ({
    mainWindow,
    electronApp
  }) => {
    const s = seed(mainWindow)
    const task = await s.createTask({
      projectId,
      title: 'RT scratch',
      status: 'in_progress',
      isTemporary: true,
      terminalMode: 'terminal'
    })
    await s.refreshData()
    await openTaskById(mainWindow, task.id)
    await expect.poll(() => ptyAlive(mainWindow, task.id), poll).toBe(true)

    await closeActiveTab(electronApp)
    await expect.poll(() => isDeleted(mainWindow, task.id), poll).toBe(true)
    await expect.poll(() => tabState(mainWindow, task.id), poll).toBe('closed')
    await expect.poll(() => ptyAlive(mainWindow, task.id), poll).toBe(false)

    await reopen(mainWindow)
    await expect.poll(() => isDeleted(mainWindow, task.id), poll).toBe(false)
    await expect.poll(() => tabState(mainWindow, task.id), poll).toBe('active temporary')
    // Scratch terminals always auto-start, so the reopened tab is a live terminal again.
    await expect.poll(() => ptyAlive(mainWindow, task.id), poll).toBe(true)
    // Back on the board data the rest of the app reads — not just in the tab bar.
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

    // Still a scratch terminal: closing it again deletes it again.
    await closeActiveTab(electronApp)
    await expect.poll(() => isDeleted(mainWindow, task.id), poll).toBe(true)
    await expect.poll(() => tabState(mainWindow, task.id), poll).toBe('closed')
  })

  test('reopens in close order across temporary and regular tabs', async ({
    mainWindow,
    electronApp
  }) => {
    const s = seed(mainWindow)
    const regular = await s.createTask({
      projectId,
      title: 'RT regular',
      status: 'in_progress',
      terminalMode: 'terminal'
    })
    const temp = await s.createTask({
      projectId,
      title: 'RT scratch 2',
      status: 'in_progress',
      isTemporary: true,
      terminalMode: 'terminal'
    })
    await s.refreshData()

    await openTaskById(mainWindow, regular.id)
    await closeActiveTab(electronApp)
    await expect.poll(() => tabState(mainWindow, regular.id), poll).toBe('closed')
    await openTaskById(mainWindow, temp.id)
    await closeActiveTab(electronApp)
    await expect.poll(() => isDeleted(mainWindow, temp.id), poll).toBe(true)

    // Last closed first: the temporary tab…
    await reopen(mainWindow)
    await expect.poll(() => tabState(mainWindow, temp.id), poll).toBe('active temporary')
    expect(await tabState(mainWindow, regular.id)).toBe('closed')

    // …then the regular tab closed before it.
    await reopen(mainWindow)
    await expect.poll(() => tabState(mainWindow, regular.id), poll).toBe('active regular')
    expect(await tabState(mainWindow, temp.id)).toBe('background temporary')
  })
})
