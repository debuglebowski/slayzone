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

async function getSelectedIds(page: Page, taskIds: string[]): Promise<string[]> {
  const selected: string[] = []
  for (const id of taskIds) {
    const isSelected = await page.evaluate((tid) => {
      const el = document.querySelector(`[data-sidebar-tree-item="task"][data-task-id="${tid}"]`)
      return el?.getAttribute('data-selected') === 'true'
    }, id)
    if (isSelected) selected.push(id)
  }
  return selected
}

async function getTabTaskIds(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const store = (
      window as unknown as {
        __slayzone_tabStore?: { getState: () => { tabs: Array<{ type: string; taskId?: string }> } }
      }
    ).__slayzone_tabStore
    if (!store) return []
    return store
      .getState()
      .tabs.filter((t) => t.type === 'task')
      .map((t) => t.taskId!)
  })
}

test.describe('TreeView multi-select', () => {
  let projectId: string
  const projectName = 'Tree Multi-Select'

  let rootA: string
  let rootB: string
  let rootC: string
  let rootTodo: string
  let subA1: string
  let subA2: string
  let subA3: string

  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
    const s = seed(mainWindow)
    const p = await s.createProject({
      name: projectName,
      color: '#9333ea',
      path: TEST_PROJECT_PATH
    })
    projectId = p.id

    rootA = (await s.createTask({ projectId, title: 'MS A', status: 'in_progress' })).id
    rootB = (await s.createTask({ projectId, title: 'MS B', status: 'in_progress' })).id
    rootC = (await s.createTask({ projectId, title: 'MS C', status: 'in_progress' })).id
    rootTodo = (await s.createTask({ projectId, title: 'MS Todo', status: 'todo' })).id

    subA1 = (await mainWindow.evaluate(
      ({ pid, parentId }) =>
        window.api.db.createTask({
          projectId: pid,
          title: 'MS Sub A1',
          status: 'in_progress',
          parentId
        }),
      { pid: projectId, parentId: rootA }
    ))!.id
    subA2 = (await mainWindow.evaluate(
      ({ pid, parentId }) =>
        window.api.db.createTask({
          projectId: pid,
          title: 'MS Sub A2',
          status: 'in_progress',
          parentId
        }),
      { pid: projectId, parentId: rootA }
    ))!.id
    subA3 = (await mainWindow.evaluate(
      ({ pid, parentId }) =>
        window.api.db.createTask({
          projectId: pid,
          title: 'MS Sub A3',
          status: 'in_progress',
          parentId
        }),
      { pid: projectId, parentId: rootA }
    ))!.id

    await s.refreshData()
  })

  test.beforeEach(async ({ mainWindow }) => {
    await killAllPtys(mainWindow)
    // Force TreeView remount so selection state resets between tests.
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
    await setTabs(mainWindow, [rootA])
    await seed(mainWindow).refreshData()
    await ensureProjectExpanded(mainWindow, projectName)
    await killAllPtys(mainWindow)
    // Reset task order/status so each test is independent.
    await mainWindow.evaluate(
      async ({ a, b, c, todo, s1, s2, s3 }) => {
        await window.api.db.updateTasks({
          ids: [a, b, c, s1, s2, s3],
          updates: { status: 'in_progress' }
        })
        await window.api.db.updateTasks({ ids: [todo], updates: { status: 'todo' } })
        await window.api.db.reorderTasks([a, b, c])
        await window.api.db.reorderTasks([s1, s2, s3])
      },
      { a: rootA, b: rootB, c: rootC, todo: rootTodo, s1: subA1, s2: subA2, s3: subA3 }
    )
    await seed(mainWindow).refreshData()
    await expect(taskRow(mainWindow, rootA)).toBeVisible({ timeout: 5_000 })
    await expect(taskRow(mainWindow, rootB)).toBeVisible()
    await expect(taskRow(mainWindow, rootC)).toBeVisible()
  })

  test('plain click selects only the clicked row and opens the task', async ({ mainWindow }) => {
    await taskRow(mainWindow, rootB).click()

    await expect
      .poll(() => getSelectedIds(mainWindow, [rootA, rootB, rootC]), { timeout: 3_000 })
      .toEqual([rootB])

    // Opening the task adds it to the tab list.
    await expect.poll(() => getTabTaskIds(mainWindow), { timeout: 3_000 }).toContain(rootB)
  })

  test('cmd+click adds row to selection without opening a tab', async ({ mainWindow }) => {
    // Anchor with plain click on A (also opens A's tab — already in tabs).
    await taskRow(mainWindow, rootA).click()
    const tabsBefore = await getTabTaskIds(mainWindow)

    // Cmd-click on B → both A and B selected; B does NOT open.
    await taskRow(mainWindow, rootB).click({ modifiers: ['Meta'] })

    await expect
      .poll(() => getSelectedIds(mainWindow, [rootA, rootB, rootC]), { timeout: 3_000 })
      .toEqual([rootA, rootB])

    const tabsAfter = await getTabTaskIds(mainWindow)
    expect(tabsAfter).toEqual(tabsBefore)
    expect(tabsAfter).not.toContain(rootB)
  })

  test('cmd+click again toggles a row out of the selection', async ({ mainWindow }) => {
    await taskRow(mainWindow, rootA).click()
    await taskRow(mainWindow, rootB).click({ modifiers: ['Meta'] })
    // Toggle B back off.
    await taskRow(mainWindow, rootB).click({ modifiers: ['Meta'] })

    await expect
      .poll(() => getSelectedIds(mainWindow, [rootA, rootB, rootC]), { timeout: 3_000 })
      .toEqual([rootA])
  })

  test('shift+click selects the full sibling range across roots', async ({ mainWindow }) => {
    await taskRow(mainWindow, rootA).click()
    await taskRow(mainWindow, rootC).click({ modifiers: ['Shift'] })

    // All three roots are siblings (parent_id=null) → range A..C selected.
    await expect
      .poll(() => getSelectedIds(mainWindow, [rootA, rootB, rootC]), { timeout: 3_000 })
      .toEqual([rootA, rootB, rootC])
  })

  test('shift+click selects the full sibling range across subtasks', async ({ mainWindow }) => {
    await expect(taskRow(mainWindow, subA1)).toBeVisible({ timeout: 5_000 })
    await expect(taskRow(mainWindow, subA3)).toBeVisible()

    await taskRow(mainWindow, subA1).click()
    await taskRow(mainWindow, subA3).click({ modifiers: ['Shift'] })

    await expect
      .poll(() => getSelectedIds(mainWindow, [subA1, subA2, subA3]), { timeout: 3_000 })
      .toEqual([subA1, subA2, subA3])
  })

  test('shift+click across different parents falls back to add-target-only', async ({
    mainWindow
  }) => {
    await expect(taskRow(mainWindow, subA2)).toBeVisible({ timeout: 5_000 })

    // Anchor on root A (parent=null), then shift-click subA2 (parent=A).
    // Different parents → no range; just add target to the existing selection.
    await taskRow(mainWindow, rootA).click()
    await taskRow(mainWindow, subA2).click({ modifiers: ['Shift'] })

    await expect
      .poll(() => getSelectedIds(mainWindow, [rootA, rootB, rootC, subA1, subA2, subA3]), {
        timeout: 3_000
      })
      .toEqual([rootA, subA2])
  })

  test('multi-drag: selected roots move together into target slot', async ({ mainWindow }) => {
    // Make a 4th root D so we have a clear non-selected target to drop on.
    const rootDObj = await mainWindow.evaluate(
      (pid) => window.api.db.createTask({ projectId: pid, title: 'MS D', status: 'in_progress' }),
      projectId
    )
    const rootD = rootDObj!.id
    try {
      await mainWindow.evaluate(
        async ({ a, b, c, d }) => {
          await window.api.db.reorderTasks([a, b, c, d])
        },
        { a: rootA, b: rootB, c: rootC, d: rootD }
      )
      await seed(mainWindow).refreshData()
      await expect(taskRow(mainWindow, rootD)).toBeVisible()

      // Select A and B (multi).
      await taskRow(mainWindow, rootA).click()
      await taskRow(mainWindow, rootB).click({ modifiers: ['Meta'] })

      // Drag from B (a selected row) onto bottom half of D — A and B should
      // both land after D in render order A, B.
      const srcBox = await taskRow(mainWindow, rootB).boundingBox()
      const dstBox = await taskRow(mainWindow, rootD).boundingBox()
      if (!srcBox || !dstBox) throw new Error('boxes unavailable')

      await mainWindow.mouse.move(srcBox.x + srcBox.width / 2, srcBox.y + srcBox.height / 2)
      await mainWindow.mouse.down()
      await mainWindow.mouse.move(srcBox.x + srcBox.width / 2 + 12, srcBox.y + srcBox.height / 2, {
        steps: 5
      })
      await mainWindow.mouse.move(dstBox.x + dstBox.width / 2, dstBox.y + dstBox.height - 4, {
        steps: 20
      })
      await mainWindow.mouse.up()

      // Expected new order: C, D, A, B.
      await expect
        .poll(
          async () => {
            const tasksList = await seed(mainWindow).getTasks()
            const byId = new Map(tasksList.map((t: { id: string }) => [t.id, t]))
            return [
              (byId.get(rootC) as { order: number } | undefined)?.order,
              (byId.get(rootD) as { order: number } | undefined)?.order,
              (byId.get(rootA) as { order: number } | undefined)?.order,
              (byId.get(rootB) as { order: number } | undefined)?.order
            ]
          },
          { timeout: 5_000 }
        )
        .toEqual([0, 1, 2, 3])
    } finally {
      await mainWindow.evaluate((id) => window.api.db.deleteTask(id), rootD)
    }
  })

  test('multi-drag: cross-group drop on group header changes status for all selected', async ({
    mainWindow
  }) => {
    // Select A and B, drop their drag onto the 'todo' group → both get status='todo'.
    await taskRow(mainWindow, rootA).click()
    await taskRow(mainWindow, rootB).click({ modifiers: ['Meta'] })

    const srcBox = await taskRow(mainWindow, rootB).boundingBox()
    const todoGroup = mainWindow.locator(
      `[data-testid="tree-status-group"][data-project-id="${projectId}"][data-status="todo"]`
    )
    // Group may be empty (no rows under it) — its bounding box still exists for the header.
    const dstBox = await todoGroup.boundingBox()
    if (!srcBox || !dstBox) throw new Error('boxes unavailable')

    await mainWindow.mouse.move(srcBox.x + srcBox.width / 2, srcBox.y + srcBox.height / 2)
    await mainWindow.mouse.down()
    await mainWindow.mouse.move(srcBox.x + srcBox.width / 2 + 12, srcBox.y + srcBox.height / 2, {
      steps: 5
    })
    await mainWindow.mouse.move(dstBox.x + dstBox.width / 2, dstBox.y + dstBox.height / 2, {
      steps: 20
    })
    await mainWindow.mouse.up()

    await expect
      .poll(
        async () => {
          const tasksList = await seed(mainWindow).getTasks()
          const byId = new Map(tasksList.map((t: { id: string }) => [t.id, t]))
          return [
            (byId.get(rootA) as { status: string } | undefined)?.status,
            (byId.get(rootB) as { status: string } | undefined)?.status
          ]
        },
        { timeout: 5_000 }
      )
      .toEqual(['todo', 'todo'])

    // beforeEach resets status for the next test.
  })

  test('plain click clears an existing multi-selection', async ({ mainWindow }) => {
    await taskRow(mainWindow, rootA).click()
    await taskRow(mainWindow, rootB).click({ modifiers: ['Meta'] })
    await taskRow(mainWindow, rootC).click({ modifiers: ['Meta'] })

    // Plain-click on A again — selection collapses to just A.
    await taskRow(mainWindow, rootA).click()

    await expect
      .poll(() => getSelectedIds(mainWindow, [rootA, rootB, rootC]), { timeout: 3_000 })
      .toEqual([rootA])
  })
})
