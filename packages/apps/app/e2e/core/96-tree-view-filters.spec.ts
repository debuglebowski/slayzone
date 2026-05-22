import { test, expect, seed, resetApp } from '../fixtures/electron'
import { TEST_PROJECT_PATH } from '../fixtures/electron'
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

test.describe('TreeView setting combinations', () => {
  let projectId: string
  const projectName = 'Tree Test'
  let rootInProgress: string
  let rootTodo: string
  let rootDone: string
  let rootArchived: string
  let childInProgress: string
  let childDone: string
  let childTodo: string
  let tempDone: string
  let tempInProgress: string

  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
    const s = seed(mainWindow)
    const p = await s.createProject({
      name: projectName,
      color: '#3b82f6',
      path: TEST_PROJECT_PATH
    })
    projectId = p.id

    const t1 = await s.createTask({ projectId, title: 'Root in_progress', status: 'in_progress' })
    rootInProgress = t1.id
    const t2 = await s.createTask({ projectId, title: 'Root todo', status: 'todo' })
    rootTodo = t2.id
    const t3 = await s.createTask({ projectId, title: 'Root done', status: 'done' })
    rootDone = t3.id
    const t4 = await s.createTask({ projectId, title: 'Root archived', status: 'in_progress' })
    rootArchived = t4.id
    await s.archiveTask(rootArchived)

    const c1 = await mainWindow.evaluate(
      ({ pid, parentId }) =>
        window.api.db.createTask({
          projectId: pid,
          title: 'Child in_progress',
          status: 'in_progress',
          parentId
        }),
      { pid: projectId, parentId: rootDone }
    )
    childInProgress = c1!.id
    const c2 = await mainWindow.evaluate(
      ({ pid, parentId }) =>
        window.api.db.createTask({ projectId: pid, title: 'Child done', status: 'done', parentId }),
      { pid: projectId, parentId: rootInProgress }
    )
    childDone = c2!.id
    const c3 = await mainWindow.evaluate(
      ({ pid, parentId }) =>
        window.api.db.createTask({ projectId: pid, title: 'Child todo', status: 'todo', parentId }),
      { pid: projectId, parentId: rootInProgress }
    )
    childTodo = c3!.id

    const td = await mainWindow.evaluate(
      (pid) =>
        window.api.db.createTask({
          projectId: pid,
          title: 'Temp done',
          status: 'done',
          isTemporary: true
        }),
      projectId
    )
    tempDone = td!.id
    const tip = await mainWindow.evaluate(
      (pid) =>
        window.api.db.createTask({
          projectId: pid,
          title: 'Temp in_progress',
          status: 'in_progress',
          isTemporary: true
        }),
      projectId
    )
    tempInProgress = tip!.id

    await s.refreshData()
  })

  test.beforeEach(async ({ mainWindow }) => {
    // Kill any PTYs left over from prior tests — opening a task tab triggers
    // auto-spawn, leaking into sessionTaskIds and bypassing hide-inactive.
    await killAllPtys(mainWindow)
    // Force TreeView remount so openProjects useState initializer re-runs with
    // the current selectedProjectId (auto-expanding the test project).
    await patchStore(mainWindow, { sidebarView: 'projects' })
    await patchStore(mainWindow, {
      sidebarView: 'tree',
      selectedProjectId: projectId,
      treeStatusFilter: ['in_progress'],
      treePriorityFilter: [1, 2, 3, 4, 5],
      treeShowSubtasks: true,
      treeShowAllSubtasks: false,
      treeShowOnlyActive: false,
      treeShowTemporary: true,
      treeShowAllOpen: true,
      treeCrossOutDone: false,
      treeShowStatus: false,
      treeShowPriority: false,
      treeShowWorktree: false
    })
    await setPinned(mainWindow, [])
    // Anchor open tab keeps the project in TreeView's "active" set.
    await setTabs(mainWindow, [rootInProgress])
    await seed(mainWindow).refreshData()
    await ensureProjectExpanded(mainWindow, projectName)
    // Kill PTYs again — anchor tab mount likely auto-spawned terminals.
    await killAllPtys(mainWindow)
  })

  test('default filter shows in_progress only', async ({ mainWindow }) => {
    // Hide sub-tasks here to isolate the status filter behavior — with
    // sub-tasks shown (default) a matching descendant would pull its parent
    // in as an ancestor, covered in a separate test.
    await patchStore(mainWindow, { treeShowSubtasks: false })
    await expect(taskRow(mainWindow, rootInProgress)).toBeVisible()
    await expect(taskRow(mainWindow, rootTodo)).toHaveCount(0)
    await expect(taskRow(mainWindow, rootDone)).toHaveCount(0)
  })

  test('top toolbar remains a window drag region', async ({ mainWindow }) => {
    const regions = await mainWindow.evaluate(() => {
      const searchButton = document.querySelector<HTMLButtonElement>('button[aria-label="Search"]')
      const settingsButton = document.querySelector<HTMLButtonElement>(
        'button[aria-label="View settings"]'
      )
      const addButton = document.querySelector<HTMLButtonElement>(
        'button[aria-label="Add project"]'
      )
      const toolbar = searchButton?.parentElement?.parentElement as HTMLElement | null
      if (!toolbar || !searchButton || !settingsButton || !addButton) {
        throw new Error('Tree toolbar not found')
      }
      const region = (el: Element) => getComputedStyle(el).getPropertyValue('-webkit-app-region')
      return {
        toolbar: region(toolbar),
        search: region(searchButton),
        settings: region(settingsButton),
        add: region(addButton)
      }
    })

    expect(regions).toEqual({
      toolbar: 'drag',
      search: 'no-drag',
      settings: 'no-drag',
      add: 'no-drag'
    })
  })

  test('archived task never shows', async ({ mainWindow }) => {
    await patchStore(mainWindow, { treeStatusFilter: ['in_progress', 'todo', 'done'] })
    await expect(taskRow(mainWindow, rootArchived)).toHaveCount(0)
  })

  test('status filter chip extends visibility', async ({ mainWindow }) => {
    await patchStore(mainWindow, {
      treeStatusFilter: ['in_progress', 'todo'],
      treeShowSubtasks: false
    })
    await expect(taskRow(mainWindow, rootInProgress)).toBeVisible()
    await expect(taskRow(mainWindow, rootTodo)).toBeVisible()
    await expect(taskRow(mainWindow, rootDone)).toHaveCount(0)
  })

  test('open tab bypasses status filter (treeShowAllOpen on)', async ({ mainWindow }) => {
    await setTabs(mainWindow, [rootInProgress, rootDone])
    await expect(taskRow(mainWindow, rootDone)).toBeVisible()
  })

  test('treeShowAllOpen off: open tab does NOT bypass status filter', async ({ mainWindow }) => {
    await patchStore(mainWindow, { treeShowAllOpen: false, treeShowSubtasks: false })
    await setTabs(mainWindow, [rootInProgress, rootDone])
    await expect(taskRow(mainWindow, rootInProgress)).toBeVisible()
    await expect(taskRow(mainWindow, rootDone)).toHaveCount(0)
  })

  test('priority filter always applies — even to open-tab tasks', async ({ mainWindow }) => {
    await seed(mainWindow).updateTask({ id: rootDone, priority: 1 })
    await seed(mainWindow).refreshData()
    await patchStore(mainWindow, { treePriorityFilter: [4] })
    await setTabs(mainWindow, [rootInProgress, rootDone])
    // rootDone has open tab + treeShowAllOpen=true but its priority (1) is
    // not in the filter ([4]) → hidden. Priority is the one universal filter.
    await expect(taskRow(mainWindow, rootDone)).toHaveCount(0)
  })

  test('treeShowAllOpen on: open-tab task bypasses show-only-active', async ({ mainWindow }) => {
    await patchStore(mainWindow, { treeShowOnlyActive: true })
    await setTabs(mainWindow, [rootInProgress, rootDone])
    await killAllPtys(mainWindow)
    await expect(taskRow(mainWindow, rootDone)).toBeVisible()
  })

  test('treeShowAllOpen on: open-tab temp task bypasses temp filter', async ({ mainWindow }) => {
    await patchStore(mainWindow, { treeShowTemporary: false, treeShowSubtasks: false })
    await setTabs(mainWindow, [rootInProgress, tempInProgress])
    await expect(taskRow(mainWindow, tempInProgress)).toBeVisible()
  })

  test('priority filter limits visible tasks to selected priorities', async ({ mainWindow }) => {
    await seed(mainWindow).updateTask({ id: rootInProgress, priority: 1 })
    await seed(mainWindow).updateTask({ id: rootTodo, priority: 4 })
    await seed(mainWindow).refreshData()
    await patchStore(mainWindow, {
      treeStatusFilter: ['in_progress', 'todo'],
      treePriorityFilter: [1],
      treeShowSubtasks: false
    })
    await expect(taskRow(mainWindow, rootInProgress)).toBeVisible()
    await expect(taskRow(mainWindow, rootTodo)).toHaveCount(0)
  })

  test('show-all-subtasks: bypass adds task + parent chain only (not full subtree)', async ({
    mainWindow
  }) => {
    // Empty status filter → nothing strict-matches. But open tab on
    // childDone bypasses → childDone + rootInProgress (parent chain) shown.
    // childTodo (sibling, no open tab) should NOT be pulled in.
    await patchStore(mainWindow, {
      treeStatusFilter: [],
      treeShowSubtasks: true,
      treeShowAllSubtasks: true
    })
    await setTabs(mainWindow, [rootInProgress, childDone])
    await expect(taskRow(mainWindow, childDone)).toBeVisible()
    await expect(taskRow(mainWindow, rootInProgress)).toBeVisible()
    await expect(taskRow(mainWindow, childTodo)).toHaveCount(0)
  })

  test('priority filter applies to descendants in show-all-subtasks mode', async ({
    mainWindow
  }) => {
    // Root passes filter; child has different priority → child should be hidden.
    await seed(mainWindow).updateTask({ id: rootInProgress, priority: 1 })
    await seed(mainWindow).updateTask({ id: childTodo, priority: 3 })
    await seed(mainWindow).refreshData()
    await patchStore(mainWindow, {
      treeStatusFilter: ['in_progress'],
      treePriorityFilter: [1],
      treeShowSubtasks: true,
      treeShowAllSubtasks: true
    })
    await expect(taskRow(mainWindow, rootInProgress)).toBeVisible()
    await expect(taskRow(mainWindow, childTodo)).toHaveCount(0)
  })

  test('priority filter empty = no constraint (all priorities pass)', async ({ mainWindow }) => {
    await patchStore(mainWindow, {
      treeStatusFilter: ['in_progress', 'todo', 'done'],
      treePriorityFilter: [],
      treeShowSubtasks: false,
      treeShowAllOpen: false
    })
    await expect(taskRow(mainWindow, rootInProgress)).toBeVisible()
    await expect(taskRow(mainWindow, rootTodo)).toBeVisible()
    await expect(taskRow(mainWindow, rootDone)).toBeVisible()
  })

  test('show-subtasks off hides all children', async ({ mainWindow }) => {
    await patchStore(mainWindow, { treeShowSubtasks: false })
    await expect(taskRow(mainWindow, rootInProgress)).toBeVisible()
    await expect(taskRow(mainWindow, childDone)).toHaveCount(0)
    await expect(taskRow(mainWindow, childTodo)).toHaveCount(0)
  })

  test('show-subtasks on (match mode) shows matching children only', async ({ mainWindow }) => {
    await patchStore(mainWindow, {
      treeShowSubtasks: true,
      treeShowAllSubtasks: false,
      treeStatusFilter: ['in_progress']
    })
    // Parent rootInProgress matches; childInProgress is under rootDone (which does not match);
    // childTodo/childDone under rootInProgress are not in_progress → hidden.
    await expect(taskRow(mainWindow, rootInProgress)).toBeVisible()
    await expect(taskRow(mainWindow, childTodo)).toHaveCount(0)
    await expect(taskRow(mainWindow, childDone)).toHaveCount(0)
  })

  test('show-subtasks on: matching child pulls in non-matching parent', async ({ mainWindow }) => {
    await patchStore(mainWindow, {
      treeShowSubtasks: true,
      treeShowAllSubtasks: false,
      treeStatusFilter: ['in_progress']
    })
    // childInProgress is in_progress under rootDone (done); parent must climb in for hierarchy.
    await expect(taskRow(mainWindow, childInProgress)).toBeVisible()
    await expect(taskRow(mainWindow, rootDone)).toBeVisible()
  })

  test('show-all-subtasks pulls every descendant of matching root', async ({ mainWindow }) => {
    await patchStore(mainWindow, {
      treeShowSubtasks: true,
      treeShowAllSubtasks: true,
      treeStatusFilter: ['in_progress']
    })
    // rootInProgress matches → its entire subtree (childTodo, childDone) visible.
    await expect(taskRow(mainWindow, rootInProgress)).toBeVisible()
    await expect(taskRow(mainWindow, childTodo)).toBeVisible()
    await expect(taskRow(mainWindow, childDone)).toBeVisible()
  })

  test('show-all-subtasks ignored when show-subtasks is off', async ({ mainWindow }) => {
    // Even with all-subtasks on, the parent toggle gates rendering.
    await patchStore(mainWindow, {
      treeShowSubtasks: false,
      treeShowAllSubtasks: true,
      treeStatusFilter: ['in_progress']
    })
    await expect(taskRow(mainWindow, rootInProgress)).toBeVisible()
    await expect(taskRow(mainWindow, childTodo)).toHaveCount(0)
    await expect(taskRow(mainWindow, childDone)).toHaveCount(0)
  })

  test('show only active: open tab alone does not save inactive task', async ({ mainWindow }) => {
    await setTabs(mainWindow, [rootInProgress, rootDone])
    await killAllPtys(mainWindow)
    // Disable show-all-open so open-tab no longer bypasses filters.
    await patchStore(mainWindow, { treeShowOnlyActive: true, treeShowAllOpen: false })
    await expect(taskRow(mainWindow, rootInProgress)).toHaveCount(0)
    await expect(taskRow(mainWindow, rootDone)).toHaveCount(0)
  })

  test('show only active: pinned task always shows', async ({ mainWindow }) => {
    await patchStore(mainWindow, { treeShowOnlyActive: true })
    await setPinned(mainWindow, [rootDone])
    await expect(taskRow(mainWindow, rootDone)).toBeVisible()
  })

  test('show only active: non-pinned non-session tasks hidden', async ({ mainWindow }) => {
    await patchStore(mainWindow, {
      treeShowOnlyActive: true,
      treeStatusFilter: ['in_progress', 'todo', 'done'],
      treeShowAllOpen: false
    })
    await expect(taskRow(mainWindow, rootInProgress)).toHaveCount(0)
    await expect(taskRow(mainWindow, rootTodo)).toHaveCount(0)
    await expect(taskRow(mainWindow, rootDone)).toHaveCount(0)
  })

  test('cross-out-done applies strikethrough class to done task', async ({ mainWindow }) => {
    await patchStore(mainWindow, {
      treeCrossOutDone: true,
      treeStatusFilter: ['in_progress', 'done'],
      treeShowSubtasks: true,
      treeShowAllSubtasks: true
    })
    // rootDone needs to be visible somehow — pull in via subtask 'all' + childInProgress climb.
    // Easier: just open it as a tab.
    await setTabs(mainWindow, [rootInProgress, rootDone])
    const row = taskRow(mainWindow, rootDone).locator('span.line-through').first()
    await expect(row).toBeVisible()
  })

  test('show-priority renders priority icon', async ({ mainWindow }) => {
    await seed(mainWindow).updateTask({ id: rootInProgress, priority: 1 })
    await seed(mainWindow).refreshData()
    await patchStore(mainWindow, { treeShowPriority: true })
    const row = taskRow(mainWindow, rootInProgress)
    await expect(row.locator('svg').first()).toBeVisible()
  })

  test('show-status renders status icon', async ({ mainWindow }) => {
    await patchStore(mainWindow, { treeShowStatus: true })
    // Status icon rendered inside the row when treeShowStatus on.
    // Count of svg elements should increase relative to the no-status case;
    // just assert the row is visible and contains svg.
    const row = taskRow(mainWindow, rootInProgress)
    await expect(row).toBeVisible()
    expect(await row.locator('svg').count()).toBeGreaterThan(0)
  })

  test('temporary done task is hidden under default filter', async ({ mainWindow }) => {
    // Temporary tasks no longer bypass the status filter — a done temp task
    // with no open tab / session / pin should be hidden like any other.
    await patchStore(mainWindow, { treeShowSubtasks: false, treeStatusFilter: ['in_progress'] })
    await expect(taskRow(mainWindow, tempDone)).toHaveCount(0)
  })

  test('temporary in_progress task shows under default filter', async ({ mainWindow }) => {
    await patchStore(mainWindow, { treeShowSubtasks: false, treeStatusFilter: ['in_progress'] })
    await expect(taskRow(mainWindow, tempInProgress)).toBeVisible()
  })

  test('temporary done task shows when filter includes done', async ({ mainWindow }) => {
    await patchStore(mainWindow, { treeShowSubtasks: false, treeStatusFilter: ['done'] })
    await expect(taskRow(mainWindow, tempDone)).toBeVisible()
  })

  test('show-temporary off hides all temp tasks regardless of status', async ({ mainWindow }) => {
    await patchStore(mainWindow, {
      treeShowTemporary: false,
      treeStatusFilter: ['in_progress', 'todo', 'done'],
      treeShowSubtasks: false
    })
    await expect(taskRow(mainWindow, tempDone)).toHaveCount(0)
    await expect(taskRow(mainWindow, tempInProgress)).toHaveCount(0)
  })

  test('show-temporary off does not affect persistent tasks', async ({ mainWindow }) => {
    await patchStore(mainWindow, { treeShowTemporary: false, treeShowSubtasks: false })
    await expect(taskRow(mainWindow, rootInProgress)).toBeVisible()
  })

  test('pinned task is shortcut: bypasses temp filter when temp hidden', async ({ mainWindow }) => {
    // Per diagram: Pinned? -> Visible. Pinned bypasses every filter except
    // archived + priority. So a pinned temp task shows even with temp hidden.
    await patchStore(mainWindow, {
      treeShowSubtasks: false,
      treeShowTemporary: false
    })
    await setPinned(mainWindow, [tempInProgress])
    await expect(taskRow(mainWindow, tempInProgress)).toBeVisible()
  })

  test('pinned task is shortcut: bypasses show-only-active', async ({ mainWindow }) => {
    await patchStore(mainWindow, {
      treeShowSubtasks: false,
      treeShowOnlyActive: true,
      treeShowAllOpen: false
    })
    await setPinned(mainWindow, [rootDone])
    await expect(taskRow(mainWindow, rootDone)).toBeVisible()
  })

  test('pinned task is shortcut: bypasses status filter', async ({ mainWindow }) => {
    await patchStore(mainWindow, {
      treeShowSubtasks: false,
      treeStatusFilter: ['in_progress']
    })
    await setPinned(mainWindow, [rootDone])
    await expect(taskRow(mainWindow, rootDone)).toBeVisible()
  })

  test('priority filter applies to pinned tasks (universal — no shortcut)', async ({
    mainWindow
  }) => {
    // Diagram: Priority check comes BEFORE Pinned shortcut, so priority
    // always applies. Pinned with non-matching priority -> drop.
    await seed(mainWindow).updateTask({ id: rootDone, priority: 1 })
    await seed(mainWindow).refreshData()
    await patchStore(mainWindow, {
      treeShowSubtasks: false,
      treePriorityFilter: [4]
    })
    await setPinned(mainWindow, [rootDone])
    await expect(taskRow(mainWindow, rootDone)).toHaveCount(0)
  })

  test('temporary done task stays hidden when treeShowAllOpen off', async ({ mainWindow }) => {
    // With the toggle off, open-tab bypass is disabled — temp done task with
    // a tab is filtered out by status filter like any other task.
    await setTabs(mainWindow, [rootInProgress, tempDone])
    await killAllPtys(mainWindow)
    await patchStore(mainWindow, {
      treeShowSubtasks: false,
      treeStatusFilter: ['in_progress'],
      treeShowAllOpen: false
    })
    await expect(taskRow(mainWindow, tempDone)).toHaveCount(0)
  })

  test('default does NOT cross out done task', async ({ mainWindow }) => {
    await patchStore(mainWindow, {
      treeCrossOutDone: false,
      treeStatusFilter: ['in_progress', 'done']
    })
    await setTabs(mainWindow, [rootInProgress, rootDone])
    const struck = taskRow(mainWindow, rootDone).locator('span.line-through')
    await expect(struck).toHaveCount(0)
  })
})
