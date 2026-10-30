/**
 * Claude Code chat: a turn the CLI starts by itself reads as working (TUI
 * parity). When a background command finishes, Claude Code answers it with a
 * new turn — init, output, result — that no message opened. The chat shows its
 * working indicator and Stop through that turn, a message typed meanwhile
 * queues until the turn ends, and Esc stops it.
 * Fake CLI: packages/shared/test-utils/fake-claude/README.md (tasks.ts).
 */
import { resetApp } from '../fixtures/electron'
import { ev, expect, step, taskStep, test, type ChatHarness } from '../fixtures/chat'

/** A background loop; when it exits, the CLI's own turn: output, a pause, then its end. */
function scenario(pauseMs: number) {
  return {
    processes: [
      {
        turns: [
          [
            step.emit(
              ev.init(),
              ev.toolUse({
                id: 'toolu_166',
                name: 'Bash',
                input: { command: 'loop', description: 'Loop', run_in_background: true }
              })
            ),
            taskStep({
              taskId: 't166',
              toolUseId: 'toolu_166',
              description: 'Loop',
              background: true,
              output: [{ atMs: 200, text: 'tick\n' }],
              endAtMs: 1_000,
              afterBackgroundExit: [
                step.emit(ev.init(), ev.text('On it: the loop finished.')),
                step.sleep(pauseMs),
                step.emit(
                  ev.text('Checked the output.'),
                  ev.result({ text: 'Checked the output.' })
                )
              ]
            }),
            step.emit(ev.text('STARTED'), ev.result({ text: 'STARTED' }))
          ],
          // The message typed during the agent's own turn.
          [step.emit(ev.init(), ev.text('Answer to the queued one.'), ev.result({}))]
        ]
      }
    ]
  }
}

async function untilAgentTurn(chat: ChatHarness, title: string, pauseMs: number) {
  const t = await chat.openTask({ title, scenario: scenario(pauseMs) })
  await t.send('loop in the background')
  await expect(t.panel.getByText('STARTED')).toBeVisible({ timeout: 5_000 })
  // Between turns: nothing reads as working.
  await expect(t.panel.getByTestId('chat-working-indicator')).toHaveCount(0, { timeout: 5_000 })
  await expect(t.stopButton).toHaveCount(0)
  // The CLI's own turn begins.
  await expect(t.panel.getByText('On it: the loop finished.')).toBeVisible({ timeout: 8_000 })
  return t
}

test.describe('Claude chat: a turn the agent starts by itself', () => {
  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
  })

  test('reads as working until its result; a message typed meanwhile waits for it', async ({
    chat
  }) => {
    const t = await untilAgentTurn(chat, 'Agent turn working', 3_000)
    await expect(t.panel.getByTestId('chat-working-indicator')).toBeVisible()
    await expect(t.stopButton).toBeVisible()

    // Typed during the agent's turn: queued, not sent into it.
    await t.composer.fill('the queued one')
    await t.composer.press('Enter')
    await expect(t.panel.getByTestId('chat-queue-item')).toHaveCount(1)
    const run = await t.run(0)
    expect(run.userMessages()).toEqual(['loop in the background'])

    // Its result: the indicator goes, then the queued message is sent and answered.
    await expect(t.panel.getByText('Checked the output.')).toBeVisible({ timeout: 8_000 })
    await expect(t.panel.getByText('Answer to the queued one.')).toBeVisible({ timeout: 8_000 })
    expect((await t.run(0)).userMessages()).toEqual(['loop in the background', 'the queued one'])
    await expect(t.panel.getByTestId('chat-working-indicator')).toHaveCount(0)
    await expect(t.stopButton).toHaveCount(0)
  })

  test('Esc stops it', async ({ chat }) => {
    const t = await untilAgentTurn(chat, 'Agent turn stop', 6_000)
    await expect(t.stopButton).toBeVisible()
    await t.composer.focus()
    await t.page.keyboard.press('Escape')
    await expect(t.panel.getByTestId('chat-interrupted')).toBeVisible({ timeout: 5_000 })
    await expect(t.stopButton).toHaveCount(0, { timeout: 5_000 })
    // The interrupt went to the CLI (no restart).
    const run = await t.run(0)
    expect(run.controlRequests('interrupt').length).toBeGreaterThan(0)
    expect(t.epoch.runs()).toHaveLength(1)
  })
})
