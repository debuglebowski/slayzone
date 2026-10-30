/**
 * Claude Code chat (chat A): moving a conversation without losing or doubling it.
 * - Effort changes live (`apply_flag_settings`, plan 3.11): no restart.
 * - A message the CLI already had before a restart: it drops the resent uuid
 *   (2.1.312, chat-a check R2b), and the chat says so instead of hanging.
 * - TUI ↔ chat hand-off (plan 3.10): the other side stops first, the same
 *   conversation resumes, its history shows.
 * Against the scripted fake CLI.
 */
import { resetApp } from '../fixtures/electron'
import path from 'node:path'
import type { ElectronApplication } from '@playwright/test'
import { echoTurn, expect, reply, test } from '../fixtures/chat'

/**
 * Run the terminal agent as the fake too. A terminal starts `claude` through the
 * user's login shell, whose rc files put the real CLI first on PATH again, so
 * the bin override cannot reach it: point the claude-code mode's commands at the
 * fake by absolute path instead. Returns the undo.
 */
async function fakeTerminalAgent(
  electronApp: ElectronApplication,
  claudeBin: string
): Promise<() => Promise<void>> {
  return electronApp
    .evaluate(async ({}, bin) => {
      const db = (globalThis as Record<string, unknown>).__db as {
        get: (sql: string, params?: unknown[]) => Promise<{ i: string; r: string } | undefined>
        run: (sql: string, params?: unknown[]) => Promise<unknown>
      }
      const before = await db.get(
        `SELECT initial_command AS i, resume_command AS r FROM terminal_modes WHERE id = 'claude-code'`
      )
      await db.run(
        `UPDATE terminal_modes SET initial_command = ?, resume_command = ? WHERE id = 'claude-code'`,
        [`${bin} --session-id {id} {flags}`, `${bin} --resume {id} {flags}`]
      )
      return before
    }, claudeBin)
    .then((before) => async () => {
      await electronApp.evaluate(async ({}, b) => {
        const db = (globalThis as Record<string, unknown>).__db as {
          run: (sql: string, params?: unknown[]) => Promise<unknown>
        }
        await db.run(
          `UPDATE terminal_modes SET initial_command = ?, resume_command = ? WHERE id = 'claude-code'`,
          [b?.i ?? null, b?.r ?? null]
        )
      }, before)
    })
}

/** The process still runs (the terminal agent is SIGKILLed with its pty: it logs no exit). */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** The newest ledger row of a task's mode with that origin: its conversation. */
function ledgerConversation(
  electronApp: ElectronApplication,
  taskId: string,
  mode: string,
  origin: string
): Promise<string | null> {
  return electronApp.evaluate(
    async ({}, a) => {
      const db = (globalThis as Record<string, unknown>).__db as {
        get: (sql: string, params?: unknown[]) => Promise<{ conv: string } | undefined>
      }
      const row = await db.get(
        `SELECT conversation_id AS conv FROM task_conversations
          WHERE task_id = ? AND mode = ? AND origin = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`,
        [a.taskId, a.mode, a.origin]
      )
      return row?.conv ?? null
    },
    { taskId, mode, origin }
  )
}

