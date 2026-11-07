/**
 * A chat turn's result records a turn snapshot of what the turn changed.
 *
 * Regression (QA 2026-11-06 "agent-turn snapshots" → task 5decc957): daf8d3bb4
 * dropped the chat turn subscriber's only caller; the computer-owned chat runtime
 * relays every saved event to the hub, where it is wired now. The spec changes the
 * worktree the way the agent would.
 */
import fs from 'node:fs'
import path from 'node:path'
import { resetApp } from '../fixtures/electron'
import { expect, reply, test } from '../fixtures/chat'

test.describe('Chat turn snapshot', () => {
  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
  })

  test("the turn's changes are recorded when it ends", async ({ chat, mainWindow }) => {
    const t = await chat.openTask({
      title: 'Chat turn snapshot',
      scenario: { processes: [{ turns: [reply('edited')] }] }
    })
    // The worktree as the agent leaves it (a first turn is compared with HEAD).
    fs.writeFileSync(path.join(t.cwd, 'CHAT_TURN_EDIT.md'), 'written by the turn')
    await t.send('edit the readme')
    await expect(t.panel.getByText('edited')).toBeVisible()

    const worktreePath = fs.realpathSync(t.cwd)
    await expect
      .poll(
        async () => {
          const turns = (await mainWindow.evaluate(
            (p) => window.getTrpcVanillaClient().agentTurns.list.query({ worktreePath: p }),
            worktreePath
          )) as Array<{ prompt_preview?: string }>
          return turns.map((x) => x.prompt_preview ?? null)
        },
        { timeout: 20_000 }
      )
      // The chat is computer-owned: its prompt stays there (migration v187), so the
      // hub's turn row carries no preview.
      .toEqual([''])
  })
})
