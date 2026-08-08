import { test, expect, seed, goHome, clickProject, resetApp } from '../fixtures/electron'
import { TEST_PROJECT_PATH } from '../fixtures/electron'

test.describe('Kanban keyboard shortcuts', () => {
  let projectAbbrev: string
  let taskIds: Record<string, string>

  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
    const s = seed(mainWindow)
    const p = await s.createProject({ name: 'Keyb Nav', color: '#06b6d4', path: TEST_PROJECT_PATH })
    projectAbbrev = p.name.slice(0, 2).toUpperCase()

    taskIds = {}
    // Two tasks in todo column
    const t1 = await s.createTask({
      projectId: p.id,
      title: 'KN todo-1',
      status: 'todo',
      priority: 3
    })
    const t2 = await s.createTask({
      projectId: p.id,
      title: 'KN todo-2',
      status: 'todo',
      priority: 3
    })
    // One task in in_progress
    const t3 = await s.createTask({
      projectId: p.id,
      title: 'KN prog-1',
      status: 'in_progress',
      priority: 2
    })
    // Two tasks in review
    const t4 = await s.createTask({
      projectId: p.id,
      title: 'KN rev-1',
      status: 'review',
      priority: 3
    })
    const t5 = await s.createTask({
      projectId: p.id,
      title: 'KN rev-2',
      status: 'review',
      priority: 4
    })
    taskIds = { t1: t1.id, t2: t2.id, t3: t3.id, t4: t4.id, t5: t5.id }

    await s.refreshData()
    await goHome(mainWindow)
    await clickProject(mainWindow, projectAbbrev)
    await expect(mainWindow.getByText('KN todo-1').first()).toBeVisible({ timeout: 5_000 })
  })

  /** Returns the data-task-id of the currently focused VISIBLE card (has ring-primary class) */
  async function focusedTaskId(page: import('@playwright/test').Page): Promise<string | null> {
    return page.evaluate(() => {
      for (const el of document.querySelectorAll('[data-task-id]')) {
        const htmlEl = el as HTMLElement
        // offsetParent is null for display:none; closest('.invisible') catches visibility:hidden tabs
        if (
          el.className.includes('ring-primary') &&
          htmlEl.offsetParent !== null &&
          !el.closest('.invisible')
        ) {
          return el.getAttribute('data-task-id')
        }
      }
      return null
    })
  }

  /** Press a key and wait for React to process the state change */
  async function press(page: import('@playwright/test').Page, key: string) {
    await page.keyboard.press(key)
    // Give React time to process the keypress and re-render.
    // 100ms is too tight under parallel load — use rAF + microtask flush instead.
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0))))
  }

  /**
   * Task ids per visible non-empty column, in the order the board renders them.
   *
   * READ, never assumed. `tasks."order"` is `NOT NULL DEFAULT 0` and no create
   * path sets it, and `created_at` defaults to second-granular `datetime('now')`
   * — so two tasks seeded in the same second tie on BOTH board sort keys and
   * their relative order is decided by the query, not by creation sequence.
   *
   * Six tests in this file used to hard-code `taskIds.t1` as "first in todo".
   * Whichever one happened to run when the tie resolved the other way is the one
   * that reported, so this single bug surfaced as `J/K` one run and `H/L` the
   * next and looked like two unrelated flakes. It also looked host-correlated
   * for a reason that has nothing to do with the host: a slower box widens the
   * gap between the two seeded INSERTs, making them likelier to land in
   * different seconds — at which point `created_at DESC` puts the SECOND task
   * first, deterministically.
   *
   * Deriving the order keeps these tests honest about what they actually assert
   * (J/K moves within a column, H/L moves across) under either ordering.
   */
  async function columnIds(page: import('@playwright/test').Page): Promise<string[][]> {
    return page.evaluate(() => {
      const out: string[][] = []
      for (const col of document.querySelectorAll('[data-testid="kanban-column"]')) {
        const el = col as HTMLElement
        if (el.offsetParent === null || col.closest('.invisible')) continue
        const ids = Array.from(col.querySelectorAll('[data-task-id]'))
          .map((c) => c.getAttribute('data-task-id'))
          .filter((id): id is string => !!id)
        if (ids.length > 0) out.push(ids)
      }
      return out
    })
  }

  test('J/K navigates within column', async ({ mainWindow }) => {
    const [todo] = await columnIds(mainWindow)

    // First press focuses first task in first non-empty column (todo)
    await press(mainWindow, 'j')
    expect(await focusedTaskId(mainWindow)).toBe(todo[0])

    // J moves down to second task
    await press(mainWindow, 'j')
    expect(await focusedTaskId(mainWindow)).toBe(todo[1])

    // K moves back up
    await press(mainWindow, 'k')
    expect(await focusedTaskId(mainWindow)).toBe(todo[0])

    // K at top stays on first task
    await press(mainWindow, 'k')
    expect(await focusedTaskId(mainWindow)).toBe(todo[0])
  })

  test('H/L navigates across columns', async ({ mainWindow }) => {
    const [todo, prog, review] = await columnIds(mainWindow)

    // Start on the first todo card
    await press(mainWindow, 'Escape')
    await press(mainWindow, 'j')
    expect(await focusedTaskId(mainWindow)).toBe(todo[0])

    // L moves to in_progress column
    await press(mainWindow, 'l')
    expect(await focusedTaskId(mainWindow)).toBe(prog[0])

    // L moves to review column
    await press(mainWindow, 'l')
    expect(await focusedTaskId(mainWindow)).toBe(review[0])

    // H moves back to in_progress
    await press(mainWindow, 'h')
    expect(await focusedTaskId(mainWindow)).toBe(prog[0])
  })

  test('H/L clamps row index on shorter columns', async ({ mainWindow }) => {
    const [, prog, review] = await columnIds(mainWindow)

    // Navigate to review, second row
    await press(mainWindow, 'Escape')
    await press(mainWindow, 'j')
    // Focus first todo card, then L to in_progress (1 task), then L to review
    await press(mainWindow, 'l')
    await press(mainWindow, 'l')
    // Now on review row 0, go to row 1
    await press(mainWindow, 'j')
    expect(await focusedTaskId(mainWindow)).toBe(review[1])

    // H to in_progress which only has 1 task — should clamp to row 0
    await press(mainWindow, 'h')
    expect(await focusedTaskId(mainWindow)).toBe(prog[0])
  })

  test('Enter opens task in tab', async ({ mainWindow }) => {
    const [todo] = await columnIds(mainWindow)

    await press(mainWindow, 'Escape')
    await press(mainWindow, 'j') // focus first todo card
    await press(mainWindow, 'Enter')

    // Task tab opened — kanban card is now hidden (home tab inactive)
    // Use data-task-id which only exists on kanban cards, not tab labels
    await expect(mainWindow.locator(`[data-task-id="${todo[0]}"]`)).toBeHidden({
      timeout: 3_000
    })

    // Go back home for next tests
    await goHome(mainWindow)
    await clickProject(mainWindow, projectAbbrev)
  })

  test('S opens status picker, number key selects', async ({ mainWindow }) => {
    const [todo] = await columnIds(mainWindow)

    await press(mainWindow, 'Escape')
    await press(mainWindow, 'j') // focus first todo card
    expect(await focusedTaskId(mainWindow)).toBe(todo[0])

    // Press S to open status picker
    await press(mainWindow, 's')

    // Picker should be visible with status options
    await expect(mainWindow.getByText('In Progress').last()).toBeVisible({ timeout: 2_000 })

    // Press 4 to select "In Progress" (4th status: inbox=1, backlog=2, todo=3, in_progress=4)
    await press(mainWindow, '4')

    // Verify task moved — DB should reflect the change
    const s = seed(mainWindow)
    await s.refreshData()
    const tasks = await s.getTasks()
    const updated = tasks.find((t: any) => t.id === todo[0])
    expect(updated?.status).toBe('in_progress')

    // Restore for subsequent tests
    await s.updateTask({ id: todo[0], status: 'todo' })
    await s.refreshData()
  })

  test('P opens priority picker, number key selects', async ({ mainWindow }) => {
    const [todo] = await columnIds(mainWindow)

    await press(mainWindow, 'Escape')
    await press(mainWindow, 'j') // focus first todo card
    expect(await focusedTaskId(mainWindow)).toBe(todo[0])

    // Press P to open priority picker
    await press(mainWindow, 'p')

    // Picker should show priority options
    await expect(mainWindow.getByText('Urgent').last()).toBeVisible({ timeout: 2_000 })

    // Press 1 to select Urgent
    await press(mainWindow, '1')

    // Verify priority changed
    const s = seed(mainWindow)
    await s.refreshData()
    const tasks = await s.getTasks()
    const updated = tasks.find((t: any) => t.id === todo[0])
    expect(updated?.priority).toBe(1)

    // Restore
    await s.updateTask({ id: todo[0], priority: 3 } as any)
    await s.refreshData()
  })

  test('Escape closes picker then clears focus', async ({ mainWindow }) => {
    await press(mainWindow, 'Escape') // clear any existing focus
    await press(mainWindow, 'j') // focus first task
    expect(await focusedTaskId(mainWindow)).not.toBeNull()

    // Open picker
    await press(mainWindow, 's')
    await expect(mainWindow.getByText('Inbox').last()).toBeVisible({ timeout: 2_000 })

    // Escape closes picker (focus stays)
    await press(mainWindow, 'Escape')
    expect(await focusedTaskId(mainWindow)).not.toBeNull()

    // Escape again clears focus
    await press(mainWindow, 'Escape')
    expect(await focusedTaskId(mainWindow)).toBeNull()
  })

  test('hover seeds focus for keyboard navigation', async ({ mainWindow }) => {
    await press(mainWindow, 'Escape') // clear focus
    expect(await focusedTaskId(mainWindow)).toBeNull()

    // Hover over a card
    const card = mainWindow.locator(`[data-task-id="${taskIds.t4}"]`).first()
    await card.hover()
    // Hover no longer sets keyboard focus directly; it seeds the starting point.
    await press(mainWindow, 'j')
    expect(await focusedTaskId(mainWindow)).toBe(taskIds.t4)
  })

  test('shortcuts inactive on task tab', async ({ mainWindow }) => {
    // Open a task tab
    await press(mainWindow, 'Escape')
    await press(mainWindow, 'j')
    await press(mainWindow, 'Enter')
    await mainWindow.waitForTimeout(300)

    // Clear any focus from before by pressing Escape
    await press(mainWindow, 'Escape')

    // Press J — should NOT change kanban focus (we're on task tab)
    await press(mainWindow, 'j')
    // No focus ring should exist on kanban cards
    expect(await focusedTaskId(mainWindow)).toBeNull()

    // Go back home
    await goHome(mainWindow)
    await clickProject(mainWindow, projectAbbrev)
  })
})