test.describe('Chat hand-off and live settings', () => {
  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
  })

  test('an effort change applies to the running agent without a restart', async ({ chat }) => {
    const t = await chat.openTask({
      title: 'Live effort',
      scenario: {
        processes: [{ defaultTurn: reply('effort={{effort}}') }]
      }
    })
    await t.send('first')
    await expect(t.panel.getByText('effort=', { exact: true })).toBeVisible()

    await t.send('/effort high')
    const run = await t.run(0, (r) => r.controlRequests('apply_flag_settings').length === 1)
    expect(run.controlRequests('apply_flag_settings')[0]).toEqual({
      subtype: 'apply_flag_settings',
      settings: { effortLevel: 'high' }
    })
    await t.send('second')
    await expect(t.panel.getByText('effort=high')).toBeVisible()
    expect(t.epoch.runs()).toHaveLength(1)
  })

  test('a message the CLI already had before a restart is not run twice, and the chat says so', async ({
    chat
  }) => {
    const t = await chat.openTask({
      title: 'Already in conversation',
      scenario: {
        processes: [
          // The second message reaches the conversation, but its acks never arrive
          // before the process is replaced.
          { defaultTurn: echoTurn(), ackDelayMs: 60_000, ackDelayFrom: 1 },
          { defaultTurn: echoTurn() }
        ]
      }
    })
    await t.send('first')
    await expect(t.panel.getByText('echo: first')).toBeVisible()
    await t.send('second')
    const sent = await t.run(0, (r) => r.userMessages().includes('second'))
    const uuid = sent
      .stdin()
      .filter((m) => m.type === 'user')
      .at(-1)?.uuid
    // A respawn while the message is unconfirmed: it is sent again, same uuid.
    await t.page.evaluate(
      (o) => window.getTrpcVanillaClient().chat.setMode.mutate({ ...o, chatMode: 'bypass' }),
      t.opts()
    )
    const second = await t.run(1, (r) => r.duplicateUserUuids().length === 1)
    expect(second.resumed).toBe(true)
    expect(second.duplicateUserUuids()).toEqual([uuid])

    await expect(
      t.panel.locator('[data-testid="chat-interrupted"][data-reason="already-in-conversation"]')
    ).toBeVisible()
    await expect(t.panel.locator('[data-code="already-in-conversation"]')).toBeVisible()
    await t.send('third')
    await expect(t.panel.getByText('echo: third')).toBeVisible()
  })

  test('continue in terminal, then back in chat: the other side is gone first, the same conversation goes on', async ({
    chat,
    electronApp
  }) => {
    const undo = await fakeTerminalAgent(electronApp, path.join(chat.fake.binDir, 'claude'))
    try {
      const t = await chat.openTask({
        title: 'Hand-off',
        scenario: {
          processes: [{ defaultTurn: echoTurn() }, { tui: true }, { defaultTurn: echoTurn() }]
        }
      })
      await t.send('one')
      await expect(t.panel.getByText('echo: one')).toBeVisible()
      const conv = (await t.run(0)).sessionId!

      // --- chat → terminal (the chat's context menu) ---
      await t.panel.getByText('echo: one').click({ button: 'right' })
      await t.page.getByTestId('chat-continue-in-terminal').click()
      const tui = await t.run(1)
      expect(tui.tui).toBe(true)
      expect(tui.flag('--resume')).toBe(conv)
      expect(tui.peersAliveAtStart).toEqual([])
      expect(await ledgerConversation(electronApp, t.taskId, 'claude-code', 'handoff')).toBe(conv)

      // --- terminal → chat (the terminal's … menu) ---
      await t.page.locator('[data-testid="terminal-menu-trigger"]:visible').first().click()
      await t.page.getByTestId('terminal-menu-handoff').click()
      await expect(t.panel).toBeVisible({ timeout: 10_000 })
      await expect(t.panel.getByText('Continued from the terminal')).toBeVisible()
      await expect(t.panel.getByText('echo: one').last()).toBeVisible()
      expect(await ledgerConversation(electronApp, t.taskId, 'claude-chat', 'handoff')).toBe(conv)
      expect(alive(tui.pid)).toBe(false)

      await t.send('two')
      await expect(t.panel.getByText('echo: two')).toBeVisible()
      const back = await t.run(2)
      expect(back.flag('--resume')).toBe(conv)
      expect(back.peersAliveAtStart).toEqual([])
      expect(back.userMessages()).toEqual(['two'])
    } finally {
      await undo()
    }
  })

  test('a chat never resumes a conversation the terminal runs; "continue here" stops the terminal first', async ({
    chat,
    electronApp
  }) => {
    const undo = await fakeTerminalAgent(electronApp, path.join(chat.fake.binDir, 'claude'))
    try {
      const t = await chat.openTask({
        title: 'In use',
        scenario: {
          processes: [{ defaultTurn: echoTurn() }, { tui: true }, { defaultTurn: echoTurn() }]
        }
      })
      await t.send('one')
      await expect(t.panel.getByText('echo: one')).toBeVisible()
      const conv = (await t.run(0)).sessionId!
      await t.panel.getByText('echo: one').click({ button: 'right' })
      await t.page.getByTestId('chat-continue-in-terminal').click()
      const tui = await t.run(1)
      expect(tui.flag('--resume')).toBe(conv)

      // The terminal runs it; a chat start on it is refused, visibly.
      await expect(
        t.page.evaluate((o) => window.getTrpcVanillaClient().chat.start.mutate(o), t.opts())
      ).rejects.toThrow(/running in the terminal/)
      await expect
        .poll(async () =>
          (await t.events()).some(
            (e) =>
              e.event.kind === 'error' &&
              (e.event.detail as { code?: string })?.code === 'conversation-in-use'
          )
        )
        .toBe(true)
      expect(t.epoch.runs()).toHaveLength(2)

      // Continue here: the terminal stops (its exit awaited), the chat resumes it.
      await t.page.evaluate((o) => window.getTrpcVanillaClient().chat.takeOver.mutate(o), t.opts())
      const here = await t.run(2)
      expect(here.flag('--resume')).toBe(conv)
      expect(alive(tui.pid)).toBe(false)
      expect(await ledgerConversation(electronApp, t.taskId, 'claude-code', 'handoff')).toBe(conv)
    } finally {
      await undo()
    }
  })
})
