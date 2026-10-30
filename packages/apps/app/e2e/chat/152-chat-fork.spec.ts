/**
 * Claude Code chat (chat A, plan 3.3): fork from a past message, in the same tab
 * — like the TUI's branch. The CLI copies the conversation up to the end of that
 * message's turn into a new one; the original's session file is never written.
 * What came after the message is folded behind a divider. The original stays in
 * Sessions, one click away (its history comes back from its session file).
 * Against the scripted fake CLI (2.1.312 shapes; chat-a checks R3, R3b).
 */
import type { Locator } from '@playwright/test'
import { resetApp } from '../fixtures/electron'
import {
  echoTurn,
  expect,
  fileSha256,
  readSessionFile,
  test,
  type ChatTask
} from '../fixtures/chat'

function bubble(t: ChatTask, text: string): Locator {
  return t.panel.locator('div.group').filter({ has: t.page.getByText(text, { exact: true }) })
}

const userTexts = (records: Array<Record<string, unknown>>): string[] =>
  records
    .filter((r) => r.type === 'user')
    .map((r) => (r.message as { content?: unknown }).content)
    .filter((c): c is string => typeof c === 'string')

test.describe('Chat fork', () => {
  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
  })

  test('fork from here: a new conversation in the same tab; the original untouched and one click away', async ({
    chat,
    electronApp
  }) => {
    const t = await chat.openTask({
      title: 'Fork from here',
      scenario: {
        processes: [
          { defaultTurn: echoTurn() },
          { defaultTurn: echoTurn() },
          { defaultTurn: echoTurn() }
        ]
      }
    })
    await t.send('one')
    await expect(t.panel.getByText('echo: one')).toBeVisible()
    await t.send('two')
    await expect(t.panel.getByText('echo: two')).toBeVisible()
    const original = (await t.run(0)).sessionId!
    const originalFile = t.sessionFile(original)
    const before = fileSha256(originalFile)
    expect(before).not.toBeNull()
    // The fork ends with turn one's answer: its record in the original's file.
    const turnOneAnswer = readSessionFile(originalFile).filter((r) => r.type === 'assistant')[0]
      .uuid

    await bubble(t, 'one').hover()
    await bubble(t, 'one').getByRole('button', { name: 'Fork from here' }).click()
    const dialog = t.page.getByTestId('rewind-dialog')
    await expect(dialog).toBeVisible()
    await dialog.getByTestId('rewind-confirm').click()
    await expect(dialog).toBeHidden()

    const forkRun = await t.run(1)
    expect(forkRun.forked).toBe(true)
    expect(forkRun.flag('--resume')).toBe(original)
    expect(forkRun.flag('--resume-session-at')).toBe(turnOneAnswer)
    const forkId = forkRun.flag('--session-id')!
    expect(forkId).not.toBe(original)
    // The original's agent was gone before the fork started.
    expect(forkRun.peersAliveAtStart).toEqual([])

    // Turn two is folded; one click shows it.
    await expect(t.panel.getByText('echo: two')).toBeHidden()
    const branch = t.panel.getByTestId('chat-branch')
    await expect(branch).toHaveAttribute('data-reason', 'forked')
    await branch.getByTestId('chat-branch-toggle').click()
    await expect(t.panel.getByText('echo: two')).toBeVisible()
    await branch.getByTestId('chat-branch-toggle').click()

    // The conversation goes on in the fork; it holds turn one, not turn two.
    await t.send('three')
    await expect(t.panel.getByText('echo: three')).toBeVisible()
    expect(forkRun.userMessages()).toEqual(['three'])
    expect(userTexts(readSessionFile(t.sessionFile(forkId)))).toEqual(['one', 'three'])
    // The original's file was never written.
    expect(fileSha256(originalFile)).toBe(before)
    // The task's chat runs the fork now, recorded as one.
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
      .toEqual({ origin: 'slay-spawned-fork', conv: forkId })

    // Saved: a reload keeps the fold, and the next spawn resumes the fork.
    await t.reload()
    await expect(t.panel.getByText('echo: three')).toBeVisible()
    await expect(t.panel.getByText('echo: two')).toBeHidden()

    // --- Sessions lists both; going back to the original resumes it, with its history ---
    await t.page.locator('[data-testid="session-history-toggle"]:visible').first().click()
    const sidebar = t.page.locator('[data-testid="agent-sessions-sidebar"]:visible').first()
    const items = sidebar.locator('[data-testid="agent-session-item"]')
    await expect(items).toHaveCount(2)
    await sidebar.locator('[aria-label="Switch to session: one"]').click()
    await t.page.locator('[data-testid="agent-session-confirm"]').click()
    const back = await t.run(2)
    expect(back.flag('--resume')).toBe(original)
    expect(back.forked).toBe(false)
    // The original's turn two is back (read from its file), after a divider.
    const branches = t.panel.getByTestId('chat-branch')
    await expect(branches.last()).toHaveAttribute('data-reason', 'switched')
    await expect(t.panel.getByText('echo: two').last()).toBeVisible()
    expect(fileSha256(originalFile)).toBe(before)
  })
})
