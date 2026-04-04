import { test, expect, seed, resetApp } from './fixtures/electron'
import { TEST_PROJECT_PATH } from './fixtures/electron'
import {
  openTaskTerminal,
  getMainSessionId,
  waitForPtySession,
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

  // --- Core tests: verify no bogus UUID is saved ---

  // Note: "codex fresh start: no bogus UUID" is tested by spec 93 (mock-based) which
  // is fast and reliable. A real-CLI version is redundant and flaky due to Codex boot
  // latency when run after many other tests.

  // Note: "gemini fresh start: no bogus UUID" is tested by spec 93 (mock-based).
  // Real-CLI version is redundant and flaky due to CLI boot latency after many tests.

  // Note: Codex disk-based session file detection is tested implicitly via the
  // retry polling in pty-manager.ts. An explicit test that waits for the file is
  // unreliable because the Codex API handshake may not complete in the test
  // environment (the test-project cwd doesn't always trigger a session file).

  // --- Gemini: /stats detection works end-to-end ---

  test('gemini: /stats detection saves a valid session ID', async ({ mainWindow }) => {
    test.skip(!hasGemini, 'gemini not on PATH')
    test.setTimeout(120_000)

    const s = seed(mainWindow)
    const t = await s.createTask({ projectId, title: 'SIC gemini detect', status: 'in_progress', terminalMode: 'gemini' })
    await s.refreshData()

    await openTaskTerminal(mainWindow, { projectAbbrev, taskTitle: 'SIC gemini detect' })
    const sessionId = getMainSessionId(t.id)
    await waitForPtySession(mainWindow, sessionId, 60_000)

    // Wait for Gemini to fully boot (attention = idle, ready for input)
    const { waitForPtyState } = await import('./fixtures/terminal')
    await waitForPtyState(mainWindow, sessionId, 'attention', 90_000)
    await mainWindow.waitForTimeout(2000)

    // Send /stats (text and \r must be separate writes — Ink TUI drops \r when concatenated)
    await mainWindow.evaluate(({ id }) => window.api.pty.write(id, '/stats'), { id: sessionId })
    await mainWindow.waitForTimeout(200)
    await mainWindow.evaluate(({ id }) => window.api.pty.write(id, '\r'), { id: sessionId })

    // Wait for detection
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

  // --- Codex resume: DB session ID persists across kill + reopen ---

  test('codex: stored session ID not overwritten on fresh open', async ({ mainWindow }) => {
    test.skip(!hasCodex, 'codex not on PATH')
    test.setTimeout(120_000)

    const storedId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
    const s = seed(mainWindow)
    const t = await s.createTask({ projectId, title: 'SIC codex persist', status: 'in_progress', terminalMode: 'codex' })
    // Pre-set a conversation ID (simulating previous detection)
    await mainWindow.evaluate(({ id, cid }) => window.api.db.updateTask({
      id, providerConfig: { codex: { conversationId: cid, flags: '--full-auto --search --disable apps' } }
    }), { id: t.id, cid: storedId })
    await s.refreshData()

    // Open task — with supportsSessionId=false, no new UUID should be generated
    await openTaskTerminal(mainWindow, { projectAbbrev, taskTitle: 'SIC codex persist' })
    const sessionId = getMainSessionId(t.id)
    await waitForPtySession(mainWindow, sessionId, 60_000)

    await expect.poll(async () => {
      const buf = await readFullBuffer(mainWindow, sessionId)
      return buf.length > 0
    }, { timeout: 60_000 }).toBe(true)

    // Wait a bit for any async detection to potentially overwrite
    await mainWindow.waitForTimeout(5000)

    // DB should still have the original stored ID
    const task = await mainWindow.evaluate((id) => window.api.db.getTask(id), t.id)
    expect(task?.provider_config?.codex?.conversationId).toBe(storedId)
  })
})
