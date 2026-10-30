/**
 * Claude Code chat ↔ terminal: "Continue here" on the terminal side (chat E).
 * A terminal start on a conversation a chat of the task runs is refused; the
 * refusal now offers "Continue here": the chat stops first (A's hand-off,
 * `chat.continueInTerminal`), then the terminal resumes that conversation.
 * Against the scripted fake CLI — the terminal agent too, by absolute path.
 */
import path from 'node:path'
import type { ElectronApplication } from '@playwright/test'
import { resetApp } from '../fixtures/electron'
import { pressShortcut } from '../fixtures/shortcuts'
import { echoTurn, expect, test } from '../fixtures/chat'

/**
 * Run the terminal agent as the fake too: its login shell would put the real
 * CLI first on PATH, so point the claude-code mode's commands at the fake by
 * absolute path (as 154 does). Returns the undo.
 */
async function fakeTerminalAgent(
  electronApp: ElectronApplication,
  claudeBin: string
): Promise<() => Promise<void>> {
  const before = await electronApp.evaluate(async ({}, bin) => {
    const db = (globalThis as Record<string, unknown>).__db as {
      get: (sql: string, params?: unknown[]) => Promise<{ i: string; r: string } | undefined>
      run: (sql: string, params?: unknown[]) => Promise<unknown>
    }
    const prev = await db.get(
      `SELECT initial_command AS i, resume_command AS r FROM terminal_modes WHERE id = 'claude-code'`
    )
    await db.run(
      `UPDATE terminal_modes SET initial_command = ?, resume_command = ? WHERE id = 'claude-code'`,
      [`${bin} --session-id {id} {flags}`, `${bin} --resume {id} {flags}`]
    )
    return prev
  }, claudeBin)
  return async () => {
    await electronApp.evaluate(async ({}, b) => {
      const db = (globalThis as Record<string, unknown>).__db as {
        run: (sql: string, params?: unknown[]) => Promise<unknown>
      }
      await db.run(
        `UPDATE terminal_modes SET initial_command = ?, resume_command = ? WHERE id = 'claude-code'`,
        [b?.i ?? null, b?.r ?? null]
      )
    }, before)
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

test.describe('Terminal: Continue here', () => {
  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
  })

  test('a start refused because the chat runs it: "Continue here" stops the chat, the terminal resumes it', async ({
    chat,
    electronApp
  }) => {
    test.setTimeout(60_000)
    const undo = await fakeTerminalAgent(electronApp, path.join(chat.fake.binDir, 'claude'))
    try {
      const t = await chat.openTask({
        title: 'Continue here',
        scenario: {
          processes: [
            { defaultTurn: echoTurn() }, // chat
            { tui: true }, // terminal after "Continue in terminal"
            { defaultTurn: echoTurn() }, // the chat again, on the same conversation
            { tui: true } // terminal after "Continue here"
          ]
        }
      })
      await t.send('one')
      await expect(t.panel.getByText('echo: one')).toBeVisible()
      const conv = (await t.run(0)).sessionId!

      // The conversation goes to the terminal (A's hand-off)…
      await t.panel.getByText('echo: one').click({ button: 'right' })
      await t.page.getByTestId('chat-continue-in-terminal').click()
      const tui = await t.run(1)
      expect(tui.flag('--resume')).toBe(conv)

      // …the terminal stops, and a chat of the task takes the conversation again
      // (headless: the task's main tab stays the terminal).
      const mainSession = `${t.taskId}:${t.taskId}`
      await t.page.evaluate(
        (sessionId) => window.getTrpcVanillaClient().pty.kill.mutate({ sessionId }),
        mainSession
      )
      await expect.poll(() => alive(tui.pid)).toBe(false)
      await t.page.evaluate((o) => window.getTrpcVanillaClient().chat.start.mutate(o), t.opts())
      const chatAgain = await t.run(2)
      expect(chatAgain.flag('--resume')).toBe(conv)

      // Starting the terminal again (the task's "Restart agent") is refused, with
      // "Continue here".
      await pressShortcut(t.page, 'search')
      const palette = t.page.locator('[cmdk-root]')
      await expect(palette.locator('[cmdk-input]')).toBeFocused()
      await palette.locator('[cmdk-item]').filter({ hasText: 'Restart agent' }).click()
      const refusal = t.page.getByTestId('terminal-start-error')
      await expect(refusal).toContainText('running in the chat')
      await refusal.getByTestId('terminal-continue-here').click()

      // The chat stops first; the terminal resumes the same conversation.
      const here = await t.run(3)
      expect(here.flag('--resume')).toBe(conv)
      expect(here.peersAliveAtStart).toEqual([])
      expect(alive(chatAgain.pid)).toBe(false)
      await expect(refusal).toBeHidden()
    } finally {
      await undo()
    }
  })
})
