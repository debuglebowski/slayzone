/**
 * Claude Code chat (chat A, plan 3.6): the Sessions picker. The chat lists the
 * task's Claude conversations — its own and the terminal's (one family, same CLI
 * and session files) — with first prompt, time and message count. Picking one
 * stops the chat's agent, shows the picked conversation's history (read from its
 * session file on the agent's computer), folds what came before, and resumes it.
 * Picking a terminal conversation is a hand-off. Against the scripted fake CLI.
 */
import fs from 'node:fs'
import { resetApp, seed, TEST_PROJECT_PATH } from '../fixtures/electron'
import { closeAllTaskTabs, openTaskTerminal, startAgentTerminal } from '../fixtures/terminal'
import { echoTurn, expect, test, writeSessionFile } from '../fixtures/chat'

const TERMINAL_CONV = '7e5a1c2b-3d4e-4f50-8a6b-7c8d9e0f1a2b'

test.describe('Chat sessions picker', () => {
  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
  })

  test('lists chat and terminal sessions; picking the terminal one hands it over with its history', async ({
    chat,
    electronApp
  }) => {
    const t = await chat.openTask({
      title: 'Sessions picker',
      scenario: { processes: [{ defaultTurn: echoTurn() }, { defaultTurn: echoTurn() }] }
    })
    await t.send('chat question')
    await expect(t.panel.getByText('echo: chat question')).toBeVisible()
    const chatConv = (await t.run(0)).sessionId
    expect(chatConv).toBeTruthy()

    // An older terminal conversation of the same task: its ledger row, its two
    // prompts, and the CLI's session file in the task's repo.
    const olderAt = Date.now() - 60 * 60 * 1000
    await electronApp.evaluate(
      async ({}, r) => {
        const db = (globalThis as Record<string, unknown>).__db as {
          run: (sql: string, params?: unknown[]) => Promise<unknown>
        }
        await db.run(
          `INSERT INTO agent_sessions (id, mode, cwd, task_id, conversation_id, origin, status, created_at, bound_at)
           VALUES (?, 'claude-code', ?, ?, ?, 'slay-spawned-fresh', 'dead', ?, ?)`,
          [`seed-${r.conv}`, r.cwd, r.taskId, r.conv, r.at, r.at]
        )
        await db.run(
          `INSERT OR IGNORE INTO session_turns (conversation_id, first_turn_at) VALUES (?, ?)`,
          [r.conv, r.at]
        )
        for (const [i, text] of ['terminal question', 'terminal follow-up'].entries()) {
          await db.run(
            `INSERT INTO agent_prompts (id, task_id, agent_id, cli_session_id, text, created_at)
             VALUES (?, ?, 'claude-code', ?, ?, ?)`,
            [`seed-prompt-${i}`, r.taskId, r.conv, text, r.at + i + 1]
          )
        }
      },
      { taskId: t.taskId, conv: TERMINAL_CONV, cwd: t.cwd, at: olderAt }
    )
    writeSessionFile({
      configDir: chat.claudeConfigDir,
      cwd: fs.realpathSync(t.cwd),
      sessionId: TERMINAL_CONV,
      turns: [
        { user: 'terminal question', assistant: 'terminal answer' },
        { user: 'terminal follow-up', assistant: 'terminal second answer' }
      ]
    })
    await t.reload()

    // --- The list: both modes, newest first, prompts + counts + mode badges ---
    await t.page.locator('[data-testid="session-history-toggle"]:visible').first().click()
    const sidebar = t.page.locator('[data-testid="agent-sessions-sidebar"]:visible').first()
    const items = sidebar.locator('[data-testid="agent-session-item"]')
    await expect(items).toHaveCount(2)
    await expect(items.first()).toContainText('chat question')
    await expect(items.first().getByTestId('agent-session-mode')).toHaveText('Chat')
    await expect(items.last()).toContainText('terminal question')
    await expect(items.last().getByTestId('agent-session-mode')).toHaveText('Terminal')
    await expect(items.last()).toContainText('2')

    // --- Pick the terminal conversation ---
    await sidebar.locator('[aria-label="Switch to session: terminal question"]').click()
    await t.page.locator('[data-testid="agent-session-confirm"]').click()

    // The chat's agent stopped before the new one resumed the picked conversation.
    const resumed = await t.run(1)
    expect(resumed.flag('--resume')).toBe(TERMINAL_CONV)
    expect(resumed.peersAliveAtStart).toEqual([])

    // Its history is shown; what the chat said before is folded behind a divider.
    await expect(t.panel.getByText('terminal second answer')).toBeVisible()
    await expect(t.panel.getByText('terminal question', { exact: true })).toBeVisible()
    await expect(t.panel.getByText('echo: chat question')).toBeHidden()
    const branch = t.panel.getByTestId('chat-branch')
    await expect(branch).toHaveAttribute('data-reason', 'switched')
    await branch.getByTestId('chat-branch-toggle').click()
    await expect(t.panel.getByText('echo: chat question')).toBeVisible()
    await branch.getByTestId('chat-branch-toggle').click()

    // A hand-off in the ledger, and the conversation goes on.
    await expect
      .poll(async () =>
        electronApp.evaluate(async ({}, taskId) => {
          const db = (globalThis as Record<string, unknown>).__db as {
            get: (
              sql: string,
              params?: unknown[]
            ) => Promise<{ origin: string; conv: string } | undefined>
          }
          return db.get(
            `SELECT origin, conversation_id AS conv FROM task_conversations
              WHERE task_id = ? AND mode = 'claude-chat' ORDER BY created_at DESC, rowid DESC LIMIT 1`,
            [taskId]
          )
        }, t.taskId)
      )
      .toEqual({ origin: 'handoff', conv: TERMINAL_CONV })
    await t.send('next')
    await expect(t.panel.getByText('echo: next')).toBeVisible()
    expect(resumed.userMessages()).toEqual(['next'])
    // The imported past was never sent to the CLI again.
    expect(t.epoch.runs()).toHaveLength(2)
    expect(chatConv).not.toBe(TERMINAL_CONV)

    // Saved: a reload shows the same thing.
    await t.reload()
    await expect(t.panel.getByText('terminal second answer')).toBeVisible()
    await expect(t.panel.getByText('echo: next')).toBeVisible()
    await expect(t.panel.getByText('echo: chat question')).toBeHidden()
    await expect(t.panel.getByTestId('chat-branch')).toHaveAttribute('data-reason', 'switched')
  })

  test('the terminal lists chat sessions too; picking one hands it into the terminal', async ({
    mainWindow,
    electronApp
  }) => {
    const s = seed(mainWindow)
    const project = await s.createProject({
      name: 'Terminal picker',
      color: '#a855f7',
      path: TEST_PROJECT_PATH
    })
    const task = await s.createTask({
      projectId: project.id,
      title: 'Terminal picks chat',
      status: 'in_progress',
      terminalMode: 'claude-code'
    })
    const rows = [
      { conv: 'TP-CHAT', mode: 'claude-chat', text: 'asked in chat', at: 1000 },
      { conv: 'TP-TUI', mode: 'claude-code', text: 'asked in terminal', at: 2000 }
    ]
    await electronApp.evaluate(
      async ({}, r) => {
        const db = (globalThis as Record<string, unknown>).__db as {
          run: (sql: string, params?: unknown[]) => Promise<unknown>
        }
        for (const row of r.rows) {
          await db.run(
            `INSERT INTO agent_sessions (id, mode, cwd, task_id, conversation_id, origin, status, created_at, bound_at)
             VALUES (?, ?, '/p', ?, ?, 'slay-spawned-fresh', 'dead', ?, ?)`,
            [`tp-${row.conv}`, row.mode, r.taskId, row.conv, row.at, row.at]
          )
          await db.run(
            `INSERT OR IGNORE INTO session_turns (conversation_id, first_turn_at) VALUES (?, ?)`,
            [row.conv, row.at]
          )
          await db.run(
            `INSERT INTO agent_prompts (id, task_id, agent_id, cli_session_id, text, created_at)
             VALUES (?, ?, 'claude-code', ?, ?, ?)`,
            [`tp-p-${row.conv}`, r.taskId, row.conv, row.text, row.at + 1]
          )
        }
      },
      { taskId: task.id, rows }
    )
    await s.refreshData()

    // Every spawn stops at the createPty chokepoint; its opts are recorded.
    await mainWindow.evaluate(() =>
      window.getTrpcVanillaClient().pty.testSetPtyCreateCapture.mutate({ enabled: true })
    )
    const lastOpts = (): Promise<{ existingConversationId?: string | null } | null> =>
      mainWindow.evaluate(async () => {
        const all = (await window
          .getTrpcVanillaClient()
          .pty.testTakePtyCreateOpts.query()) as unknown[]
        return (all[all.length - 1] ?? null) as { existingConversationId?: string | null } | null
      })

    await openTaskTerminal(mainWindow, {
      projectAbbrev: project.name.slice(0, 2).toUpperCase(),
      taskTitle: 'Terminal picks chat'
    })
    await startAgentTerminal(mainWindow)
    await mainWindow.locator('[data-testid="session-history-toggle"]:visible').first().click()
    const sidebar = mainWindow.locator('[data-testid="agent-sessions-sidebar"]:visible').first()
    const items = sidebar.locator('[data-testid="agent-session-item"]')
    await expect(items).toHaveCount(2)
    await expect(items.first()).toContainText('asked in terminal')
    await expect(items.first().getByTestId('agent-session-mode')).toHaveText('Terminal')
    await expect(items.last().getByTestId('agent-session-mode')).toHaveText('Chat')

    await sidebar.locator('[aria-label="Switch to session: asked in chat"]').click()
    await mainWindow.locator('[data-testid="agent-session-confirm"]').click()

    // The respawned terminal resumes the chat's conversation…
    await expect
      .poll(async () => (await lastOpts())?.existingConversationId, { timeout: 20_000 })
      .toBe('TP-CHAT')
    // …recorded as a hand-off into the terminal.
    const last = await electronApp.evaluate(async ({}, taskId) => {
      const db = (globalThis as Record<string, unknown>).__db as {
        get: (
          sql: string,
          params?: unknown[]
        ) => Promise<{ origin: string; conv: string } | undefined>
      }
      return db.get(
        `SELECT origin, conversation_id AS conv FROM task_conversations
          WHERE task_id = ? AND mode = 'claude-code' ORDER BY created_at DESC, rowid DESC LIMIT 1`,
        [taskId]
      )
    }, task.id)
    expect(last).toEqual({ origin: 'handoff', conv: 'TP-CHAT' })

    await mainWindow.evaluate(() =>
      window.getTrpcVanillaClient().pty.testSetPtyCreateCapture.mutate({ enabled: false })
    )
    await closeAllTaskTabs(mainWindow)
  })
})
