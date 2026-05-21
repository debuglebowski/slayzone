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

// Pin state is a task-intrinsic column (`tasks.pinned` / `pin_order`), not
// view-store state — drive it through the DB. Passing `[]` unpins everything.
async function setPinned(page: Page, taskIds: string[]) {
  await page.evaluate(async (ids) => {
    const data = await window.api.db.loadBoardData()
    const tasks = data.tasks as Array<{ id: string; pinned?: boolean }>
    const pinSet = new Set(ids)
    for (const t of tasks) {
      if (t.pinned && !pinSet.has(t.id)) {
        await window.api.db.updateTask({ id: t.id, pinned: false, pinOrder: 0 })
      }
    }
    for (let i = 0; i < ids.length; i++) {
      await window.api.db.updateTask({ id: ids[i], pinned: true, pinOrder: i })
    }
  }, taskIds)
  await seed(page).refreshData()
}

// Read the pinned task ids (in pin_order) straight from the DB.
async function getPinnedIds(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const data = await window.api.db.loadBoardData()
    const tasks = data.tasks as Array<{ id: string; pinned?: boolean; pin_order: number }>
    return tasks
      .filter((t) => t.pinned)
      .sort((a, b) => a.pin_order - b.pin_order)
      .map((t) => t.id)
  })
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

function statusGroup(page: Page, projectId: string, status: string) {
  return page.locator(
    `[data-testid="tree-status-group"][data-project-id="${projectId}"][data-status="${status}"]`
  )
}

type Point = { x: number; y: number }
type DstArg = Point | (() => Promise<Point>)

async function dragFromTo(page: Page, src: Point, dst: DstArg) {
  await page.mouse.move(src.x, src.y)
  await page.mouse.down()
  // Exceed PointerSensor activation distance (5px). dnd-kit fires
  // `onDragStart` here, which triggers `setActiveDragTaskId` and the
  // transient `dragCollapseSet` for parents with subtasks. That reflows the
  // layout below the dragged row — so a `dst` captured pre-activation is
  // stale. Pass a resolver callback for `dst` to re-read the target row's
  // bbox after this point.
  await page.mouse.move(src.x + 12, src.y, { steps: 5 })
  const dstPt = typeof dst === 'function' ? await dst() : dst
  await page.mouse.move(dstPt.x, dstPt.y, { steps: 20 })
  await page.mouse.up()
}

/** Start a drag and hover at dst without releasing — so we can sample
 * pre-slide transforms while the drag is still live. Caller MUST release
 * via `page.mouse.up()` afterwards.
 *
 * Pauses ~250ms after the move so the CSS slide transition on non-active
 * rows can settle — `useSortable` returns a default ~200ms transition,
 * applied to siblings via `style.transition`, so a row's `transform`
 * computed style ramps from 0 to its final shift over that window. Sampling
 * mid-transition yields a partial value (~-18 instead of -32). */
async function dragHover(page: Page, src: Point, dst: DstArg) {
  await page.mouse.move(src.x, src.y)
  await page.mouse.down()
  await page.mouse.move(src.x + 12, src.y, { steps: 5 })
  const dstPt = typeof dst === 'function' ? await dst() : dst
  await page.mouse.move(dstPt.x, dstPt.y, { steps: 20 })
  await page.waitForTimeout(300)
}

/** Resolve a row's drop-point AFTER drag activation. `yFrac` defaults to
 * 0.5 (center). `yOffset` adds pixels past the row's bottom (positive) or
 * before the top (negative) — use for "land in inter-group gap" cases. */
function rowDropPoint(
  page: Page,
  id: string,
  opts: { yFrac?: number; yOffset?: number } = {}
): () => Promise<Point> {
  return async () => {
    const box = await taskRow(page, id).boundingBox()
    if (!box) throw new Error(`row bbox not found: ${id}`)
    const yFrac = opts.yFrac ?? 0.5
    const yOffset = opts.yOffset ?? 0
    return { x: box.x + box.width / 2, y: box.y + box.height * yFrac + yOffset }
  }
}

/** Snapshot every visible task row + group header transform + rect
 * mid-drag. Tasks keyed by `data-task-id`, headers keyed by
 * `header:<groupKey>` (matches the sortable id format). */
async function sampleRowTransforms(page: Page) {
  return page.evaluate(() => {
    const out: { id: string; transformY: number; topY: number }[] = []
    const els = document.querySelectorAll('[data-sidebar-tree-item]')
    for (const r of Array.from(els) as HTMLElement[]) {
      const kind = r.dataset.sidebarTreeItem
      let id: string | null = null
      if (kind === 'task') id = r.dataset.taskId ?? null
      else if (kind === 'header') id = r.dataset.groupKey ? `header:${r.dataset.groupKey}` : null
      if (!id) continue
      const t = getComputedStyle(r).transform
      let ty = 0
      if (t && t !== 'none') {
        const m = t.match(/matrix\(([^)]+)\)/)
        if (m) {
          const parts = m[1].split(',').map((p) => parseFloat(p.trim()))
          ty = parts[5] ?? 0
        } else {
          const m3d = t.match(/matrix3d\(([^)]+)\)/)
          if (m3d) {
            const parts = m3d[1].split(',').map((p) => parseFloat(p.trim()))
            ty = parts[13] ?? 0
          }
        }
      }
      out.push({ id, transformY: ty, topY: r.getBoundingClientRect().top })
    }
    return out
  })
}

async function getTaskById(page: Page, id: string) {
  const tasks = await seed(page).getTasks()
  return tasks.find((t: { id: string }) => t.id === id)
}

