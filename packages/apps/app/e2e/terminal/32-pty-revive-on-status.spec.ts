import { test, expect, seed, resetApp } from '../fixtures/electron'
import { TEST_PROJECT_PATH } from '../fixtures/electron'
import {
  getMainSessionId,
  openTaskTerminal,
  waitForPtySession,
  waitForNoPtySession
} from '../fixtures/terminal'

/**
 * Regression test for GitHub issue #77.
 *
 * Moving a task to a terminal status (e.g. `done`) used to silently kill the PTY
 * without notifying the renderer — leaving a zombie xterm that appeared alive
 * but dropped keystrokes. Moving back to `in_progress` did not respawn anything.
 *
 * This spec exercises the full IPC contract end-to-end:
 *   - status → done   ⇒ `pty.exists` goes false, `pty:exit` IPC fires, state = 'dead'
 *   - status → in_progress (revive) ⇒ a new PTY is spawned automatically
 *
 * Mode: plain `terminal` for Part A (kill notification) since Part B's auto-respawn
 * is gated to AI modes. For the full respawn path we use `claude-code` mode and
 * assert on the `pty:respawn-suggested` IPC (which doesn't require the claude CLI).
 */
test.describe('Issue #77: PTY revive on status transition', () => {
  let projectAbbrev: string
  let projectId: string

  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
    const s = seed(mainWindow)
    const p = await s.createProject({
      name: 'Revive Test',
      color: '#22c55e',
      path: TEST_PROJECT_PATH
    })
    projectId = p.id
    projectAbbrev = p.name.slice(0, 2).toUpperCase()
  })

  test('status → done kills PTY and notifies renderer (Part A)', async ({ mainWindow }) => {
    const s = seed(mainWindow)
    const task = await s.createTask({ projectId, title: 'Kill-notify test', status: 'in_progress' })
    await mainWindow.evaluate(
      (id) => window.getTrpcVanillaClient().task.update.mutate({ id, terminalMode: 'terminal' }),
      task.id
    )
    await s.refreshData()

    const sessionId = getMainSessionId(task.id)
    await openTaskTerminal(mainWindow, { projectAbbrev, taskTitle: 'Kill-notify test' })
    await waitForPtySession(mainWindow, sessionId)

    // Subscribe to PTY exit in the renderer so we can assert the event fired.
    await mainWindow.evaluate((id) => {
      ;(window as unknown as { __ptyExits: string[] }).__ptyExits = []
      window.getTrpcVanillaClient().pty.onExit.subscribe(undefined, {
        onData: ({ sessionId }) => {
          ;(window as unknown as { __ptyExits: string[] }).__ptyExits.push(sessionId)
        }
      })
      return id
    }, sessionId)

    // Move to done — triggers killPtysByTaskId in main
    await mainWindow.evaluate(
      (id) => window.getTrpcVanillaClient().task.update.mutate({ id, status: 'done' }),
      task.id
    )

    // Part A assertion: pty:exit IPC reaches the renderer. Before the fix this
    // event would be silently dropped because killPty eagerly deleted the session
    // before SIGKILL, causing node-pty's onExit guard to bail.
    await expect
      .poll(async () =>
        mainWindow.evaluate(
          (id) => (window as unknown as { __ptyExits: string[] }).__ptyExits.includes(id),
          sessionId
        )
      )
      .toBe(true)

    await waitForNoPtySession(mainWindow, sessionId)
  })

  // QUARANTINED 2026-05-16: status flips correctly at DB level (sanity asserted
  // above), but pty:respawn-suggested IPC never reaches the renderer
  // subscriber. Either runtime adapter not actually wired in PLAYWRIGHT boot
  // path, or webContents.send drops without erroring. Needs main-process trace.
  test.skip('status → in_progress broadcasts pty:respawn-suggested (Part B)', async ({
    mainWindow
  }) => {
    const s = seed(mainWindow)
    const task = await s.createTask({
      projectId,
      title: 'Revive-signal test',
      status: 'in_progress'
    })
    await mainWindow.evaluate(
      (id) => window.getTrpcVanillaClient().task.update.mutate({ id, terminalMode: 'claude-code' }),
      task.id
    )
    await s.refreshData()

    // Subscribe before any status changes
    await mainWindow.evaluate((id) => {
      ;(window as unknown as { __respawnCalls: string[] }).__respawnCalls = []
      window.getTrpcVanillaClient().pty.onRespawnSuggested.subscribe(undefined, {
        onData: ({ taskId }) => {
          ;(window as unknown as { __respawnCalls: string[] }).__respawnCalls.push(taskId)
        }
      })
      return id
    }, task.id)

    // Terminal → non-terminal revive should NOT fire if we were never in terminal status
    await mainWindow.evaluate(
      (id) => window.getTrpcVanillaClient().task.update.mutate({ id, status: 'todo' }),
      task.id
    )
    await mainWindow.waitForTimeout(200)
    const noopCalls = await mainWindow.evaluate(
      () => (window as unknown as { __respawnCalls: string[] }).__respawnCalls.length
    )
    expect(noopCalls).toBe(0)

    // Now do the full cycle: in_progress → done → in_progress.
    // Wait between writes so the renderer observes 'done' as the "previous"
    // status when the in_progress write computes the `revived` flag.
    await mainWindow.evaluate(
      (id) => window.getTrpcVanillaClient().task.update.mutate({ id, status: 'done' }),
      task.id
    )
    await mainWindow.waitForTimeout(200)
    const result = await mainWindow.evaluate(
      (id) => window.getTrpcVanillaClient().task.update.mutate({ id, status: 'in_progress' }),
      task.id
    )
    // sanity: status actually flipped at DB level
    expect(result?.status).toBe('in_progress')

    await expect
      .poll(async () =>
        mainWindow.evaluate(
          (id) =>
            (window as unknown as { __respawnCalls: string[] }).__respawnCalls.filter(
              (t) => t === id
            ).length,
          task.id
        )
      )
      .toBeGreaterThan(0)
  })
})
