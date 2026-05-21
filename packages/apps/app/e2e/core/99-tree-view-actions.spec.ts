import { test, expect, seed, resetApp, TEST_PROJECT_PATH } from '../fixtures/electron'
import type { Page } from '@playwright/test'

type TreePatch = Record<string, unknown>

async function patchStore(page: Page, patch: TreePatch) {
  await page.evaluate((p) => {
    const store = (
      window as unknown as { __slayzone_tabStore?: { setState: (s: unknown) => void } }
    ).__slayzone_tabStore
    if (!store) throw new Error('__slayzone_tabStore not exposed')
    store.setState(p)
  }, patch)
}

async function setTabs(page: Page, taskIds: string[]) {
  await page.evaluate((ids) => {
    const store = (
      window as unknown as { __slayzone_tabStore?: { setState: (s: unknown) => void } }
    ).__slayzone_tabStore
    if (!store) throw new Error('__slayzone_tabStore not exposed')
    const tabs: Array<{ type: 'home' } | { type: 'task'; taskId: string; title: string }> = [
      { type: 'home' }
    ]
    for (const id of ids) tabs.push({ type: 'task', taskId: id, title: 'tab' })
    store.setState({ tabs, activeTabIndex: 0 })
  }, taskIds)
}

async function ensureProjectExpanded(page: Page, projectName: string) {
  const trigger = page.getByRole('button', { name: `Expand ${projectName}` }).first()
  if (await trigger.isVisible({ timeout: 200 }).catch(() => false)) {
    await trigger.click({ force: true }).catch(() => {})
  }
}

async function killAllPtys(page: Page) {
  await page.evaluate(async () => {
    const list = await window.api.pty.list()
    for (const p of list) await window.api.pty.kill(p.sessionId).catch(() => {})
  })
}

function taskRow(page: Page, taskId: string) {
  return page.locator(`[data-sidebar-tree-item="task"][data-task-id="${taskId}"]`)
}

async function rightClickRow(page: Page, taskId: string) {
  const row = taskRow(page, taskId)
  await row.scrollIntoViewIfNeeded().catch(() => {})
  const box = await row.boundingBox()
  if (!box) throw new Error(`row bbox missing for ${taskId}`)
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: 'right' })
}

function menuItem(page: Page, name: RegExp | string) {
  return page.getByRole('menuitem', { name }).first()
}

function radioItem(page: Page, name: RegExp | string) {
  return page.getByRole('menuitemradio', { name }).first()
}

async function confirmAlert(page: Page, action: 'Delete' | 'Archive') {
  const dialog = page.getByRole('alertdialog')
  await expect(dialog).toBeVisible({ timeout: 3_000 })
  await dialog.getByRole('button', { name: action, exact: true }).click()
  await expect(dialog).toBeHidden({ timeout: 3_000 })
}

/** Hover a submenu trigger by its visible label. Radix only mounts nested
 * `ContextMenuSubContent` after the parent trigger is hovered. */
async function hoverSubmenu(page: Page, label: string) {
  const trigger = page.getByRole('menuitem', { name: label }).first()
  await trigger.waitFor({ state: 'visible', timeout: 3_000 })
  await trigger.hover()
  await page.waitForTimeout(150)
}

async function getTaskById(page: Page, id: string) {
  const tasks = await seed(page).getTasks()
  return tasks.find((t: { id: string }) => t.id === id)
}

