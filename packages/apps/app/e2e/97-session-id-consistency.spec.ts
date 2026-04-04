import { test, expect, seed, resetApp } from './fixtures/electron'
import { TEST_PROJECT_PATH } from './fixtures/electron'
import {
  openTaskTerminal,
  getMainSessionId,
  waitForPtySession,
  waitForPtyState,
  readFullBuffer,
  binaryOnPath,
} from './fixtures/terminal'

const hasCodex = binaryOnPath('codex')
const hasGemini = binaryOnPath('gemini')

/** Strip ANSI escape sequences from terminal buffer output */
function stripAnsi(data: string): string {
  return data
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[?0-9;:]*[ -/]*[@-~]/g, '')
    .replace(/\x1b[()][AB012]/g, '')
}

/**
 * Integration tests with real CLI binaries.
 * Verifies session ID consistency between the app and the CLI.
 *
 * Requires specs 93/94 to restore PTY handlers in their afterAll
 * so that real CLI spawning works here.
 */
test.describe('Session ID consistency (real CLIs)', () => {
  let projectAbbrev: string
  let projectId: string

  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
    const s = seed(mainWindow)
    const p = await s.createProject({ name: 'SidConsist', color: '#0891b2', path: TEST_PROJECT_PATH })
    projectAbbrev = p.name.slice(0, 2).toUpperCase()
    projectId = p.id
    await s.refreshData()
  })

  // --- No bogus UUID for providers without {id} in initialCommand ---

  test('codex fresh start: no conversationId in DB', async ({ mainWindow }) => {
    test.skip(!hasCodex, 'codex not on PATH')
    test.setTimeout(90_000)

    const s = seed(mainWindow)
    const t = await s.createTask({ projectId, title: 'SIC codex fresh', status: 'in_progress', terminalMode: 'codex' })
    await mainWindow.evaluate(({ id }) => window.api.db.updateTask({
      id, providerConfig: { codex: { flags: '--full-auto --search --disable apps' } }
    }), { id: t.id })
    await s.refreshData()

    await openTaskTerminal(mainWindow, { projectAbbrev, taskTitle: 'SIC codex fresh' })
    const sessionId = getMainSessionId(t.id)
    await waitForPtySession(mainWindow, sessionId, 60_000)

    await expect.poll(async () => {
      const buf = await readFullBuffer(mainWindow, sessionId)
      return buf.length > 0
    }, { timeout: 60_000 }).toBe(true)

    const task = await mainWindow.evaluate((id) => window.api.db.getTask(id), t.id)
    expect(task?.provider_config?.codex?.conversationId ?? null).toBeNull()
  })

  test('gemini fresh start: no conversationId in DB', async ({ mainWindow }) => {
    test.skip(!hasGemini, 'gemini not on PATH')
    test.setTimeout(90_000)

    const s = seed(mainWindow)
    const t = await s.createTask({ projectId, title: 'SIC gemini fresh', status: 'in_progress', terminalMode: 'gemini' })
    await s.refreshData()

    await openTaskTerminal(mainWindow, { projectAbbrev, taskTitle: 'SIC gemini fresh' })
    const sessionId = getMainSessionId(t.id)
    await waitForPtySession(mainWindow, sessionId, 60_000)

    await expect.poll(async () => {
      const buf = await readFullBuffer(mainWindow, sessionId)
      return buf.length > 0
    }, { timeout: 60_000 }).toBe(true)

    const task = await mainWindow.evaluate((id) => window.api.db.getTask(id), t.id)
    expect(task?.provider_config?.gemini?.conversationId ?? null).toBeNull()
  })

  // --- Gemini: /stats detection end-to-end ---

  test('gemini: /stats detection saves a valid session ID', async ({ mainWindow }) => {
    test.skip(!hasGemini, 'gemini not on PATH')
    test.setTimeout(120_000)

    const s = seed(mainWindow)
    const t = await s.createTask({ projectId, title: 'SIC gemini detect', status: 'in_progress', terminalMode: 'gemini' })
    await s.refreshData()

    await openTaskTerminal(mainWindow, { projectAbbrev, taskTitle: 'SIC gemini detect' })
    const sessionId = getMainSessionId(t.id)
    await waitForPtySession(mainWindow, sessionId, 60_000)
    await waitForPtyState(mainWindow, sessionId, 'attention', 60_000)
    await mainWindow.waitForTimeout(2000)

    // Text and \r must be separate writes (Ink TUI drops \r when concatenated with text)
    await mainWindow.evaluate(({ id }) => window.api.pty.write(id, '/stats'), { id: sessionId })
    await mainWindow.waitForTimeout(200)
    await mainWindow.evaluate(({ id }) => window.api.pty.write(id, '\r'), { id: sessionId })

    await expect.poll(async () => {
      const task = await mainWindow.evaluate((id) => window.api.db.getTask(id), t.id)
      return task?.provider_config?.gemini?.conversationId ?? null
    }, { timeout: 15_000 }).not.toBeNull()

    const task = await mainWindow.evaluate((id) => window.api.db.getTask(id), t.id)
    expect(task?.provider_config?.gemini?.conversationId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    )

    // Cross-check with buffer if parseable
    const buf = stripAnsi(await readFullBuffer(mainWindow, sessionId))
    const match = buf.match(/session\s*id:\s+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/im)
    if (match) {
      expect(task?.provider_config?.gemini?.conversationId).toBe(match[1])
    }
  })

  // --- Codex: stored session ID not overwritten ---

  test('codex: stored session ID not overwritten on fresh open', async ({ mainWindow }) => {
    test.skip(!hasCodex, 'codex not on PATH')
    test.setTimeout(90_000)

    const storedId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
    const s = seed(mainWindow)
    const t = await s.createTask({ projectId, title: 'SIC codex persist', status: 'in_progress', terminalMode: 'codex' })
    await mainWindow.evaluate(({ id, cid }) => window.api.db.updateTask({
      id, providerConfig: { codex: { conversationId: cid, flags: '--full-auto --search --disable apps' } }
    }), { id: t.id, cid: storedId })
    await s.refreshData()

    await openTaskTerminal(mainWindow, { projectAbbrev, taskTitle: 'SIC codex persist' })
    const sessionId = getMainSessionId(t.id)
    await waitForPtySession(mainWindow, sessionId, 60_000)

    await expect.poll(async () => {
      const buf = await readFullBuffer(mainWindow, sessionId)
      return buf.length > 0
    }, { timeout: 60_000 }).toBe(true)

    // Wait for any async detection to potentially overwrite
    await mainWindow.waitForTimeout(5000)

    const task = await mainWindow.evaluate((id) => window.api.db.getTask(id), t.id)
    expect(task?.provider_config?.codex?.conversationId).toBe(storedId)
  })
})
