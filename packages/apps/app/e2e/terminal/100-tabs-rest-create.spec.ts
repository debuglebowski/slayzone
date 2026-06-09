import { test, expect, seed, resetApp, TEST_PROJECT_PATH } from '../fixtures/electron'
import type { ElectronApplication } from '@playwright/test'
import { openTaskTerminal, waitForPtySession } from '../fixtures/terminal'

/**
 * `POST /api/tabs/create` and `POST /api/tabs/split` (CLI: `slay pty create` /
 * `slay pty split`) must:
 *   1. Insert a `terminal_tabs` row
 *   2. Auto-open the task tab (so TerminalContainer mounts → PTY spawns)
 *   3. Broadcast `tabs:changed` so any other window refreshes
 *   4. Return `{ tab, sessionId }` whose sessionId appears in `/api/pty`
 *
 * Note: fetch runs in the *main* process (electronApp.evaluate) — the renderer's
 * CSP `connect-src 'self'` blocks http://127.0.0.1 fetches from the page.
 */

interface RestResult {
  status: number
  body: unknown
}

async function rest(
  electronApp: ElectronApplication,
  port: number,
  path: string,
  body: Record<string, unknown>
): Promise<RestResult> {
  return electronApp.evaluate(
    async (_, args) => {
      const r = await fetch(`http://127.0.0.1:${args.p}${args.url}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(args.b)
      })
      let parsed: unknown = null
      try {
        parsed = await r.json()
      } catch {
        /* may be empty */
      }
      return { status: r.status, body: parsed }
    },
    { p: port, b: body, url: path }
  )
}

test.describe('Tab create/split via REST', () => {
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
    const p = await s.createProject({
      name: 'Tabs REST',
      color: '#10b981',
      path: TEST_PROJECT_PATH
    })
    projectId = p.id
    projectAbbrev = p.name.slice(0, 2).toUpperCase()
  })

  test('REST 400 when taskId missing', async ({ electronApp }) => {
    const res = await rest(electronApp, mcpPort, '/api/tabs/create', {})
    expect(res.status).toBe(400)
  })

  test('REST 404 when task does not exist', async ({ electronApp }) => {
    const res = await rest(electronApp, mcpPort, '/api/tabs/create', {
      taskId: '00000000-0000-0000-0000-000000000000'
    })
    expect(res.status).toBe(404)
  })

  test('create inserts tab row + spawns PTY when task is open', async ({
    electronApp,
    mainWindow
  }) => {
    const s = seed(mainWindow)
    const task = await s.createTask({
      projectId,
      title: 'Tabs create spawn',
      status: 'in_progress'
    })
    await mainWindow.evaluate(
      (id) => window.getTrpcVanillaClient().task.update.mutate({ id, terminalMode: 'terminal' }),
      task.id
    )
    await s.refreshData()

    // Open task so TerminalContainer is mounted and listens for tabs:changed.
    await openTaskTerminal(mainWindow, { projectAbbrev, taskTitle: 'Tabs create spawn' })

    const res = await rest(electronApp, mcpPort, '/api/tabs/create', {
      taskId: task.id,
      mode: 'terminal',
      label: 'CLI tab'
    })
    expect(res.status).toBe(200)
    const body = res.body as { tab: { id: string; label: string; mode: string }; sessionId: string }
    expect(body.tab.label).toBe('CLI tab')
    expect(body.tab.mode).toBe('terminal')
    expect(body.sessionId).toBe(`${task.id}:${body.tab.id}`)

    // tabs:changed broadcast → renderer refetches → activeGroupId switches to
    // the new tab → TerminalSplitGroup mounts pane → PTY spawns.
    await waitForPtySession(mainWindow, body.sessionId)
  })

  test('split adds pane in same group', async ({ electronApp, mainWindow }) => {
    const s = seed(mainWindow)
    const task = await s.createTask({ projectId, title: 'Tabs split spawn', status: 'in_progress' })
    await mainWindow.evaluate(
      (id) => window.getTrpcVanillaClient().task.update.mutate({ id, terminalMode: 'terminal' }),
      task.id
    )
    await s.refreshData()

    await openTaskTerminal(mainWindow, { projectAbbrev, taskTitle: 'Tabs split spawn' })

    // First create a non-main tab to split off of.
    const createRes = await rest(electronApp, mcpPort, '/api/tabs/create', {
      taskId: task.id,
      mode: 'terminal'
    })
    expect(createRes.status).toBe(200)
    const createBody = createRes.body as { tab: { id: string; groupId: string }; sessionId: string }
    await waitForPtySession(mainWindow, createBody.sessionId)

    // Split it.
    const splitRes = await rest(electronApp, mcpPort, '/api/tabs/split', {
      tabId: createBody.tab.id
    })
    expect(splitRes.status).toBe(200)
    const splitBody = splitRes.body as { tab: { id: string; groupId: string }; sessionId: string }

    // New pane shares the original tab's group.
    expect(splitBody.tab.groupId).toBe(createBody.tab.groupId)
    expect(splitBody.sessionId).toBe(`${task.id}:${splitBody.tab.id}`)

    await waitForPtySession(mainWindow, splitBody.sessionId)
  })

  test('split returns 404 for unknown tab id', async ({ electronApp }) => {
    const res = await rest(electronApp, mcpPort, '/api/tabs/split', {
      tabId: '00000000-0000-0000-0000-000000000000'
    })
    expect(res.status).toBe(404)
  })

  test('split 400 when tabId missing', async ({ electronApp }) => {
    const res = await rest(electronApp, mcpPort, '/api/tabs/split', {})
    expect(res.status).toBe(400)
  })
})