async function setProjectSortBy(
  page: Page,
  projectId: string,
  sortBy: 'manual' | 'priority' | 'due_date' | 'title' | 'created'
) {
  await page.evaluate(
    ({ pid, sb }) => {
      const store = (
        window as unknown as {
          __slayzone_filterStore?: {
            getState: () => {
              filters: Record<string, unknown>
              setFilter: (pid: string, filter: unknown) => void
            }
          }
        }
      ).__slayzone_filterStore
      if (!store) throw new Error('__slayzone_filterStore not exposed')
      const state = store.getState()
      const existing = (state.filters[pid] as Record<string, unknown> | undefined) ?? {
        viewMode: 'board',
        board: {
          groupBy: 'status',
          sortBy: 'manual',
          showEmptyColumns: true,
          completedFilter: 'all',
          showArchived: false,
          showSubTasks: false,
          showBlockedColumn: false,
          blockedColumnAfter: null,
          showSnoozedColumn: false,
          snoozedColumnAfter: null
        },
        list: {
          groupBy: 'status',
          sortBy: 'manual',
          showEmptyColumns: true,
          completedFilter: 'all',
          showArchived: false,
          showSubTasks: false,
          showBlockedColumn: false,
          blockedColumnAfter: null,
          showSnoozedColumn: false,
          snoozedColumnAfter: null
        },
        priority: null,
        dueDateRange: 'all',
        tagIds: [],
        cardProperties: {
          priority: true,
          dueDate: true,
          terminal: true,
          linear: true,
          blocked: true,
          subtasks: true,
          merge: true,
          tags: true
        }
      }
      const board = (existing.board as Record<string, unknown> | undefined) ?? {}
      state.setFilter(pid, { ...existing, board: { ...board, sortBy: sb } })
    },
    { pid: projectId, sb: sortBy }
  )
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
    const p = await s.createProject({
      name: projectName,
      color: '#22c55e',
      path: TEST_PROJECT_PATH
    })
    projectId = p.id

    rootA = (await s.createTask({ projectId, title: 'DnD A', status: 'in_progress' })).id
    rootB = (await s.createTask({ projectId, title: 'DnD B', status: 'in_progress' })).id
    rootC = (await s.createTask({ projectId, title: 'DnD C', status: 'in_progress' })).id
    rootTodo = (await s.createTask({ projectId, title: 'DnD Todo', status: 'todo' })).id

    subA1 = (await mainWindow.evaluate(
      ({ pid, parentId }) =>
        window.api.db.createTask({
          projectId: pid,
          title: 'Sub A1',
          status: 'in_progress',
          parentId
        }),
      { pid: projectId, parentId: rootA }
    ))!.id
    subA2 = (await mainWindow.evaluate(
      ({ pid, parentId }) =>
        window.api.db.createTask({
          projectId: pid,
          title: 'Sub A2',
          status: 'in_progress',
          parentId
        }),
      { pid: projectId, parentId: rootA }
    ))!.id
    subA3 = (await mainWindow.evaluate(
      ({ pid, parentId }) =>
        window.api.db.createTask({
          projectId: pid,
          title: 'Sub A3',
          status: 'in_progress',
          parentId
        }),
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
    // Anchor open tab keeps the project in TreeView's "active" set.
    await setTabs(mainWindow, [rootA])
    await seed(mainWindow).refreshData()
    await ensureProjectExpanded(mainWindow, projectName)
    await killAllPtys(mainWindow)
    // Reset order/status/priority so each test is independent.
    await mainWindow.evaluate(
      async ({ a, b, c, todo, s1, s2, s3 }) => {
        await window.api.db.updateTasks({
          ids: [a, b, c, s1, s2, s3],
          updates: { status: 'in_progress', priority: 3 }
        })
        await window.api.db.updateTasks({ ids: [todo], updates: { status: 'todo', priority: 3 } })
        await window.api.db.reorderTasks([a, b, c, todo])
        await window.api.db.reorderTasks([s1, s2, s3])
      },
      { a: rootA, b: rootB, c: rootC, todo: rootTodo, s1: subA1, s2: subA2, s3: subA3 }
    )
    await setPinned(mainWindow, [])
    await seed(mainWindow).refreshData()
    // Wait for rows.
    await expect(taskRow(mainWindow, rootA)).toBeVisible({ timeout: 5_000 })
    await expect(taskRow(mainWindow, rootB)).toBeVisible()
    await expect(taskRow(mainWindow, rootC)).toBeVisible()
  })

  test('drag root past sibling reorders within in_progress group', async ({ mainWindow }) => {
    const srcBox = await taskRow(mainWindow, rootA).boundingBox()
    if (!srcBox) throw new Error('row bounding boxes unavailable')

    await dragFromTo(
      mainWindow,
      { x: srcBox.x + srcBox.width / 2, y: srcBox.y + srcBox.height / 2 },
      // Drop on bottom half of last row so dnd-kit places after it. Resolve
      // dstBox post-activation — `dragCollapseSet` collapses rootA's
      // subtasks at drag start and reflows rootC's y.
      rowDropPoint(mainWindow, rootC, { yOffset: -4, yFrac: 1 })
    )

    // Expect DB order: B, C, A (A dragged past C).
    await expect
      .poll(
        async () => {
          const a = await getTaskById(mainWindow, rootA)
          const b = await getTaskById(mainWindow, rootB)
          const c = await getTaskById(mainWindow, rootC)
          return [a?.order, b?.order, c?.order]
        },
        { timeout: 5_000 }
      )
      .toEqual([2, 0, 1])
  })

  test('drag still works when kanban sortBy=priority (same priority reorder)', async ({
    mainWindow
  }) => {
    // Match user scenario: kanban grouped by status, ordered by priority.
    await setProjectSortBy(mainWindow, projectId, 'priority')
    // All three have the same priority (null/default), so sortTasks ties by `order`.
    // DnD reorder should persist via the `order` column.

    const srcBox = await taskRow(mainWindow, rootA).boundingBox()
    if (!srcBox) throw new Error('row bounding boxes unavailable')

    await dragFromTo(
      mainWindow,
      { x: srcBox.x + srcBox.width / 2, y: srcBox.y + srcBox.height / 2 },
      rowDropPoint(mainWindow, rootC, { yOffset: -4, yFrac: 1 })
    )

    await expect
      .poll(
        async () => {
          const a = await getTaskById(mainWindow, rootA)
          const b = await getTaskById(mainWindow, rootB)
          const c = await getTaskById(mainWindow, rootC)
          return [a?.order, b?.order, c?.order]
        },
        { timeout: 5_000 }
      )
      .toEqual([2, 0, 1])
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

    await expect
      .poll(async () => (await getTaskById(mainWindow, rootA))?.status, { timeout: 5_000 })
      .toBe('todo')
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
    await expect
      .poll(
        async () => {
          const s1 = await getTaskById(mainWindow, subA1)
          const s2 = await getTaskById(mainWindow, subA2)
          const s3 = await getTaskById(mainWindow, subA3)
          return [s1?.order, s2?.order, s3?.order]
        },
        { timeout: 5_000 }
      )
      .toEqual([2, 0, 1])
  })

  test('groupBy=priority: cross-group drag changes task priority', async ({ mainWindow }) => {
    // Set distinct priorities: A=3, B=2, C=1. Switch to priority grouping.
    await mainWindow.evaluate(
      async ({ a, b, c }) => {
        await window.api.db.updateTasks({ ids: [a], updates: { priority: 3 } })
        await window.api.db.updateTasks({ ids: [b], updates: { priority: 2 } })
        await window.api.db.updateTasks({ ids: [c], updates: { priority: 1 } })
      },
      { a: rootA, b: rootB, c: rootC }
    )
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

    await expect
      .poll(async () => (await getTaskById(mainWindow, rootA))?.priority, { timeout: 5_000 })
      .toBe(1)
  })

  test('groupBy=priority: same-priority reorder persists via order col', async ({ mainWindow }) => {
    // All three tasks share priority 2. Switch to priority grouping.
    await mainWindow.evaluate(
      async ({ ids }) => {
        await window.api.db.updateTasks({ ids, updates: { priority: 2 } })
      },
      { ids: [rootA, rootB, rootC] }
    )
    await patchStore(mainWindow, { treeGroupBy: 'priority' })
    await seed(mainWindow).refreshData()

    const srcBox = await taskRow(mainWindow, rootA).boundingBox()
    if (!srcBox) throw new Error('row bounding boxes unavailable')

    await dragFromTo(
      mainWindow,
      { x: srcBox.x + srcBox.width / 2, y: srcBox.y + srcBox.height / 2 },
      rowDropPoint(mainWindow, rootC, { yOffset: -4, yFrac: 1 })
    )

    await expect
      .poll(
        async () => {
          const a = await getTaskById(mainWindow, rootA)
          const b = await getTaskById(mainWindow, rootB)
          const c = await getTaskById(mainWindow, rootC)
          return [a?.order, b?.order, c?.order]
        },
        { timeout: 5_000 }
      )
      .toEqual([2, 0, 1])
  })

  test('orderBy=title: drag reorder still persists via order tiebreak', async ({ mainWindow }) => {
    // Tree's own sort always tiebreaks by order, so manual reorder works
    // under any orderBy — including title.
    await patchStore(mainWindow, { treeOrderBy: 'title' })
    await seed(mainWindow).refreshData()

    const srcBox = await taskRow(mainWindow, rootA).boundingBox()
    if (!srcBox) throw new Error('row bounding boxes unavailable')

    await dragFromTo(
      mainWindow,
      { x: srcBox.x + srcBox.width / 2, y: srcBox.y + srcBox.height / 2 },
      rowDropPoint(mainWindow, rootC, { yOffset: -4, yFrac: 1 })
    )

    await expect
      .poll(
        async () => {
          const a = await getTaskById(mainWindow, rootA)
          const b = await getTaskById(mainWindow, rootB)
          const c = await getTaskById(mainWindow, rootC)
          return [a?.order, b?.order, c?.order]
        },
        { timeout: 5_000 }
      )
      .toEqual([2, 0, 1])
  })

  test('groupTemporary=false: temp task renders in its status bucket', async ({ mainWindow }) => {
    // Create a temp task in_progress for this test only.
    const tempId = await mainWindow.evaluate(
      (pid) =>
        window.api.db.createTask({
          projectId: pid,
          title: 'Temp mixed',
          status: 'in_progress',
          isTemporary: true
        }),
      projectId
    )
    try {
      await patchStore(mainWindow, { treeGroupTemporary: false, treeShowTemporary: true })
      await seed(mainWindow).refreshData()

      // The temp task should appear in the in_progress group. Flat render →
      // we can't query "task inside group container" any more; assert task
      // is rendered AND its in_progress header exists AND no __temporary__
      // section was created.
      const tempRow = taskRow(mainWindow, tempId!.id)
      await expect(tempRow).toBeVisible({ timeout: 5_000 })

      const inProgressHeader = statusGroup(mainWindow, projectId, 'in_progress')
      await expect(inProgressHeader).toBeVisible()

      // No __temporary__ section.
      const tempGroup = mainWindow.locator(
        `[data-testid="tree-status-group"][data-status="__temporary__"]`
      )
      await expect(tempGroup).toHaveCount(0)
    } finally {
      await mainWindow.evaluate((id) => window.api.db.deleteTask(id), tempId!.id)
    }
  })

  test('showEmptyGroups=true + groupBy=status: empty status column header renders', async ({
    mainWindow
  }) => {
    await patchStore(mainWindow, {
      treeShowEmptyGroups: true,
      // Allow all status columns to show through the filter.
      treeStatusFilter: ['inbox', 'backlog', 'todo', 'in_progress', 'review', 'done', 'canceled']
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

  // Drop-position matches the pre-slide animation: with `closestCenter`
  // collision + direction-aware `insertIdx`, the dragged row ends up exactly
  // where dnd-kit's slide showed the gap, never off-by-one.

  test('drop position: drag DOWN onto row places source AFTER target', async ({ mainWindow }) => {
    const srcBox = await taskRow(mainWindow, rootA).boundingBox()
    if (!srcBox) throw new Error('row bounding boxes unavailable')
    // Drag A (idx 0) onto B (idx 1) — `arrayMove(0, 1)` puts A at idx 1.
    await dragFromTo(
      mainWindow,
      { x: srcBox.x + srcBox.width / 2, y: srcBox.y + srcBox.height / 2 },
      rowDropPoint(mainWindow, rootB)
    )
    await expect
      .poll(
        async () => {
          const a = await getTaskById(mainWindow, rootA)
          const b = await getTaskById(mainWindow, rootB)
          const c = await getTaskById(mainWindow, rootC)
          return [a?.order, b?.order, c?.order]
        },
        { timeout: 5_000 }
      )
      .toEqual([1, 0, 2])
  })

  test('drop position: drag UP onto row places source AT target slot', async ({ mainWindow }) => {
    const srcBox = await taskRow(mainWindow, rootC).boundingBox()
    const dstBox = await taskRow(mainWindow, rootA).boundingBox()
    if (!srcBox || !dstBox) throw new Error('row bounding boxes unavailable')
    // Drag C (idx 2) onto A (idx 0) — `arrayMove(2, 0)` → [C, A, B].
    await dragFromTo(
      mainWindow,
      { x: srcBox.x + srcBox.width / 2, y: srcBox.y + srcBox.height / 2 },
      { x: dstBox.x + dstBox.width / 2, y: dstBox.y + dstBox.height / 2 }
    )
    await expect
      .poll(
        async () => {
          const a = await getTaskById(mainWindow, rootA)
          const b = await getTaskById(mainWindow, rootB)
          const c = await getTaskById(mainWindow, rootC)
          return [a?.order, b?.order, c?.order]
        },
        { timeout: 5_000 }
      )
      .toEqual([1, 2, 0])
  })

  test('drop position: drag onto adjacent row swaps them', async ({ mainWindow }) => {
    // Drag B (idx 1) onto A (idx 0) — `arrayMove(1, 0)` → [B, A, C].
    const srcBox = await taskRow(mainWindow, rootB).boundingBox()
    const dstBox = await taskRow(mainWindow, rootA).boundingBox()
    if (!srcBox || !dstBox) throw new Error('row bounding boxes unavailable')
    await dragFromTo(
      mainWindow,
      { x: srcBox.x + srcBox.width / 2, y: srcBox.y + srcBox.height / 2 },
      { x: dstBox.x + dstBox.width / 2, y: dstBox.y + dstBox.height / 2 }
    )
    await expect
      .poll(
        async () => {
          const a = await getTaskById(mainWindow, rootA)
          const b = await getTaskById(mainWindow, rootB)
          const c = await getTaskById(mainWindow, rootC)
          return [a?.order, b?.order, c?.order]
        },
        { timeout: 5_000 }
      )
      .toEqual([1, 0, 2])
  })

  test('drop on group header: source becomes idx 0 of that group', async ({ mainWindow }) => {
    // Drag rootA (in_progress, idx 0) onto the 'todo' group header.
    // After: rootA.status='todo', rootA.order=0, rootTodo.order=1.
    // Header box must be resolved AFTER drag activation — subs collapse
    // shifts the layout, so the pre-drag header position is stale.
    const srcBox = await taskRow(mainWindow, rootA).boundingBox()
    if (!srcBox) throw new Error('source row missing')
    await dragFromTo(
      mainWindow,
      { x: srcBox.x + srcBox.width / 2, y: srcBox.y + srcBox.height / 2 },
      async () => {
        const todoHeader = mainWindow
          .locator(`[data-testid="tree-status-group"][data-status="todo"]`)
          .first()
        const headerBox = await todoHeader.boundingBox()
        if (!headerBox) throw new Error('todo header box missing')
        return { x: headerBox.x + headerBox.width / 2, y: headerBox.y + headerBox.height / 2 }
      }
    )
    await expect
      .poll(
        async () => {
          const a = await getTaskById(mainWindow, rootA)
          const todo = await getTaskById(mainWindow, rootTodo)
          return { aStatus: a?.status, aOrder: a?.order, todoOrder: todo?.order }
        },
        { timeout: 5_000 }
      )
      .toEqual({ aStatus: 'todo', aOrder: 0, todoOrder: 1 })
  })

  test('drag from lower group to last spot in upper group lands at end of upper group', async ({
    mainWindow
  }) => {
    // Test project has no custom columns → groups order by task-insertion:
    // in_progress (created first) ABOVE todo. Drag rootTodo (lower group)
    // up to just below rootC (last row of upper group, in_progress).
    // Pointer lands in the gap between the two groups. Must place
    // rootTodo at end of in_progress, NOT at top of todo (its own group).
    const srcBox = await taskRow(mainWindow, rootTodo).boundingBox()
    if (!srcBox) throw new Error('row bounding box unavailable')

    await dragFromTo(
      mainWindow,
      { x: srcBox.x + srcBox.width / 2, y: srcBox.y + srcBox.height / 2 },
      // Drop on the todo header itself — header sits in the inter-group gap.
      // arrayMove(source, headerIdx) for drag UP lands source AT headerIdx
      // in flat = above the header = end of previous group (in_progress).
      async () => {
        const todoHeader = mainWindow
          .locator(`[data-testid="tree-status-group"][data-status="todo"]`)
          .first()
        const box = await todoHeader.boundingBox()
        if (!box) throw new Error('todo header box missing')
        return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
      }
    )

    await expect
      .poll(
        async () => {
          const t = await getTaskById(mainWindow, rootTodo)
          const c = await getTaskById(mainWindow, rootC)
          if (!t || !c) return null
          return {
            tStatus: t.status,
            afterRootC: t.order > c.order
          }
        },
        { timeout: 5_000 }
      )
      .toEqual({ tStatus: 'in_progress', afterRootC: true })
  })

  test('drop on row in different group: drag DOWN cross-group lands source AFTER target', async ({
    mainWindow
  }) => {
    // Drag rootA (in_progress) onto rootTodo (only row in 'todo'). Pure
    // arrayMove convention: drag DOWN onto X lands source AFTER X →
    // rootTodo stays at order 0, rootA at order 1.
    const srcBox = await taskRow(mainWindow, rootA).boundingBox()
    const dstBox = await taskRow(mainWindow, rootTodo).boundingBox()
    if (!srcBox || !dstBox) throw new Error('row bounding boxes unavailable')
    await dragFromTo(
      mainWindow,
      { x: srcBox.x + srcBox.width / 2, y: srcBox.y + srcBox.height / 2 },
      { x: dstBox.x + dstBox.width / 2, y: dstBox.y + dstBox.height / 2 }
    )
    await expect
      .poll(
        async () => {
          const a = await getTaskById(mainWindow, rootA)
          const todo = await getTaskById(mainWindow, rootTodo)
          return { aStatus: a?.status, aOrder: a?.order, todoOrder: todo?.order }
        },
        { timeout: 5_000 }
      )
      .toEqual({ aStatus: 'todo', aOrder: 1, todoOrder: 0 })
  })

  // ====== Pre-slide visual tests ======
  // Sample CSS transforms mid-drag (before release) so we lock in the
  // pre-slide animation behavior. Catches every visual bug we hit:
  //   - "Y drifts into A" — first row of target group leaves its section.
  //   - "header doesn't slide" — header stays static while content moves.
  //   - "items in groups below source don't pre-slide" — strategy clamp
  //     was eating animations on cross-group drags.
  //   - "drop position off-by-one" — visual gap vs final position mismatch.

  test('pre-slide: same-group drag DOWN shifts items between active and over UP', async ({
    mainWindow
  }) => {
    // Drag A (idx 0) onto C (idx 2). Stock arrayMove(0, 2) → items B and C
    // each shift UP by one row height.
    const srcBox = await taskRow(mainWindow, rootA).boundingBox()
    if (!srcBox) throw new Error('row bounding boxes unavailable')
    await dragHover(
      mainWindow,
      { x: srcBox.x + srcBox.width / 2, y: srcBox.y + srcBox.height / 2 },
      rowDropPoint(mainWindow, rootC)
    )
    const samples = await sampleRowTransforms(mainWindow)
    const byId = new Map(samples.map((s) => [s.id, s]))
    // B and C should be shifted up by ~32 (row height). A is the active
    // row — dnd-kit doesn't translate it via strategy (drag overlay floats it).
    expect(byId.get(rootB)?.transformY).toBeLessThanOrEqual(-30)
    expect(byId.get(rootC)?.transformY).toBeLessThanOrEqual(-30)
    expect(byId.get(rootTodo)?.transformY ?? 0).toBe(0)
    await mainWindow.mouse.up()
  })

  test('pre-slide: cross-group drag shifts items in (active, over] UP (standard arrayMove)', async ({
    mainWindow
  }) => {
    // Standard verticalListSortingStrategy: items strictly between active
    // and over (inclusive of over) shift UP by source.height. Source's
    // DOM slot stays at orig with opacity 0 — items shift into it to
    // close the gap. Flat-list behavior, no group awareness.
    const srcBox = await taskRow(mainWindow, rootC).boundingBox()
    if (!srcBox) throw new Error('source box missing')
    await dragHover(
      mainWindow,
      { x: srcBox.x + srcBox.width / 2, y: srcBox.y + srcBox.height / 2 },
      rowDropPoint(mainWindow, rootTodo)
    )
    const samples = await sampleRowTransforms(mainWindow)
    const todoSample = samples.find((s) => s.id === rootTodo)
    const header = samples.find((s) => s.id === 'header:todo')
    if (!todoSample || !header) throw new Error('rootTodo or header not sampled')
    expect(todoSample.transformY).toBeLessThan(0)
    expect(header.transformY).toBeLessThan(0)
    await mainWindow.mouse.up()
  })

  test('pre-slide: header slides with content (sortable, drag-disabled)', async ({
    mainWindow
  }) => {
    const samples1 = await sampleRowTransforms(mainWindow)
    expect(samples1.find((s) => s.id === 'header:todo')).toBeDefined()

    const srcBox = await taskRow(mainWindow, rootC).boundingBox()
    if (!srcBox) throw new Error('source box missing')
    await dragHover(
      mainWindow,
      { x: srcBox.x + srcBox.width / 2, y: srcBox.y + srcBox.height / 2 },
      rowDropPoint(mainWindow, rootTodo)
    )
    const samples2 = await sampleRowTransforms(mainWindow)
    const headerSample = samples2.find((s) => s.id === 'header:todo')
    if (!headerSample) throw new Error('todo header not sampled')
    expect(headerSample.transformY).toBeLessThan(0)
    await mainWindow.mouse.up()
  })

  test('pre-slide: subtasks shift with their parent root (no orphan drift)', async ({
    mainWindow
  }) => {
    // Drag rootB down past rootC. rootA's subtasks (subA1/A2/A3) are NOT
    // between active and over, so their transform must stay identity —
    // they should not get pulled along with the slide just because they
    // happen to render in the flat sortable list.
    await expect(taskRow(mainWindow, subA1)).toBeVisible()
    const srcBox = await taskRow(mainWindow, rootB).boundingBox()
    const dstBox = await taskRow(mainWindow, rootC).boundingBox()
    if (!srcBox || !dstBox) throw new Error('row boxes missing')
    await dragHover(
      mainWindow,
      { x: srcBox.x + srcBox.width / 2, y: srcBox.y + srcBox.height / 2 },
      { x: dstBox.x + dstBox.width / 2, y: dstBox.y + dstBox.height / 2 }
    )
    const samples = await sampleRowTransforms(mainWindow)
    const byId = new Map(samples.map((s) => [s.id, s]))
    // Subtasks under A are above the active row, NOT in (activeIdx, overIdx]
    // → identity transform.
    expect(byId.get(subA1)?.transformY ?? 0).toBe(0)
    expect(byId.get(subA2)?.transformY ?? 0).toBe(0)
    expect(byId.get(subA3)?.transformY ?? 0).toBe(0)
    // C is between activeIdx (B) and over (C) — should shift up.
    expect(byId.get(rootC)?.transformY).toBeLessThanOrEqual(-30)
    await mainWindow.mouse.up()
  })

  test('pre-slide: cross-group drag shifts header AND first row together (flat list)', async ({
    mainWindow
  }) => {
    const srcBox = await taskRow(mainWindow, rootC).boundingBox()
    if (!srcBox) throw new Error('src missing')
    await dragHover(
      mainWindow,
      { x: srcBox.x + srcBox.width / 2, y: srcBox.y + srcBox.height / 2 },
      rowDropPoint(mainWindow, rootTodo)
    )
    const samples = await sampleRowTransforms(mainWindow)
    const header = samples.find((s) => s.id === 'header:todo')
    const firstRow = samples.find((s) => s.id === rootTodo)
    if (!header || !firstRow) throw new Error('header or rootTodo not sampled')
    expect(firstRow.transformY).toBeLessThan(0)
    expect(header.transformY).toBeLessThan(0)
    await mainWindow.mouse.up()
  })

  test('pre-slide: items outside (active, over] range stay identity', async ({ mainWindow }) => {
    // Drag rootB onto rootC. Only items strictly between B and C (inclusive
    // of C, exclusive of B) shift. rootA (above B) and rootTodo (below C,
    // in a different group below) must remain at identity.
    const srcBox = await taskRow(mainWindow, rootB).boundingBox()
    const dstBox = await taskRow(mainWindow, rootC).boundingBox()
    if (!srcBox || !dstBox) throw new Error('row boxes missing')
    await dragHover(
      mainWindow,
      { x: srcBox.x + srcBox.width / 2, y: srcBox.y + srcBox.height / 2 },
      { x: dstBox.x + dstBox.width / 2, y: dstBox.y + dstBox.height / 2 }
    )
    const samples = await sampleRowTransforms(mainWindow)
    const byId = new Map(samples.map((s) => [s.id, s]))
    expect(byId.get(rootA)?.transformY ?? 0).toBe(0)
    // rootTodo is past overIdx → identity.
    expect(byId.get(rootTodo)?.transformY ?? 0).toBe(0)
    await mainWindow.mouse.up()
  })

  // ====== 3-group inter-group drop slots ======
  // User reports two drop slots that "the pre-slide doesn't let you target":
  //  1) "between target group's header and its first item" (drop into top of
  //     a lower group when dragging from a higher group).
  //  2) "last spot of the upper group" (drop at the END of a higher group
  //     when dragging from a lower group).
  //
  // Visual layout (top → bottom): in_progress, done, todo
  //   A = in_progress (top)
  //   B = done        (middle, populated locally per test with rootDone)
  //   C = todo        (bottom, anchored by rootTodo)
  //
  // The dragged item starts in B (middle group). Both slots must be
  // reachable: B→C means drag DOWN into top of C; B→A means drag UP into
  // last spot of A.

  test("3-group drag B→C: drop just above C's first row lands source at idx 0 of C", async ({
    mainWindow
  }) => {
    const rootDone = await mainWindow.evaluate(
      (pid) => window.api.db.createTask({ projectId: pid, title: 'DnD Done', status: 'done' }),
      projectId
    )
    if (!rootDone) throw new Error('failed to create rootDone')
    try {
      // Lock rootDone's order ABOVE rootTodo's so the visible group order is
      // deterministic: in_progress (top, A) → done (middle, B) → todo (bottom,
      // C). Without this, rootDone defaults to order=0 (tied with rootA), and
      // `groupTreeRows` byKey insertion order can place 'done' group above
      // 'in_progress' depending on tasks-array iteration order.
      await mainWindow.evaluate(
        async ({ d, td }) => {
          await window.api.db.updateTask({ id: d, order: 2.5 })
          await window.api.db.updateTask({ id: td, order: 3 })
        },
        { d: rootDone.id, td: rootTodo }
      )
      await seed(mainWindow).refreshData()
      await expect(taskRow(mainWindow, rootDone.id)).toBeVisible({ timeout: 5_000 })

      // Source = rootDone (B, middle). Target = rootTodo (C, bottom).
      // Drag DOWN. Drop 2px above rootTodo's CURRENT top (the slot between
      // todo header and rootTodo).
      const srcBox = await taskRow(mainWindow, rootDone.id).boundingBox()
      if (!srcBox) throw new Error('source box missing')
      await dragFromTo(
        mainWindow,
        { x: srcBox.x + srcBox.width / 2, y: srcBox.y + srcBox.height / 2 },
        rowDropPoint(mainWindow, rootTodo, { yFrac: 0, yOffset: -2 })
      )
      await expect
        .poll(
          async () => {
            const d = await getTaskById(mainWindow, rootDone.id)
            const t = await getTaskById(mainWindow, rootTodo)
            if (!d || !t) return null
            return {
              dStatus: d.status,
              beforeRootTodo: d.order < t.order
            }
          },
          { timeout: 5_000 }
        )
        .toEqual({ dStatus: 'todo', beforeRootTodo: true })
    } finally {
      await mainWindow.evaluate((id) => window.api.db.deleteTask(id), rootDone.id)
    }
  })

  test("3-group drag B→A: drop just below A's last row lands source at end of A", async ({
    mainWindow
  }) => {
    const rootDone = await mainWindow.evaluate(
      (pid) => window.api.db.createTask({ projectId: pid, title: 'DnD Done', status: 'done' }),
      projectId
    )
    if (!rootDone) throw new Error('failed to create rootDone')
    try {
      // Lock `order` for ALL roots so the visible group order is deterministic:
      // in_progress (top, A) → done (middle) → todo (bottom). Without this,
      // rootDone defaults to order=0 (tied with rootA), and `groupTreeRows`
      // byKey insertion order can place 'done' group above 'in_progress'
      // depending on tasks-array iteration order. UpdateTaskInput has no
      // `order` field, so use `reorderTasks` (raw SQL UPDATE).
      await mainWindow.evaluate(
        ({ a, b, c, d, td }) =>
          window.api.db.reorderTasks([a, b, c, d, td]),
        { a: rootA, b: rootB, c: rootC, d: rootDone.id, td: rootTodo }
      )
      await seed(mainWindow).refreshData()
      await expect(taskRow(mainWindow, rootDone.id)).toBeVisible({ timeout: 5_000 })

      // Source = rootDone (B, middle). Target = rootC (last item of A=in_progress).
      // Drag UP. Drop 6px below rootC's CURRENT bottom (inter-group gap).
      const srcBox = await taskRow(mainWindow, rootDone.id).boundingBox()
      if (!srcBox) throw new Error('source box missing')
      await dragFromTo(
        mainWindow,
        { x: srcBox.x + srcBox.width / 2, y: srcBox.y + srcBox.height / 2 },
        rowDropPoint(mainWindow, rootC, { yFrac: 1, yOffset: 6 })
      )
      await expect
        .poll(
          async () => {
            const d = await getTaskById(mainWindow, rootDone.id)
            const c = await getTaskById(mainWindow, rootC)
            if (!d || !c) return null
            return {
              dStatus: d.status,
              afterRootC: d.order > c.order
            }
          },
          { timeout: 5_000 }
        )
        .toEqual({ dStatus: 'in_progress', afterRootC: true })
    } finally {
      await mainWindow.evaluate((id) => window.api.db.deleteTask(id), rootDone.id)
    }
  })

  // Drop-point variations to stress where pre-slide animation shows the gap
  // vs where the drop actually lands. With source ABOVE target in flat order
  // (B→C drag DOWN), `verticalListSortingStrategy` shifts target row UP by
  // source.height — visually opening a gap BELOW target's current position
  // (= at target's original slot). Users may aim at any of:
  //   (a) just above target's CURRENT top — header bbox region
  //   (b) target's CURRENT center
  //   (c) target's CURRENT bottom — boundary to the visual gap
  //   (d) inside the visual gap (= target's ORIGINAL slot)
  // All four must produce the same drop: source at idx 0 of target group.

  test('3-group B→C variations: drop on row at TOP lands AFTER target (arrayMove)', async ({
    mainWindow
  }) => {
    const rootDone = await mainWindow.evaluate(
      (pid) => window.api.db.createTask({ projectId: pid, title: 'DnD Done', status: 'done' }),
      projectId
    )
    if (!rootDone) throw new Error('failed to create rootDone')
    try {
      // Lock rootDone's order ABOVE rootTodo's so the visible group order is
      // deterministic: in_progress (top, A) → done (middle, B) → todo (bottom,
      // C). Without this, rootDone defaults to order=0 (tied with rootA), and
      // `groupTreeRows` byKey insertion order can place 'done' group above
      // 'in_progress' depending on tasks-array iteration order.
      await mainWindow.evaluate(
        async ({ d, td }) => {
          await window.api.db.updateTask({ id: d, order: 2.5 })
          await window.api.db.updateTask({ id: td, order: 3 })
        },
        { d: rootDone.id, td: rootTodo }
      )
      await seed(mainWindow).refreshData()
      await expect(taskRow(mainWindow, rootDone.id)).toBeVisible({ timeout: 5_000 })
      const srcBox = await taskRow(mainWindow, rootDone.id).boundingBox()
      if (!srcBox) throw new Error('src missing')
      await dragFromTo(
        mainWindow,
        { x: srcBox.x + srcBox.width / 2, y: srcBox.y + srcBox.height / 2 },
        rowDropPoint(mainWindow, rootTodo, { yFrac: 0.05 })
      )
      await expect
        .poll(
          async () => {
            const d = await getTaskById(mainWindow, rootDone.id)
            const t = await getTaskById(mainWindow, rootTodo)
            if (!d || !t) return null
            return { dStatus: d.status, beforeRootTodo: d.order < t.order }
          },
          { timeout: 5_000 }
        )
        .toEqual({ dStatus: 'todo', beforeRootTodo: false })
    } finally {
      await mainWindow.evaluate((id) => window.api.db.deleteTask(id), rootDone.id)
    }
  })

  test('3-group B→C variations: drop on row at CENTER lands AFTER target (arrayMove)', async ({
    mainWindow
  }) => {
    const rootDone = await mainWindow.evaluate(
      (pid) => window.api.db.createTask({ projectId: pid, title: 'DnD Done', status: 'done' }),
      projectId
    )
    if (!rootDone) throw new Error('failed to create rootDone')
    try {
      // Lock rootDone's order ABOVE rootTodo's so the visible group order is
      // deterministic: in_progress (top, A) → done (middle, B) → todo (bottom,
      // C). Without this, rootDone defaults to order=0 (tied with rootA), and
      // `groupTreeRows` byKey insertion order can place 'done' group above
      // 'in_progress' depending on tasks-array iteration order.
      await mainWindow.evaluate(
        async ({ d, td }) => {
          await window.api.db.updateTask({ id: d, order: 2.5 })
          await window.api.db.updateTask({ id: td, order: 3 })
        },
        { d: rootDone.id, td: rootTodo }
      )
      await seed(mainWindow).refreshData()
      await expect(taskRow(mainWindow, rootDone.id)).toBeVisible({ timeout: 5_000 })
      const srcBox = await taskRow(mainWindow, rootDone.id).boundingBox()
      if (!srcBox) throw new Error('src missing')
      await dragFromTo(
        mainWindow,
        { x: srcBox.x + srcBox.width / 2, y: srcBox.y + srcBox.height / 2 },
        rowDropPoint(mainWindow, rootTodo, { yFrac: 0.5 })
      )
      await expect
        .poll(
          async () => {
            const d = await getTaskById(mainWindow, rootDone.id)
            const t = await getTaskById(mainWindow, rootTodo)
            if (!d || !t) return null
            return { dStatus: d.status, beforeRootTodo: d.order < t.order }
          },
          { timeout: 5_000 }
        )
        .toEqual({ dStatus: 'todo', beforeRootTodo: false })
    } finally {
      await mainWindow.evaluate((id) => window.api.db.deleteTask(id), rootDone.id)
    }
  })

  test('3-group B→C variations: drop on row at BOTTOM lands AFTER target (arrayMove)', async ({
    mainWindow
  }) => {
    const rootDone = await mainWindow.evaluate(
      (pid) => window.api.db.createTask({ projectId: pid, title: 'DnD Done', status: 'done' }),
      projectId
    )
    if (!rootDone) throw new Error('failed to create rootDone')
    try {
      // Lock rootDone's order ABOVE rootTodo's so the visible group order is
      // deterministic: in_progress (top, A) → done (middle, B) → todo (bottom,
      // C). Without this, rootDone defaults to order=0 (tied with rootA), and
      // `groupTreeRows` byKey insertion order can place 'done' group above
      // 'in_progress' depending on tasks-array iteration order.
      await mainWindow.evaluate(
        async ({ d, td }) => {
          await window.api.db.updateTask({ id: d, order: 2.5 })
          await window.api.db.updateTask({ id: td, order: 3 })
        },
        { d: rootDone.id, td: rootTodo }
      )
      await seed(mainWindow).refreshData()
      await expect(taskRow(mainWindow, rootDone.id)).toBeVisible({ timeout: 5_000 })
      const srcBox = await taskRow(mainWindow, rootDone.id).boundingBox()
      if (!srcBox) throw new Error('src missing')
      await dragFromTo(
        mainWindow,
        { x: srcBox.x + srcBox.width / 2, y: srcBox.y + srcBox.height / 2 },
        rowDropPoint(mainWindow, rootTodo, { yFrac: 0.95 })
      )
      await expect
        .poll(
          async () => {
            const d = await getTaskById(mainWindow, rootDone.id)
            const t = await getTaskById(mainWindow, rootTodo)
            if (!d || !t) return null
            return { dStatus: d.status, beforeRootTodo: d.order < t.order }
          },
          { timeout: 5_000 }
        )
        .toEqual({ dStatus: 'todo', beforeRootTodo: false })
    } finally {
      await mainWindow.evaluate((id) => window.api.db.deleteTask(id), rootDone.id)
    }
  })

  test('3-group B→C variations: drop in pre-slide gap lands AFTER target (arrayMove)', async ({
    mainWindow
  }) => {
    const rootDone = await mainWindow.evaluate(
      (pid) => window.api.db.createTask({ projectId: pid, title: 'DnD Done', status: 'done' }),
      projectId
    )
    if (!rootDone) throw new Error('failed to create rootDone')
    try {
      // Lock rootDone's order ABOVE rootTodo's so the visible group order is
      // deterministic: in_progress (top, A) → done (middle, B) → todo (bottom,
      // C). Without this, rootDone defaults to order=0 (tied with rootA), and
      // `groupTreeRows` byKey insertion order can place 'done' group above
      // 'in_progress' depending on tasks-array iteration order.
      await mainWindow.evaluate(
        async ({ d, td }) => {
          await window.api.db.updateTask({ id: d, order: 2.5 })
          await window.api.db.updateTask({ id: td, order: 3 })
        },
        { d: rootDone.id, td: rootTodo }
      )
      await seed(mainWindow).refreshData()
      await expect(taskRow(mainWindow, rootDone.id)).toBeVisible({ timeout: 5_000 })
      // Capture rootTodo position BEFORE drag — that's the "visible gap"
      // position the user sees during pre-slide (target shifted up by
      // source.height, leaving its original slot empty).
      const dstBoxPre = await taskRow(mainWindow, rootTodo).boundingBox()
      const srcBox = await taskRow(mainWindow, rootDone.id).boundingBox()
      if (!srcBox || !dstBoxPre) throw new Error('boxes missing')
      await dragFromTo(
        mainWindow,
        { x: srcBox.x + srcBox.width / 2, y: srcBox.y + srcBox.height / 2 },
        // Static point — user aiming at where rootTodo USED to be (= the
        // visible pre-slide gap).
        { x: dstBoxPre.x + dstBoxPre.width / 2, y: dstBoxPre.y + dstBoxPre.height / 2 }
      )
      await expect
        .poll(
          async () => {
            const d = await getTaskById(mainWindow, rootDone.id)
            const t = await getTaskById(mainWindow, rootTodo)
            if (!d || !t) return null
            return { dStatus: d.status, beforeRootTodo: d.order < t.order }
          },
          { timeout: 5_000 }
        )
        .toEqual({ dStatus: 'todo', beforeRootTodo: false })
    } finally {
      await mainWindow.evaluate((id) => window.api.db.deleteTask(id), rootDone.id)
    }
  })

  test('drop within pinned group reorders pinned tasks', async ({ mainWindow }) => {
    // Pin rootA and rootB; drag rootA past rootB to reverse their order
    // inside the pinned bucket. Pin state survives; only `pin_order` changes
    // (the pinned-group reorder path).
    await patchStore(mainWindow, { treeGroupPinned: true })
    await setPinned(mainWindow, [rootA, rootB])
    await expect(taskRow(mainWindow, rootA)).toBeVisible({ timeout: 5_000 })
    await expect(taskRow(mainWindow, rootB)).toBeVisible()

    const srcBox = await taskRow(mainWindow, rootA).boundingBox()
    if (!srcBox) throw new Error('source row missing')
    await dragFromTo(
      mainWindow,
      { x: srcBox.x + srcBox.width / 2, y: srcBox.y + srcBox.height / 2 },
      rowDropPoint(mainWindow, rootB)
    )
    await expect
      .poll(() => getPinnedIds(mainWindow), { timeout: 5_000 })
      .toEqual([rootB, rootA])
    await setPinned(mainWindow, [])
    await patchStore(mainWindow, { treeGroupPinned: false })
  })

  test('drag out of pinned group unpins the task', async ({ mainWindow }) => {
    // Pin rootA, then drag it onto rootTodo. Expected: rootA unpinned.
    await patchStore(mainWindow, { treeGroupPinned: true })
    await setPinned(mainWindow, [rootA])
    await expect(taskRow(mainWindow, rootA)).toBeVisible({ timeout: 5_000 })

    const srcBox = await taskRow(mainWindow, rootA).boundingBox()
    if (!srcBox) throw new Error('source missing')
    await dragFromTo(
      mainWindow,
      { x: srcBox.x + srcBox.width / 2, y: srcBox.y + srcBox.height / 2 },
      rowDropPoint(mainWindow, rootTodo)
    )
    await expect.poll(() => getPinnedIds(mainWindow), { timeout: 5_000 }).toEqual([])
    await setPinned(mainWindow, [])
    await patchStore(mainWindow, { treeGroupPinned: false })
  })

  test('drop into pinned group pins the task', async ({ mainWindow }) => {
    // Pin rootB so the pinned bucket renders at the top of the tree.
    await patchStore(mainWindow, { treeGroupPinned: true })
    await setPinned(mainWindow, [rootB])
    await expect(taskRow(mainWindow, rootB)).toBeVisible({ timeout: 5_000 })

    const srcBox = await taskRow(mainWindow, rootA).boundingBox()
    if (!srcBox) throw new Error('source row missing')
    await dragFromTo(
      mainWindow,
      { x: srcBox.x + srcBox.width / 2, y: srcBox.y + srcBox.height / 2 },
      async () => {
        const pinnedHeader = mainWindow
          .locator(`[data-sidebar-tree-item="header"][data-group-key="__pinned__"]`)
          .first()
        const box = await pinnedHeader.boundingBox()
        if (!box) throw new Error('pinned header box missing')
        return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
      }
    )
    await expect
      .poll(() => getPinnedIds(mainWindow), { timeout: 5_000 })
      .toEqual(expect.arrayContaining([rootA, rootB]))
    // Clean up: unpin to restore default state.
    await setPinned(mainWindow, [])
    await patchStore(mainWindow, { treeGroupPinned: false })
  })

})
