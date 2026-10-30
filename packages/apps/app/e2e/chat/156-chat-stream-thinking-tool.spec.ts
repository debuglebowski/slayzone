/**
 * Claude Code chat token streaming (plan 3.2): thinking shows at once with a
 * running timer (summarized thinking text arrives late, in a burst), and a tool's
 * input streams into its card — the Bash command grows before the call is final.
 */
import { resetApp } from '../fixtures/electron'
import { ev, expect, step, streamEv, streamMessage, test } from '../fixtures/chat'

test.describe('Chat streaming: thinking and tool input', () => {
  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
  })

  test('thinking shows a live timer, then its text; the row is finalized in place', async ({
    chat
  }) => {
    const t = await chat.openTask({
      title: 'Chat stream thinking',
      scenario: {
        processes: [
          {
            turns: [
              [
                step.emit(ev.init(), streamEv.messageStart('msg_156'), streamEv.thinkingStart(0)),
                // The CLI thinks silently first (summarized text comes at the end).
                step.sleep(2_600),
                {
                  emit: [
                    streamEv.thinkingDelta(0, 'I should '),
                    streamEv.thinkingDelta(0, 'list the files.')
                  ],
                  gapMs: 300
                },
                step.sleep(1_500),
                step.emit(
                  streamEv.signatureDelta(0),
                  ev.thinking('I should list the files.', { messageId: 'msg_156' }),
                  streamEv.blockStop(0)
                ),
                step.emit(
                  streamEv.textStart(1),
                  streamEv.textDelta(1, 'Done '),
                  streamEv.textDelta(1, 'thinking.'),
                  ev.text('Done thinking.', { messageId: 'msg_156' }),
                  streamEv.blockStop(1),
                  streamEv.messageDelta(),
                  streamEv.messageStop(),
                  ev.result({ text: 'Done thinking.' })
                )
              ]
            ]
          }
        ]
      }
    })
    await t.send('think first')
    const thinking = t.panel.locator('[data-chat-thinking]')
    await expect(thinking).toBeVisible({ timeout: 5_000 })
    await expect(thinking).toHaveAttribute('data-streaming', 'true')
    const elapsed = thinking.getByTestId('thinking-elapsed')
    await expect(elapsed).toHaveText(/^[12]s$/, { timeout: 3_000 })
    await thinking.evaluate((el) => el.setAttribute('data-probe', 'live-node'))

    // Expanded, the summarized text shows as it streams.
    await thinking.getByRole('button', { name: /Thinking/ }).click()
    await expect(thinking).toContainText('I should', { timeout: 5_000 })
    await expect(thinking).toContainText('I should list the files.', { timeout: 5_000 })

    await expect(t.panel.locator('[data-chat-text]')).toHaveText('Done thinking.', {
      timeout: 8_000
    })
    await expect(thinking).not.toHaveAttribute('data-streaming', 'true')
    await expect(thinking).toHaveAttribute('data-probe', 'live-node')
    await expect(thinking).toHaveCount(1)
    const saved = (await t.events()).filter((e) => e.event.kind === 'assistant-thinking')
    expect(saved.map((e) => e.event.text)).toEqual(['I should list the files.'])
  })

  test('a Bash command streams into its card before the call is final', async ({ chat }) => {
    const input = { command: 'ls -la src/components', description: 'List components' }
    const t = await chat.openTask({
      title: 'Chat stream tool input',
      scenario: {
        processes: [
          {
            turns: [
              [
                step.emit(ev.init()),
                ...streamMessage(
                  'msg_156t',
                  [
                    {
                      toolUse: {
                        id: 'toolu_156',
                        name: 'Bash',
                        input,
                        chunks: [
                          '{"command": "ls',
                          ' -la',
                          ' src/components", "description": "List',
                          ' components"}'
                        ]
                      }
                    }
                  ],
                  { gapMs: 700 }
                ),
                step.emit(
                  ev.toolResult({ toolUseId: 'toolu_156', content: 'Button.tsx' }),
                  ev.text('Listed.'),
                  ev.result({ text: 'Listed.' })
                )
              ]
            ]
          }
        ]
      }
    })
    await t.send('list components')
    const card = t.panel.getByTestId('tool-bash')
    const command = card.getByTestId('bash-command')
    // The partial input already names the command…
    await expect(command).toHaveText(/^ls( -la)?$/, { timeout: 5_000 })
    await card.evaluate((el) => el.setAttribute('data-probe', 'live-node'))
    // …and grows until the call is final.
    await expect(command).toHaveText('ls -la src/components', { timeout: 6_000 })
    await expect(card).toContainText('Button.tsx', { timeout: 6_000 })
    await expect(card).toHaveAttribute('data-probe', 'live-node')
    await expect(t.panel.getByTestId('tool-bash')).toHaveCount(1)
  })
})
