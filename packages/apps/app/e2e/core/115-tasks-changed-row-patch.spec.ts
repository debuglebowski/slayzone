import type { Page } from '@playwright/test'
import { test, expect, seed, openTaskById, resetApp, TEST_PROJECT_PATH } from '../fixtures/electron'

// `tasks-changed` cost, idle: every task write (agent state, attention, a renamed
// sub-task) used to reload the whole board (task.loadBoardData — all tasks, MBs
// with a real workspace) and make every open tab refetch its per-task queries.
// Now an event that names its rows patches just those rows (task.loadBoardRows),
// and a HIDDEN tab's per-task queries wait until the tab is shown.

/** Record the tRPC paths (+ inputs) this window sends from now on. */
async function recordSends(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as {
      __wp3Sent: { path: string; input: unknown }[]
      __wp3Restore?: () => void
    }
    w.__wp3Restore?.()
    w.__wp3Sent = []
    const orig = WebSocket.prototype.send
    WebSocket.prototype.send = function (data) {
      try {
        if (typeof data === 'string') {
          const parsed = JSON.parse(data) as unknown
          for (const m of Array.isArray(parsed) ? parsed : [parsed]) {
            const p = (m as { params?: { path?: string; input?: { json?: unknown } } }).params
            if (p?.path) w.__wp3Sent.push({ path: p.path, input: p.input?.json ?? p.input })
          }
        }
      } catch {
        /* not a tRPC frame */
      }
      return orig.call(this, data)
    }
    w.__wp3Restore = () => {
      WebSocket.prototype.send = orig
    }
  })
}

const sent = (page: Page) =>
  page.evaluate(
    () => (window as unknown as { __wp3Sent: { path: string; input: unknown }[] }).__wp3Sent
  )

const stopRecording = (page: Page) =>
  page.evaluate(() => (window as unknown as { __wp3Restore?: () => void }).__wp3Restore?.())

