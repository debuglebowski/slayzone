import { test, expect, seed, resetApp, TEST_PROJECT_PATH } from '../fixtures/electron'
import {
  getMainSessionId,
  openTaskTerminal,
  waitForPtySession
} from '../fixtures/terminal'

/**
 * `POST /api/pty/respawn` (CLI: `slay pty respawn`) must:
 *   1. Auto-open the task tab (so TaskDetailPage's listener is mounted)
 *   2. Broadcast `pty:respawn-forced` IPC for the requested task id
 *   3. Restart the PTY unconditionally (regardless of mode or liveness)
 *
 * Distinct from `pty:respawn-suggested` — forced path skips the
 * `terminal_mode === 'terminal'` and "PTY already alive" guards.
 */
test.describe('Forced PTY respawn via REST', () => {
  let projectAbbrev: string
  let projectId: string
  let mcpPort = 0

  test.beforeAll(async ({ electronApp, mainWindow }) => {
    await resetApp(mainWindow)
    mcpPort = await electronApp.evaluate(async () => {
      for (let i = 0; i < 20; i++) {
        const p = (globalThis as Record<string, unknown>).__mcpPort
        if (p) return p as number
        await new Promise((r) => setTimeout(r, 250))
      }
      return 0
    })
    expect(mcpPort).toBeTruthy()

    const s = seed(mainWindow)
    const p = await s.createProject({ name: 'Force Respawn', color: '#f59e0b', path: TEST_PROJECT_PATH })
    projectId = p.id
    projectAbbrev = p.name.slice(0, 2).toUpperCase()
  })

  test('REST broadcasts pty:respawn-forced to renderer', async ({ mainWindow }) => {
    const s = seed(mainWindow)
    const task = await s.createTask({ projectId, title: 'Force respawn signal', status: 'in_progress' })
    await mainWindow.evaluate((id) => window.api.db.updateTask({ id, terminalMode: 'terminal' }), task.id)
    await s.refreshData()

    // Subscribe & ack so the REST call's await resolves. TaskDetailPage isn't
    // mounted in this signal-only test; we stand in for it.
    await mainWindow.evaluate((id) => {
      (window as unknown as { __forceRespawnCalls: string[] }).__forceRespawnCalls = []
      window.api.pty.onForceRespawn((t, reqId) => {
        (window as unknown as { __forceRespawnCalls: string[] }).__forceRespawnCalls.push(t)
        window.api.pty.ackForceRespawn(reqId, true)
      })
      return id
    }, task.id)

    const res = await mainWindow.evaluate(async ({ taskId, port }) => {
      const r = await fetch(`http://127.0.0.1:${port}/api/pty/respawn`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskId })
      })
      return { ok: r.ok, status: r.status }
    }, { taskId: task.id, port: mcpPort })
    expect(res.ok).toBe(true)

    await expect.poll(async () =>
      mainWindow.evaluate(
        (id) => (window as unknown as { __forceRespawnCalls: string[] }).__forceRespawnCalls.filter((t) => t === id).length,
        task.id
      )
    ).toBeGreaterThan(0)
  })

  test('REST 404 when task does not exist', async ({ mainWindow }) => {
    const res = await mainWindow.evaluate(async ({ port }) => {
      const r = await fetch(`http://127.0.0.1:${port}/api/pty/respawn`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskId: '00000000-0000-0000-0000-000000000000' })
      })
      return { status: r.status }
    }, { port: mcpPort })
    expect(res.status).toBe(404)
  })

  test('REST 400 when taskId missing', async ({ mainWindow }) => {
    const res = await mainWindow.evaluate(async ({ port }) => {
      const r = await fetch(`http://127.0.0.1:${port}/api/pty/respawn`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      })
      return { status: r.status }
    }, { port: mcpPort })
    expect(res.status).toBe(400)
  })

  test('Force respawn restarts existing PTY (terminal mode)', async ({ mainWindow }) => {
    const s = seed(mainWindow)
    const task = await s.createTask({ projectId, title: 'Force respawn restart', status: 'in_progress' })
    await mainWindow.evaluate((id) => window.api.db.updateTask({ id, terminalMode: 'terminal' }), task.id)
    await s.refreshData()

    const sessionId = getMainSessionId(task.id)
    await openTaskTerminal(mainWindow, { projectAbbrev, taskTitle: 'Force respawn restart' })
    await waitForPtySession(mainWindow, sessionId)

    // Capture original createdAt; after force respawn it must change (new session).
    const originalCreatedAt = await mainWindow.evaluate(async (id) => {
      const list = await window.api.pty.list()
      return list.find((s) => s.sessionId === id)?.createdAt ?? null
    }, sessionId)

    await mainWindow.evaluate(async ({ taskId, port }) => {
      await fetch(`http://127.0.0.1:${port}/api/pty/respawn`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskId })
      })
    }, { taskId: task.id, port: mcpPort })

    await expect.poll(async () =>
      mainWindow.evaluate(async (id) => {
        const list = await window.api.pty.list()
        return list.find((s) => s.sessionId === id)?.createdAt ?? null
      }, sessionId)
    , { timeout: 10_000 }).not.toBe(originalCreatedAt)
  })
})
