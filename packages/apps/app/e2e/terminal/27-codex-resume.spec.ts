import { test, expect, seed, resetApp } from '../fixtures/electron'
import { TEST_PROJECT_PATH } from '../fixtures/electron'
import { openTaskTerminal, waitForPtySession, startAgentTerminal } from '../fixtures/terminal'

// Migrated 2026-06-22: codex (an AI mode) is idle-gated now — it does not spawn on
// open; click the "Open Codex" starter (startAgentTerminal) to start the real CLI.
test.describe('Codex resume', () => {
    let projectAbbrev: string
    let taskId: string
    const codexConversationId = '11111111-2222-4333-8444-555555555555'

    test.beforeAll(async ({ mainWindow }) => {
      await resetApp(mainWindow)
      const s = seed(mainWindow)
      const p = await s.createProject({
        name: 'Codex Resume',
        color: '#22c55e',
        path: TEST_PROJECT_PATH
      })
      projectAbbrev = p.name.slice(0, 2).toUpperCase()

      const t = await s.createTask({ projectId: p.id, title: 'Codex resume task', status: 'todo' })
      taskId = t.id

      await mainWindow.evaluate(
        ({ id, conversationId }) => {
          return window.getTrpcVanillaClient().task.update.mutate({
            id,
            terminalMode: 'codex',
            codexConversationId: conversationId
          })
        },
        { id: taskId, conversationId: codexConversationId }
      )

      await s.refreshData()
      await openTaskTerminal(mainWindow, { projectAbbrev, taskTitle: 'Codex resume task' })
      await startAgentTerminal(mainWindow)
    })

    test('opens in codex mode with existing conversation and starts a PTY session', async ({
      mainWindow
    }) => {
      const sessionId = `${taskId}:${taskId}`
      await waitForPtySession(mainWindow, sessionId)

      const task = await mainWindow.evaluate(
        (id) => window.getTrpcVanillaClient().task.get.query({ id }),
        taskId
      )
      expect(task?.terminal_mode).toBe('codex')
      expect(task?.codex_conversation_id).toBe(codexConversationId)
    })
  })
