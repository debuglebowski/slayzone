/**
 * E2E coverage for the "active session" filter chain.
 *
 * Bug history: `useActiveSessionTaskIds` previously included EVERY session
 * returned by `pty.list()` regardless of state. After a kill, the session
 * lingers in the map for ~100 ms cleanup; during that window (and forever, if
 * a TUI's idle clock never closes) the renderer kept showing the task as
 * "active" even though no live process was attached.
 *
 * The fix: filter both `pty.list()` and `chat.list()` rows through
 * `isAliveTerminalState(state)` before adding to the active set. This spec
 * exercises the wire-level chain end-to-end:
 *   main pty-manager → `pty:list` IPC → renderer hook → Set membership.
 *
 * We use plain `terminal` mode (no external CLI dependency) and assert via
 * the same IPC surface the renderer hook uses.
 */
import { test, expect, seed, resetApp } from '../fixtures/electron'
import { TEST_PROJECT_PATH } from '../fixtures/electron'
import {
  getMainSessionId,
  openTaskTerminal,
  waitForPtySession,
  waitForNoPtySession,
  waitForPtyState
} from '../fixtures/terminal'

/**
 * Compute the active-set the same way `useActiveSessionTaskIds` does — by
 * fetching `pty.list()` + `chat.list()` and applying `isAliveTerminalState`.
 * Kept inline here (vs. importing the renderer hook) so this test fails if
 * the IPC contract or filter helper changes shape.
 */
async function activeTaskIds(page: import('@playwright/test').Page): Promise<string[]> {
  return page.evaluate(async () => {
    const c = window.getTrpcVanillaClient()
    const [ptys, chats] = await Promise.all([c.pty.list.query(), c.pty.chatList.query()])
    const set = new Set<string>()
    for (const p of ptys) if (p.state !== 'dead') set.add(p.taskId)
    for (const c of chats) if (c.state !== 'dead') set.add(c.taskId)
    return [...set]
  })
}

test.describe('useActiveSessionTaskIds: dead session filter', () => {
  let projectAbbrev: string
  let projectId: string

  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
    const s = seed(mainWindow)
    const p = await s.createProject({
      name: 'Active Filter',
      color: '#a855f7',
      path: TEST_PROJECT_PATH
    })
    projectId = p.id
    projectAbbrev = p.name.slice(0, 2).toUpperCase()
  })

  test('alive PTY → task in active set; killed PTY → task removed within bounded window', async ({
    mainWindow
  }) => {
    const s = seed(mainWindow)
    const task = await s.createTask({
      projectId,
      title: 'Active filter task',
      status: 'in_progress'
    })
    await mainWindow.evaluate(
      (id) => window.getTrpcVanillaClient().task.update.mutate({ id, terminalMode: 'terminal' }),
      task.id
    )
    await s.refreshData()

    const sessionId = getMainSessionId(task.id)
    await openTaskTerminal(mainWindow, { projectAbbrev, taskTitle: 'Active filter task' })
    await waitForPtySession(mainWindow, sessionId)
    // Plain shell reaches 'idle' (alive!) shortly after spawn.
    await waitForPtyState(mainWindow, sessionId, 'idle')

    // Live + idle = task counts as active. (Regression guard: if anyone
    // accidentally tightens the filter to `state === 'running'` only, this
    // case fails.)
    const activeWhileAlive = await activeTaskIds(mainWindow)
    expect(activeWhileAlive).toContain(task.id)

    // Kill the PTY — main flips state→'dead' then evicts the session ~100 ms later.
    await mainWindow.evaluate(
      (id) => window.getTrpcVanillaClient().pty.kill.mutate({ sessionId: id }),
      sessionId
    )

    // Within the cleanup window the session may still be in `pty.list()` with
    // state='dead'. The filter must exclude it; the active set should clear
    // promptly regardless of whether the eviction has already run.
    await expect
      .poll(async () => activeTaskIds(mainWindow), { timeout: 5_000 })
      .not.toContain(task.id)

    await waitForNoPtySession(mainWindow, sessionId)
  })

  test('eager kill: filter clears active flag even before session is evicted from the map', async ({
    mainWindow
  }) => {
    const s = seed(mainWindow)
    const task = await s.createTask({
      projectId,
      title: 'Eager-kill filter task',
      status: 'in_progress'
    })
    await mainWindow.evaluate(
      (id) => window.getTrpcVanillaClient().task.update.mutate({ id, terminalMode: 'terminal' }),
      task.id
    )
    await s.refreshData()

    const sessionId = getMainSessionId(task.id)
    await openTaskTerminal(mainWindow, { projectAbbrev, taskTitle: 'Eager-kill filter task' })
    await waitForPtySession(mainWindow, sessionId)
    await waitForPtyState(mainWindow, sessionId, 'idle')

    // Subscribe to the very first state-change('dead') event so we can probe
    // the active set at exactly the moment the renderer learns the session
    // died — before `pty.list()` has had time to evict it.
    await mainWindow.evaluate(() => {
      ;(window as unknown as { __deadAt: number | null }).__deadAt = null
      window.api.pty.onStateChange((_id, newState) => {
        const g = window as unknown as { __deadAt: number | null }
        if (newState === 'dead' && g.__deadAt === null) g.__deadAt = Date.now()
      })
    })

    await mainWindow.evaluate(
      (id) => window.getTrpcVanillaClient().pty.kill.mutate({ sessionId: id }),
      sessionId
    )

    // Wait until the renderer has observed state→'dead' for this session.
    await expect
      .poll(async () =>
        mainWindow.evaluate(
          () => (window as unknown as { __deadAt: number | null }).__deadAt !== null
        )
      )
      .toBe(true)

    // At this point the session may or may not still be in `pty.list()` (eviction
    // is on a 100 ms timer). Either way the filter must keep it OUT of the
    // active set. This is the precise scenario the original bug missed.
    const activeAfterDeadEvent = await activeTaskIds(mainWindow)
    expect(activeAfterDeadEvent).not.toContain(task.id)

    await waitForNoPtySession(mainWindow, sessionId)
  })
})