test.describe('tasks-changed: row patches + hidden-tab deferral', () => {
  test.afterEach(async ({ mainWindow }) => {
    await stopRecording(mainWindow)
  })

  test('a task write reaches an open tab as a row patch, never a full board reload', async ({
    mainWindow
  }) => {
    await resetApp(mainWindow)
    const s = seed(mainWindow)
    const p = await s.createProject({
      name: 'Row Patch',
      color: '#22c55e',
      path: TEST_PROJECT_PATH
    })
    const a = await s.createTask({ projectId: p.id, title: 'RP task', status: 'todo' })
    await s.refreshData()
    await openTaskById(mainWindow, a.id)
    await mainWindow.waitForTimeout(1_000) // let the open's own writes settle

    await recordSends(mainWindow)
    await s.updateTask({ id: a.id, dueDate: '2026-12-24' })
    // The tab shows the new due date — it came through the board.
    await mainWindow.waitForFunction(
      () => /Dec 2[34], 2026/.test(document.body.textContent ?? ''),
      undefined,
      { timeout: 10_000 }
    )
    const paths = (await sent(mainWindow)).map((m) => m.path)
    expect(paths).toContain('task.loadBoardRows')
    expect(paths).not.toContain('task.loadBoardData')
  })

  test("a hidden tab's sub-tasks are not refetched while hidden, and are fresh on reveal", async ({
    mainWindow
  }) => {
    await resetApp(mainWindow)
    const s = seed(mainWindow)
    const p = await s.createProject({
      name: 'Hidden Subs',
      color: '#3b82f6',
      path: TEST_PROJECT_PATH
    })
    const parent = await s.createTask({ projectId: p.id, title: 'HS parent', status: 'todo' })
    const sub = await s.createTask({
      projectId: p.id,
      parentId: parent.id,
      title: 'Sub before',
      status: 'todo'
    })
    const other = await s.createTask({ projectId: p.id, title: 'HS other', status: 'todo' })
    await s.refreshData()

    await openTaskById(mainWindow, parent.id)
    const subtasks = mainWindow
      .getByTestId('task-settings-panel')
      .filter({ visible: true })
      .getByTestId('settings-subtasks-card')
    await expect(subtasks.getByText('Sub before')).toBeVisible({ timeout: 10_000 })

    await openTaskById(mainWindow, other.id) // parent's tab is now hidden
    await mainWindow.waitForTimeout(1_000)
    await recordSends(mainWindow)
    await s.updateTask({ id: sub.id, title: 'Sub after' })
    await mainWindow.waitForTimeout(1_500)
    const isParentSubs = (m: { path: string; input: unknown }) =>
      m.path === 'task.getSubTasks' &&
      (m.input as { parentId?: string } | null)?.parentId === parent.id
    expect((await sent(mainWindow)).filter(isParentSubs)).toHaveLength(0)

    await openTaskById(mainWindow, parent.id)
    await expect(subtasks.getByText('Sub after')).toBeVisible({ timeout: 10_000 })
    expect((await sent(mainWindow)).filter(isParentSubs).length).toBeGreaterThanOrEqual(1)
  })

  test('archiving a task patches its row, never a full board reload', async ({ mainWindow }) => {
    await resetApp(mainWindow)
    const s = seed(mainWindow)
    const p = await s.createProject({
      name: 'Archive Patch',
      color: '#a855f7',
      path: TEST_PROJECT_PATH
    })
    const a = await s.createTask({ projectId: p.id, title: 'AP task', status: 'todo' })
    await s.refreshData()
    await openTaskById(mainWindow, a.id)
    await mainWindow.waitForTimeout(1_000)

    await recordSends(mainWindow)
    await s.archiveTask(a.id)
    await mainWindow.waitForFunction(
      () =>
        (window as unknown as { __wp3Sent: { path: string }[] }).__wp3Sent.some(
          (m) => m.path === 'task.loadBoardRows'
        ),
      undefined,
      { timeout: 10_000 }
    )
    await mainWindow.waitForTimeout(500)
    expect((await sent(mainWindow)).map((m) => m.path)).not.toContain('task.loadBoardData')
  })

  test('a tag rename reloads the tags alone, never the board', async ({ mainWindow }) => {
    await resetApp(mainWindow)
    const s = seed(mainWindow)
    const p = await s.createProject({
      name: 'Tag Patch',
      color: '#f97316',
      path: TEST_PROJECT_PATH
    })
    await s.createTask({ projectId: p.id, title: 'TP task', status: 'todo' })
    const tag = await s.createTag({ name: 'before', projectId: p.id })
    await s.refreshData()
    await mainWindow.waitForTimeout(1_000)

    await recordSends(mainWindow)
    await s.updateTag({ id: tag.id, name: 'after' })
    await mainWindow.waitForFunction(
      () =>
        (window as unknown as { __wp3Sent: { path: string }[] }).__wp3Sent.some(
          (m) => m.path === 'tags.list'
        ),
      undefined,
      { timeout: 10_000 }
    )
    await mainWindow.waitForTimeout(500)
    expect((await sent(mainWindow)).map((m) => m.path)).not.toContain('task.loadBoardData')
  })

  test('focusing the window never reloads the board, even once it is stale', async ({
    mainWindow
  }) => {
    test.setTimeout(60_000) // waits out the board's 30s staleTime
    await resetApp(mainWindow)
    const s = seed(mainWindow)
    await s.createProject({ name: 'Focus', color: '#14b8a6', path: TEST_PROJECT_PATH })
    await s.refreshData()
    // Past the board query's staleTime (30s): a focus refetch would fire now.
    await mainWindow.waitForTimeout(31_000)
    await recordSends(mainWindow)
    await mainWindow.evaluate(() => {
      window.dispatchEvent(new Event('visibilitychange'))
      window.dispatchEvent(new Event('focus'))
    })
    await mainWindow.waitForTimeout(1_500)
    const paths = (await sent(mainWindow)).map((m) => m.path)
    // The focus did reach react-query: other stale queries refetched on it.
    expect(paths.length).toBeGreaterThan(0)
    expect(paths).not.toContain('task.loadBoardData')
  })

  test('opening a task page never reloads the board, even once it is stale', async ({
    mainWindow
  }) => {
    test.setTimeout(60_000) // waits out the board's former 30s staleTime
    await resetApp(mainWindow)
    const s = seed(mainWindow)
    const p = await s.createProject({ name: 'Open', color: '#eab308', path: TEST_PROJECT_PATH })
    const a = await s.createTask({ projectId: p.id, title: 'Open me', status: 'todo' })
    await s.refreshData()
    await mainWindow.waitForTimeout(31_000)
    await recordSends(mainWindow)
    // Its page reads every task (blockers picker, palette): from the board it holds.
    await openTaskById(mainWindow, a.id)
    await mainWindow.waitForTimeout(1_500)
    expect((await sent(mainWindow)).map((m) => m.path)).not.toContain('task.loadBoardData')
  })

  test('the board carries card rows; an opened task still shows its description', async ({
    mainWindow
  }) => {
    await resetApp(mainWindow)
    const s = seed(mainWindow)
    const p = await s.createProject({ name: 'Cards', color: '#0ea5e9', path: TEST_PROJECT_PATH })
    const a = await s.createTask({
      projectId: p.id,
      title: 'Card task',
      status: 'todo',
      description: 'Only the full row carries this sentence.'
    })
    await recordSends(mainWindow)
    await s.refreshData()
    // The app asks for card rows…
    const boardAsks = (await sent(mainWindow)).filter((m) => m.path === 'task.loadBoardData')
    expect(boardAsks.length).toBeGreaterThan(0)
    for (const m of boardAsks) expect(m.input).toEqual({ rows: 'card' })
    // …which carry no description.
    const boardHasDescription = await mainWindow.evaluate(async (id) => {
      const rows = (await window
        .getTrpcVanillaClient()
        .task.loadBoardData.query({ rows: 'card' })) as { tasks: { id: string }[] }
      return 'description' in (rows.tasks.find((t) => t.id === id) ?? {})
    }, a.id)
    expect(boardHasDescription).toBe(false)
    await openTaskById(mainWindow, a.id)
    await expect(
      mainWindow.getByText('Only the full row carries this sentence.').first()
    ).toBeVisible({ timeout: 10_000 })
  })
})
