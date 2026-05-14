import { test, expect, seed, resetApp, TEST_PROJECT_PATH } from '../fixtures/electron'
import type { Page } from '@playwright/test'

type TreePatch = Record<string, unknown>

async function patchStore(page: Page, patch: TreePatch) {
  await page.evaluate((p) => {
    const store = (window as unknown as { __slayzone_tabStore?: { setState: (s: unknown) => void } }).__slayzone_tabStore
    if (!store) throw new Error('__slayzone_tabStore not exposed')
    store.setState(p)
  }, patch)
}

async function setTabs(page: Page, taskIds: string[]) {
  await page.evaluate((ids) => {
    const store = (window as unknown as { __slayzone_tabStore?: { setState: (s: unknown) => void } }).__slayzone_tabStore
    if (!store) throw new Error('__slayzone_tabStore not exposed')
    const tabs: Array<{ type: 'home' } | { type: 'task'; taskId: string; title: string }> = [{ type: 'home' }]
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

function statusGroup(page: Page, projectId: string, status: string) {
  return page.locator(`[data-testid="tree-status-group"][data-project-id="${projectId}"][data-status="${status}"]`)
}

async function dragFromTo(
  page: Page,
  src: { x: number; y: number },
  dst: { x: number; y: number }
) {
  await page.mouse.move(src.x, src.y)
  await page.mouse.down()
  // Exceed PointerSensor activation distance (5px).
  await page.mouse.move(src.x + 12, src.y, { steps: 5 })
  await page.mouse.move(dst.x, dst.y, { steps: 20 })
  await page.mouse.up()
}

async function getTaskById(page: Page, id: string) {
  const tasks = await seed(page).getTasks()
  return tasks.find((t: { id: string }) => t.id === id)
}

async function setProjectSortBy(page: Page, projectId: string, sortBy: 'manual' | 'priority' | 'due_date' | 'title' | 'created') {
  await page.evaluate(({ pid, sb }) => {
    const store = (window as unknown as {
      __slayzone_filterStore?: {
        getState: () => {
          filters: Record<string, unknown>
          setFilter: (pid: string, filter: unknown) => void
        }
      }
    }).__slayzone_filterStore
    if (!store) throw new Error('__slayzone_filterStore not exposed')
    const state = store.getState()
    const existing = (state.filters[pid] as Record<string, unknown> | undefined) ?? {
      viewMode: 'board',
      board: { groupBy: 'status', sortBy: 'manual', showEmptyColumns: true, completedFilter: 'all', showArchived: false, showSubTasks: false, showBlockedColumn: false, blockedColumnAfter: null, showSnoozedColumn: false, snoozedColumnAfter: null },
      list: { groupBy: 'status', sortBy: 'manual', showEmptyColumns: true, completedFilter: 'all', showArchived: false, showSubTasks: false, showBlockedColumn: false, blockedColumnAfter: null, showSnoozedColumn: false, snoozedColumnAfter: null },
      priority: null,
      dueDateRange: 'all',
      tagIds: [],
      cardProperties: { priority: true, dueDate: true, terminal: true, linear: true, blocked: true, subtasks: true, merge: true, tags: true },
    }
    const board = (existing.board as Record<string, unknown> | undefined) ?? {}
    state.setFilter(pid, { ...existing, board: { ...board, sortBy: sb } })
  }, { pid: projectId, sb: sortBy })
}

test.describe('TreeView drag and drop', () => {
  let projectId: string
  const projectName = 'Tree DnD'

  // Three roots in 'in_progress' to test reorder; one 'todo' anchor; one 'done' destination.
  let rootA: string
  let rootB: string
  let rootC: string
  let rootTodo: string
  // Subtasks under rootA.
  let subA1: string
  let subA2: string
  let subA3: string

  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
    const s = seed(mainWindow)
    const p = await s.createProject({ name: projectName, color: '#22c55e', path: TEST_PROJECT_PATH })
    projectId = p.id

    rootA = (await s.createTask({ projectId, title: 'DnD A', status: 'in_progress' })).id
    rootB = (await s.createTask({ projectId, title: 'DnD B', status: 'in_progress' })).id
    rootC = (await s.createTask({ projectId, title: 'DnD C', status: 'in_progress' })).id
    rootTodo = (await s.createTask({ projectId, title: 'DnD Todo', status: 'todo' })).id

    subA1 = (await mainWindow.evaluate(
      ({ pid, parentId }) => window.api.db.createTask({ projectId: pid, title: 'Sub A1', status: 'in_progress', parentId }),
      { pid: projectId, parentId: rootA }
    ))!.id
    subA2 = (await mainWindow.evaluate(
      ({ pid, parentId }) => window.api.db.createTask({ projectId: pid, title: 'Sub A2', status: 'in_progress', parentId }),
      { pid: projectId, parentId: rootA }
    ))!.id
    subA3 = (await mainWindow.evaluate(
      ({ pid, parentId }) => window.api.db.createTask({ projectId: pid, title: 'Sub A3', status: 'in_progress', parentId }),
      { pid: projectId, parentId: rootA }
    ))!.id

    await s.refreshData()
  })

  test.beforeEach(async ({ mainWindow }) => {
    await killAllPtys(mainWindow)
    // Force TreeView remount so openProjects useState initializer re-runs.
    await patchStore(mainWindow, { sidebarView: 'projects' })
    await patchStore(mainWindow, {
      sidebarView: 'tree',
      selectedProjectId: projectId,
      treeStatusFilter: ['in_progress', 'todo', 'done'],
      treeShowSubtasks: true,
      treeShowAllSubtasks: false,
      treeShowOnlyActive: false,
      treeShowTemporary: true,
      treePinnedTaskIds: [],
      treeCrossOutDone: false,
      treeShowStatus: false,
      treeShowPriority: false,
      treeShowWorktree: false,
      treeGroupBy: 'status',
      treeOrderBy: 'manual',
      treeOrderDir: 'asc',
      treeGroupTemporary: true,
      treeShowEmptyGroups: false,
    })
    // Anchor open tab keeps the project in TreeView's "active" set.
    await setTabs(mainWindow, [rootA])
    await seed(mainWindow).refreshData()
    await ensureProjectExpanded(mainWindow, projectName)
    await killAllPtys(mainWindow)
    // Reset order/status/priority so each test is independent.
    await mainWindow.evaluate(async ({ a, b, c, todo, s1, s2, s3 }) => {
      await window.api.db.updateTasks({ ids: [a, b, c, s1, s2, s3], updates: { status: 'in_progress', priority: 3 } })
      await window.api.db.updateTasks({ ids: [todo], updates: { status: 'todo', priority: 3 } })
      await window.api.db.reorderTasks([a, b, c, todo])
      await window.api.db.reorderTasks([s1, s2, s3])
    }, { a: rootA, b: rootB, c: rootC, todo: rootTodo, s1: subA1, s2: subA2, s3: subA3 })
    await seed(mainWindow).refreshData()
    // Wait for rows.
    await expect(taskRow(mainWindow, rootA)).toBeVisible({ timeout: 5_000 })
    await expect(taskRow(mainWindow, rootB)).toBeVisible()
    await expect(taskRow(mainWindow, rootC)).toBeVisible()
  })

  test('drag root past sibling reorders within in_progress group', async ({ mainWindow }) => {
    const srcBox = await taskRow(mainWindow, rootA).boundingBox()
    const dstBox = await taskRow(mainWindow, rootC).boundingBox()
    if (!srcBox || !dstBox) throw new Error('row bounding boxes unavailable')

    await dragFromTo(
      mainWindow,
      { x: srcBox.x + srcBox.width / 2, y: srcBox.y + srcBox.height / 2 },
      // Drop on bottom half of last row so dnd-kit places after it.
      { x: dstBox.x + dstBox.width / 2, y: dstBox.y + dstBox.height - 4 }
    )

    // Expect DB order: B, C, A (A dragged past C).
    await expect.poll(async () => {
      const a = await getTaskById(mainWindow, rootA)
      const b = await getTaskById(mainWindow, rootB)
      const c = await getTaskById(mainWindow, rootC)
      return [a?.order, b?.order, c?.order]
    }, { timeout: 5_000 }).toEqual([2, 0, 1])
  })

  test('drag still works when kanban sortBy=priority (same priority reorder)', async ({ mainWindow }) => {
    // Match user scenario: kanban grouped by status, ordered by priority.
    await setProjectSortBy(mainWindow, projectId, 'priority')
    // All three have the same priority (null/default), so sortTasks ties by `order`.
    // DnD reorder should persist via the `order` column.

    const srcBox = await taskRow(mainWindow, rootA).boundingBox()
    const dstBox = await taskRow(mainWindow, rootC).boundingBox()
    if (!srcBox || !dstBox) throw new Error('row bounding boxes unavailable')

    await dragFromTo(
      mainWindow,
      { x: srcBox.x + srcBox.width / 2, y: srcBox.y + srcBox.height / 2 },
      { x: dstBox.x + dstBox.width / 2, y: dstBox.y + dstBox.height - 4 }
    )

    await expect.poll(async () => {
      const a = await getTaskById(mainWindow, rootA)
      const b = await getTaskById(mainWindow, rootB)
      const c = await getTaskById(mainWindow, rootC)
      return [a?.order, b?.order, c?.order]
    }, { timeout: 5_000 }).toEqual([2, 0, 1])
  })

  test('drag root onto another status group changes status', async ({ mainWindow }) => {
    const srcBox = await taskRow(mainWindow, rootA).boundingBox()
    // Target the 'todo' status group container.
    const dstBox = await statusGroup(mainWindow, projectId, 'todo').boundingBox()
    if (!srcBox || !dstBox) throw new Error('bounding boxes unavailable')

    await dragFromTo(
      mainWindow,
      { x: srcBox.x + srcBox.width / 2, y: srcBox.y + srcBox.height / 2 },
      // Drop in the middle of the todo group body.
      { x: dstBox.x + dstBox.width / 2, y: dstBox.y + dstBox.height / 2 }
    )

    await expect.poll(async () => (await getTaskById(mainWindow, rootA))?.status, { timeout: 5_000 }).toBe('todo')
  })

  test('drag subtask past sibling reorders within parent', async ({ mainWindow }) => {
    // Subtasks render under rootA when treeShowSubtasks is true.
    await expect(taskRow(mainWindow, subA1)).toBeVisible({ timeout: 5_000 })
    await expect(taskRow(mainWindow, subA3)).toBeVisible()

    const srcBox = await taskRow(mainWindow, subA1).boundingBox()
    const dstBox = await taskRow(mainWindow, subA3).boundingBox()
    if (!srcBox || !dstBox) throw new Error('row bounding boxes unavailable')

    await dragFromTo(
      mainWindow,
      { x: srcBox.x + srcBox.width / 2, y: srcBox.y + srcBox.height / 2 },
      { x: dstBox.x + dstBox.width / 2, y: dstBox.y + dstBox.height - 4 }
    )

    // Expected sibling order: A2, A3, A1.
    await expect.poll(async () => {
      const s1 = await getTaskById(mainWindow, subA1)
      const s2 = await getTaskById(mainWindow, subA2)
      const s3 = await getTaskById(mainWindow, subA3)
      return [s1?.order, s2?.order, s3?.order]
    }, { timeout: 5_000 }).toEqual([2, 0, 1])
  })

  test('groupBy=priority: cross-group drag changes task priority', async ({ mainWindow }) => {
    // Set distinct priorities: A=3, B=2, C=1. Switch to priority grouping.
    await mainWindow.evaluate(async ({ a, b, c }) => {
      await window.api.db.updateTasks({ ids: [a], updates: { priority: 3 } })
      await window.api.db.updateTasks({ ids: [b], updates: { priority: 2 } })
      await window.api.db.updateTasks({ ids: [c], updates: { priority: 1 } })
    }, { a: rootA, b: rootB, c: rootC })
    await patchStore(mainWindow, { treeGroupBy: 'priority' })
    await seed(mainWindow).refreshData()
    await expect(taskRow(mainWindow, rootA)).toBeVisible()
    await expect(taskRow(mainWindow, rootC)).toBeVisible()

    const srcBox = await taskRow(mainWindow, rootA).boundingBox()
    const dstBox = await taskRow(mainWindow, rootC).boundingBox()
    if (!srcBox || !dstBox) throw new Error('row bounding boxes unavailable')

    // Drag A (priority 3) onto C (priority 1) → A.priority becomes 1.
    await dragFromTo(
      mainWindow,
      { x: srcBox.x + srcBox.width / 2, y: srcBox.y + srcBox.height / 2 },
      { x: dstBox.x + dstBox.width / 2, y: dstBox.y + dstBox.height / 2 }
    )

    await expect.poll(async () => (await getTaskById(mainWindow, rootA))?.priority, { timeout: 5_000 }).toBe(1)
  })

  test('groupBy=priority: same-priority reorder persists via order col', async ({ mainWindow }) => {
    // All three tasks share priority 2. Switch to priority grouping.
    await mainWindow.evaluate(async ({ ids }) => {
      await window.api.db.updateTasks({ ids, updates: { priority: 2 } })
    }, { ids: [rootA, rootB, rootC] })
    await patchStore(mainWindow, { treeGroupBy: 'priority' })
    await seed(mainWindow).refreshData()

    const srcBox = await taskRow(mainWindow, rootA).boundingBox()
    const dstBox = await taskRow(mainWindow, rootC).boundingBox()
    if (!srcBox || !dstBox) throw new Error('row bounding boxes unavailable')

    await dragFromTo(
      mainWindow,
      { x: srcBox.x + srcBox.width / 2, y: srcBox.y + srcBox.height / 2 },
      { x: dstBox.x + dstBox.width / 2, y: dstBox.y + dstBox.height - 4 }
    )

    await expect.poll(async () => {
      const a = await getTaskById(mainWindow, rootA)
      const b = await getTaskById(mainWindow, rootB)
      const c = await getTaskById(mainWindow, rootC)
      return [a?.order, b?.order, c?.order]
    }, { timeout: 5_000 }).toEqual([2, 0, 1])
  })

  test('orderBy=title: drag reorder still persists via order tiebreak', async ({ mainWindow }) => {
    // Tree's own sort always tiebreaks by order, so manual reorder works
    // under any orderBy — including title.
    await patchStore(mainWindow, { treeOrderBy: 'title' })
    await seed(mainWindow).refreshData()

    const srcBox = await taskRow(mainWindow, rootA).boundingBox()
    const dstBox = await taskRow(mainWindow, rootC).boundingBox()
    if (!srcBox || !dstBox) throw new Error('row bounding boxes unavailable')

    await dragFromTo(
      mainWindow,
      { x: srcBox.x + srcBox.width / 2, y: srcBox.y + srcBox.height / 2 },
      { x: dstBox.x + dstBox.width / 2, y: dstBox.y + dstBox.height - 4 }
    )

    await expect.poll(async () => {
      const a = await getTaskById(mainWindow, rootA)
      const b = await getTaskById(mainWindow, rootB)
      const c = await getTaskById(mainWindow, rootC)
      return [a?.order, b?.order, c?.order]
    }, { timeout: 5_000 }).toEqual([2, 0, 1])
  })

  test('groupTemporary=false: temp task renders in its status bucket', async ({ mainWindow }) => {
    // Create a temp task in_progress for this test only.
    const tempId = await mainWindow.evaluate(
      (pid) => window.api.db.createTask({ projectId: pid, title: 'Temp mixed', status: 'in_progress', isTemporary: true }),
      projectId
    )
    try {
      await patchStore(mainWindow, { treeGroupTemporary: false, treeShowTemporary: true })
      await seed(mainWindow).refreshData()

      // The temp task should appear in the in_progress group.
      const tempRow = taskRow(mainWindow, tempId!.id)
      await expect(tempRow).toBeVisible({ timeout: 5_000 })

      const inProgressGroup = statusGroup(mainWindow, projectId, 'in_progress')
      const tempInsideInProgress = inProgressGroup.locator(`[data-task-id="${tempId!.id}"]`)
      await expect(tempInsideInProgress).toBeVisible()

      // No __temporary__ section.
      const tempGroup = mainWindow.locator(`[data-testid="tree-status-group"][data-status="__temporary__"]`)
      await expect(tempGroup).toHaveCount(0)
    } finally {
      await mainWindow.evaluate((id) => window.api.db.deleteTask(id), tempId!.id)
    }
  })

  test('showEmptyGroups=true + groupBy=status: empty status column header renders', async ({ mainWindow }) => {
    await patchStore(mainWindow, {
      treeShowEmptyGroups: true,
      // Allow all status columns to show through the filter.
      treeStatusFilter: ['inbox', 'backlog', 'todo', 'in_progress', 'review', 'done', 'canceled'],
    })
    await seed(mainWindow).refreshData()

    // 'review' group has zero tasks but should still render a droppable header.
    const reviewGroup = statusGroup(mainWindow, projectId, 'review')
    await expect(reviewGroup).toBeVisible({ timeout: 5_000 })
  })

  test('orderDir=desc: row order reverses', async ({ mainWindow }) => {
    await patchStore(mainWindow, { treeOrderDir: 'desc' })
    await seed(mainWindow).refreshData()

    // Manual order (A,B,C) reversed → DOM order: C, B, A.
    const rows = mainWindow.locator(
      `[data-sidebar-tree-item="task"][data-task-id="${rootA}"], ` +
      `[data-sidebar-tree-item="task"][data-task-id="${rootB}"], ` +
      `[data-sidebar-tree-item="task"][data-task-id="${rootC}"]`
    )
    await expect(rows).toHaveCount(3)
    const ids = await rows.evaluateAll((els) => els.map((el) => (el as HTMLElement).dataset.taskId))
    expect(ids).toEqual([rootC, rootB, rootA])
  })
})
