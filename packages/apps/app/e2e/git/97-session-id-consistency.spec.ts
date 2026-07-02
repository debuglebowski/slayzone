import { test, expect, seed, resetApp } from '../fixtures/electron'
import { TEST_PROJECT_PATH } from '../fixtures/electron'
import {
  openTaskTerminal,
  startAgentTerminal,
  getMainSessionId,
  waitForPtySession,
  readFullBuffer,
  binaryOnPath
} from '../fixtures/terminal'

const hasCodex = binaryOnPath('codex')

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
      const p = await s.createProject({
        name: 'SidConsist',
        color: '#0891b2',
        path: TEST_PROJECT_PATH
      })
      projectAbbrev = p.name.slice(0, 2).toUpperCase()
      projectId = p.id
      await s.refreshData()
    })

    // --- No bogus UUID for providers without {id} in initialCommand ---

    test('codex fresh start: no conversationId in DB', async ({ mainWindow }) => {
      test.skip(!hasCodex, 'codex not on PATH')
      test.setTimeout(90_000)

      const s = seed(mainWindow)
      const t = await s.createTask({
        projectId,
        title: 'SIC codex fresh',
        status: 'in_progress',
        terminalMode: 'codex'
      })
      await mainWindow.evaluate(
        ({ id }) =>
          window.getTrpcVanillaClient().task.update.mutate({
            id,
            providerConfig: { codex: { flags: '--sandbox workspace-write --disable apps' } }
          }),
        { id: t.id }
      )
      await s.refreshData()

      await openTaskTerminal(mainWindow, { projectAbbrev, taskTitle: 'SIC codex fresh' })
      await startAgentTerminal(mainWindow)
      const sessionId = getMainSessionId(t.id)
      await waitForPtySession(mainWindow, sessionId, 60_000)

      await expect
        .poll(
          async () => {
            const buf = await readFullBuffer(mainWindow, sessionId)
            return buf.length > 0
          },
          { timeout: 60_000 }
        )
        .toBe(true)

      const task = await mainWindow.evaluate((id) => window.getTrpcVanillaClient().task.get.query({ id }), t.id)
      expect(task?.provider_config?.codex?.conversationId ?? null).toBeNull()
    })

    // --- Codex: stored session ID not overwritten ---

    test('codex: stored session ID not overwritten on fresh open', async ({ mainWindow }) => {
      test.skip(!hasCodex, 'codex not on PATH')
      test.setTimeout(90_000)

      const storedId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
      const s = seed(mainWindow)
      const t = await s.createTask({
        projectId,
        title: 'SIC codex persist',
        status: 'in_progress',
        terminalMode: 'codex'
      })
      await mainWindow.evaluate(
        ({ id, cid }) =>
          window.getTrpcVanillaClient().task.update.mutate({
            id,
            providerConfig: {
              codex: { conversationId: cid, flags: '--sandbox workspace-write --disable apps' }
            }
          }),
        { id: t.id, cid: storedId }
      )
      await s.refreshData()

      await openTaskTerminal(mainWindow, { projectAbbrev, taskTitle: 'SIC codex persist' })
      await startAgentTerminal(mainWindow)
      const sessionId = getMainSessionId(t.id)
      await waitForPtySession(mainWindow, sessionId, 60_000)

      await expect
        .poll(
          async () => {
            const buf = await readFullBuffer(mainWindow, sessionId)
            return buf.length > 0
          },
          { timeout: 60_000 }
        )
        .toBe(true)

      // Wait for any async detection to potentially overwrite
      await mainWindow.waitForTimeout(5000)

      const task = await mainWindow.evaluate((id) => window.getTrpcVanillaClient().task.get.query({ id }), t.id)
      expect(task?.provider_config?.codex?.conversationId).toBe(storedId)
    })
  })