test.describe('TreeView actions', () => {
  let projectId: string
  let otherProjectId: string
  const projectName = 'Tree Actions'
  const otherName = 'Tree Actions Other'

  // Reassigned every beforeEach (wipe + reseed).
  let rootA: string
  let rootB: string
  let rootC: string
  let rootD: string

  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
    const s = seed(mainWindow)
    const p = await s.createProject({
      name: projectName,
      color: '#9333ea',
      path: TEST_PROJECT_PATH
    })
    projectId = p.id
    const op = await s.createProject({ name: otherName, color: '#16a34a', path: TEST_PROJECT_PATH })
    otherProjectId = op.id
  })

  test.beforeEach(async ({ mainWindow }) => {
    await killAllPtys(mainWindow)

    // Wipe every task in both projects so each test starts identical.
    await mainWindow.evaluate(
      async ({ pid, oid }) => {
        const all = await window.api.db.getTasks()
        const ids = all
          .filter((t: { project_id: string }) => t.project_id === pid || t.project_id === oid)
          .map((t: { id: string }) => t.id)
        if (ids.length > 0) await window.api.db.deleteTasks(ids)
      },
      { pid: projectId, oid: otherProjectId }
    )

    const s = seed(mainWindow)
    rootA = (await s.createTask({ projectId, title: 'TA A', status: 'in_progress' })).id
    rootB = (await s.createTask({ projectId, title: 'TA B', status: 'in_progress' })).id
    rootC = (await s.createTask({ projectId, title: 'TA C', status: 'in_progress' })).id
    rootD = (await s.createTask({ projectId, title: 'TA D', status: 'in_progress' })).id
    await mainWindow.evaluate((ids) => window.api.db.reorderTasks([ids.a, ids.b, ids.c, ids.d]), {
      a: rootA,
      b: rootB,
      c: rootC,
      d: rootD
    })

    // Remount TreeView with a clean filter set.
    await patchStore(mainWindow, { sidebarView: 'projects' })
    await patchStore(mainWindow, {
      sidebarView: 'tree',
      selectedProjectId: projectId,
      treeStatusFilter: ['in_progress', 'todo', 'done'],
      treeShowSubtasks: true,
      treeShowAllSubtasks: false,
      treeShowOnlyActive: false,
      treeShowTemporary: true,
      treeCrossOutDone: false,
      treeShowStatus: false,
      treeShowPriority: false,
      treeShowWorktree: false,
      treeGroupBy: 'status',
      treeOrderBy: 'manual',
      treeOrderDir: 'asc',
      treeGroupTemporary: true,
      treeShowEmptyGroups: false
    })
    // Tree filters projects to those with open tabs / active session tasks.
    // Without at least one tab, the project doesn't render — pin rootA.
    await setTabs(mainWindow, [rootA])
    await s.refreshData()
    await ensureProjectExpanded(mainWindow, projectName)
    await expect(taskRow(mainWindow, rootA)).toBeVisible({ timeout: 5_000 })
    await expect(taskRow(mainWindow, rootB)).toBeVisible()
  })

  test('bulk delete via context menu removes all selected tasks', async ({ mainWindow }) => {
    await taskRow(mainWindow, rootA).click()
    await taskRow(mainWindow, rootB).click({ modifiers: ['Meta'] })
    await taskRow(mainWindow, rootC).click({ modifiers: ['Meta'] })

    await rightClickRow(mainWindow, rootB)
    await menuItem(mainWindow, /Delete 3 tasks/).click()
    await confirmAlert(mainWindow, 'Delete')

    await expect
      .poll(
        async () => {
          const all = await seed(mainWindow).getTasks()
          const ids = new Set(all.map((t: { id: string }) => t.id))
          return {
            hasA: ids.has(rootA),
            hasB: ids.has(rootB),
            hasC: ids.has(rootC),
            hasD: ids.has(rootD)
          }
        },
        { timeout: 5_000 }
      )
      .toEqual({ hasA: false, hasB: false, hasC: false, hasD: true })
  })

  test('bulk archive via context menu sets archived_at on all selected', async ({ mainWindow }) => {
    await taskRow(mainWindow, rootA).click()
    await taskRow(mainWindow, rootB).click({ modifiers: ['Meta'] })

    await rightClickRow(mainWindow, rootA)
    await menuItem(mainWindow, /Archive 2 tasks/).click()
    await confirmAlert(mainWindow, 'Archive')

    await expect
      .poll(
        async () => {
          const a = await getTaskById(mainWindow, rootA)
          const b = await getTaskById(mainWindow, rootB)
          const c = await getTaskById(mainWindow, rootC)
          return {
            aArchived: !!a?.archived_at,
            bArchived: !!b?.archived_at,
            cArchived: !!c?.archived_at
          }
        },
        { timeout: 5_000 }
      )
      .toEqual({ aArchived: true, bArchived: true, cArchived: false })
  })

  test('bulk status change via context menu submenu sets all selected to todo', async ({
    mainWindow
  }) => {
    await taskRow(mainWindow, rootA).click()
    await taskRow(mainWindow, rootB).click({ modifiers: ['Meta'] })
    await taskRow(mainWindow, rootC).click({ modifiers: ['Meta'] })

    await rightClickRow(mainWindow, rootA)
    await hoverSubmenu(mainWindow, 'Status')
    await radioItem(mainWindow, /Todo/).click()

    await expect
      .poll(
        async () => {
          const a = await getTaskById(mainWindow, rootA)
          const b = await getTaskById(mainWindow, rootB)
          const c = await getTaskById(mainWindow, rootC)
          return [a?.status, b?.status, c?.status]
        },
        { timeout: 5_000 }
      )
      .toEqual(['todo', 'todo', 'todo'])
  })

  test('bulk priority change via context menu submenu sets all selected to urgent', async ({
    mainWindow
  }) => {
    await taskRow(mainWindow, rootA).click()
    await taskRow(mainWindow, rootB).click({ modifiers: ['Meta'] })

    await rightClickRow(mainWindow, rootA)
    await hoverSubmenu(mainWindow, 'Priority')
    await radioItem(mainWindow, /Urgent/).click()

    await expect
      .poll(
        async () => {
          const a = await getTaskById(mainWindow, rootA)
          const b = await getTaskById(mainWindow, rootB)
          return [a?.priority, b?.priority]
        },
        { timeout: 5_000 }
      )
      .toEqual([1, 1])
  })

  test('bulk block toggle via context menu marks all selected blocked', async ({ mainWindow }) => {
    await taskRow(mainWindow, rootA).click()
    await taskRow(mainWindow, rootB).click({ modifiers: ['Meta'] })

    await rightClickRow(mainWindow, rootA)
    await menuItem(mainWindow, /^Block$/).click()

    await expect
      .poll(
        async () => {
          const a = await getTaskById(mainWindow, rootA)
          const b = await getTaskById(mainWindow, rootB)
          const c = await getTaskById(mainWindow, rootC)
          return [!!a?.is_blocked, !!b?.is_blocked, !!c?.is_blocked]
        },
        { timeout: 5_000 }
      )
      .toEqual([true, true, false])
  })

  test('bulk move-to-project via context menu reassigns all selected', async ({ mainWindow }) => {
    await taskRow(mainWindow, rootA).click()
    await taskRow(mainWindow, rootB).click({ modifiers: ['Meta'] })

    await rightClickRow(mainWindow, rootA)
    await hoverSubmenu(mainWindow, 'Move to')
    await radioItem(mainWindow, new RegExp(otherName)).click()

    await expect
      .poll(
        async () => {
          const a = await getTaskById(mainWindow, rootA)
          const b = await getTaskById(mainWindow, rootB)
          const c = await getTaskById(mainWindow, rootC)
          return [a?.project_id, b?.project_id, c?.project_id]
        },
        { timeout: 5_000 }
      )
      .toEqual([otherProjectId, otherProjectId, projectId])
  })

  test('single delete via context menu removes only that row', async ({ mainWindow }) => {
    await rightClickRow(mainWindow, rootB)
    await menuItem(mainWindow, /^Delete$/).click()
    await confirmAlert(mainWindow, 'Delete')

    await expect
      .poll(
        async () => {
          const all = await seed(mainWindow).getTasks()
          const ids = new Set(all.map((t: { id: string }) => t.id))
          return { hasA: ids.has(rootA), hasB: ids.has(rootB), hasC: ids.has(rootC) }
        },
        { timeout: 5_000 }
      )
      .toEqual({ hasA: true, hasB: false, hasC: true })
  })

  test('single archive via context menu sets archived_at only on that row', async ({
    mainWindow
  }) => {
    await rightClickRow(mainWindow, rootC)
    await menuItem(mainWindow, /^Archive$/).click()
    await confirmAlert(mainWindow, 'Archive')

    await expect
      .poll(
        async () => {
          const a = await getTaskById(mainWindow, rootA)
          const c = await getTaskById(mainWindow, rootC)
          return { aArchived: !!a?.archived_at, cArchived: !!c?.archived_at }
        },
        { timeout: 5_000 }
      )
      .toEqual({ aArchived: false, cArchived: true })
  })

  test('inline rename persists to DB and survives a data refresh', async ({ mainWindow }) => {
    const row = taskRow(mainWindow, rootB)
    await row.scrollIntoViewIfNeeded().catch(() => {})

    // Double-click the title text to enter edit mode.
    await row.getByText('TA B', { exact: true }).dblclick()
    const input = row.locator('input[type="text"]')
    await expect(input).toBeVisible({ timeout: 3_000 })

    // The row is a dnd-sortable <button> that owns this input, and an
    // unrelated autoFocus button (TerminalStarter) mounting in a background
    // tab can steal focus shortly after edit mode opens. Drive the whole
    // rename synchronously in one evaluate so nothing can interleave: set the
    // value via React's native setter + input event (React flushes the
    // controlled update for this discrete event before dispatchEvent returns),
    // then dispatch Enter — onKeyDown now closes over the new value and commits.
    await input.evaluate((el: HTMLInputElement) => {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value'
      )!.set!
      setter.call(el, 'TA B renamed')
      el.dispatchEvent(new Event('input', { bubbles: true }))
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })

    // Root cause: the new title must reach the DB, not just optimistic state.
    await expect
      .poll(async () => (await getTaskById(mainWindow, rootB))?.title, { timeout: 5_000 })
      .toBe('TA B renamed')

    // Reported symptom: a refresh reloaded stale rows and reverted the title.
    await seed(mainWindow).refreshData()
    await expect(row.getByText('TA B renamed', { exact: true })).toBeVisible({ timeout: 5_000 })
  })
})
