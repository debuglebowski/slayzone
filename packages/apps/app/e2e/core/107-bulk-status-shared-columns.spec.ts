import type { Page } from '@playwright/test'
import { test, expect, seed, resetApp, TEST_PROJECT_PATH } from '../fixtures/electron'

// The bulk context menu's Status submenu must offer only statuses EVERY selected
// task's project has. It used to fall back to the default statuses for a
// cross-project selection, so picking one a project lacks either demoted that
// task to its default column (old backend) or failed the whole batch (now).
test.describe('Bulk menu: cross-project status options', () => {
  // Shares only `todo` + `done` with the default columns (same labels on purpose,
  // so the expected submenu is unambiguous whichever project's labels win).
  const SUBSET_COLUMNS = [
    { id: 'todo', label: 'Todo', color: 'blue', position: 0, category: 'unstarted' as const },
    { id: 'doing', label: 'Doing', color: 'yellow', position: 1, category: 'started' as const },
    { id: 'done', label: 'Done', color: 'green', position: 2, category: 'completed' as const }
  ]
  // Shares nothing with the default columns.
  const DISJOINT_COLUMNS = [
    { id: 'queued', label: 'Queued', color: 'gray', position: 0, category: 'unstarted' as const },
    { id: 'closed', label: 'Closed', color: 'green', position: 1, category: 'completed' as const }
  ]
  const projectNames = ['Bulk Defaults', 'Bulk Subset', 'Bulk Disjoint']

  let defaultTask: string
  let subsetTask: string
  let disjointTask: string

  const taskRow = (page: Page, id: string) =>
    page.locator(`[data-sidebar-tree-item="task"][data-task-id="${id}"]`)

  const getTask = (page: Page, id: string) =>
    page.evaluate((i) => window.getTrpcVanillaClient().task.get.query({ id: i }), id)

  async function showTree(page: Page): Promise<void> {
    await page.evaluate(
      (taskIds) => {
        const store = (
          window as unknown as { __slayzone_tabStore?: { setState: (s: unknown) => void } }
        ).__slayzone_tabStore
        if (!store) throw new Error('__slayzone_tabStore not exposed')
        // Force a TreeView remount so the previous test's selection is gone.
        store.setState({ sidebarView: 'projects' })
        store.setState({
          sidebarView: 'tree',
          treeStatusFilter: ['todo', 'queued'],
          treeShowSubtasks: true,
          treeShowOnlyActive: false,
          treeShowTemporary: true,
          treeGroupBy: 'none',
          treeShowEmptyGroups: false,
          // The tree lists only projects that own an open task tab.
          tabs: [
            { type: 'home' },
            ...taskIds.map((taskId) => ({ type: 'task', taskId, title: 'tab' }))
          ],
          activeTabIndex: 0
        })
      },
      [defaultTask, subsetTask, disjointTask]
    )
    for (const name of projectNames) {
      const toggle = page.getByRole('button', { name: new RegExp(`^(Expand|Collapse) ${name}$`) })
      await expect(toggle.first()).toBeVisible({ timeout: 5_000 })
      const expand = page.getByRole('button', { name: `Expand ${name}`, exact: true }).first()
      if (await expand.isVisible().catch(() => false)) await expand.click({ force: true })
    }
  }

  async function openBulkStatusSubmenu(page: Page, ids: [string, string]) {
    await expect(taskRow(page, ids[0])).toBeVisible({ timeout: 5_000 })
    await expect(taskRow(page, ids[1])).toBeVisible({ timeout: 5_000 })
    await taskRow(page, ids[0]).click()
    await taskRow(page, ids[1]).click({ modifiers: ['Meta'] })
    await taskRow(page, ids[1]).click({ button: 'right' })
    const menu = page.getByRole('menu').filter({ hasText: '2 tasks selected' })
    await expect(menu).toBeVisible({ timeout: 5_000 })
    return menu.getByRole('menuitem', { name: 'Status' })
  }

  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
    const s = seed(mainWindow)
    const [defaults, subset, disjoint] = [
      await s.createProject({ name: projectNames[0], color: '#0ea5e9', path: TEST_PROJECT_PATH }),
      await s.createProject({ name: projectNames[1], color: '#22c55e', path: TEST_PROJECT_PATH }),
      await s.createProject({ name: projectNames[2], color: '#f97316', path: TEST_PROJECT_PATH })
    ]
    await s.updateProject({ id: subset.id, columnsConfig: SUBSET_COLUMNS })
    await s.updateProject({ id: disjoint.id, columnsConfig: DISJOINT_COLUMNS })
    defaultTask = (
      await s.createTask({ projectId: defaults.id, title: 'BS default', status: 'todo' })
    ).id
    subsetTask = (await s.createTask({ projectId: subset.id, title: 'BS subset', status: 'todo' }))
      .id
    disjointTask = (
      await s.createTask({ projectId: disjoint.id, title: 'BS disjoint', status: 'queued' })
    ).id
    await s.refreshData()
  })

  test.beforeEach(async ({ mainWindow }) => {
    await mainWindow.keyboard.press('Escape')
    await mainWindow.evaluate(
      async ({ a, b, c }) => {
        const client = window.getTrpcVanillaClient()
        await client.task.update.mutate({ id: a, status: 'todo' })
        await client.task.update.mutate({ id: b, status: 'todo' })
        await client.task.update.mutate({ id: c, status: 'queued' })
      },
      { a: defaultTask, b: subsetTask, c: disjointTask }
    )
    await seed(mainWindow).refreshData()
    await showTree(mainWindow)
  })

  test('offers only the statuses both projects have, and applies one to both', async ({
    mainWindow
  }) => {
    const status = await openBulkStatusSubmenu(mainWindow, [defaultTask, subsetTask])
    await status.hover()
    const options = mainWindow.getByRole('menuitemradio')
    await expect(options.first()).toBeVisible({ timeout: 5_000 })
    await expect(options).toHaveText(['Todo', 'Done'])

    await options.filter({ hasText: 'Done' }).click()
    await expect.poll(async () => (await getTask(mainWindow, defaultTask))?.status).toBe('done')
    await expect.poll(async () => (await getTask(mainWindow, subsetTask))?.status).toBe('done')
  })

  test('disables Status when the projects share no status', async ({ mainWindow }) => {
    const status = await openBulkStatusSubmenu(mainWindow, [defaultTask, disjointTask])
    await expect(status).toHaveAttribute('aria-disabled', 'true')
  })

  test('a batch the server rejects snaps back and says why', async ({
    mainWindow,
    electronApp
  }) => {
    const status = await openBulkStatusSubmenu(mainWindow, [defaultTask, subsetTask])
    await status.hover()
    await expect(mainWindow.getByRole('menuitemradio', { name: 'Done' })).toBeVisible()

    // Another client drops `done` from the subset project behind this window's back
    // (a raw DB write — no change notification), so the menu still offers it.
    const setSubsetColumns = (columns: unknown) =>
      electronApp.evaluate(
        async (_electron, { taskId, json }) => {
          const db = (globalThis as Record<string, unknown>).__db as {
            run: (sql: string, params?: unknown[]) => Promise<unknown>
          }
          await db.run(
            'UPDATE projects SET columns_config = ? WHERE id = (SELECT project_id FROM tasks WHERE id = ?)',
            [json, taskId]
          )
        },
        { taskId: subsetTask, json: JSON.stringify(columns) }
      )
    await setSubsetColumns(
      SUBSET_COLUMNS.filter((c) => c.id !== 'done').concat(DISJOINT_COLUMNS[1])
    )
    try {
      await mainWindow.getByRole('menuitemradio', { name: 'Done' }).click()
      await expect(mainWindow.getByText(/Couldn't update 2 tasks/)).toBeVisible({ timeout: 5_000 })
      expect((await getTask(mainWindow, defaultTask))?.status).toBe('todo')
      expect((await getTask(mainWindow, subsetTask))?.status).toBe('todo')
    } finally {
      await setSubsetColumns(SUBSET_COLUMNS)
    }
  })
})
