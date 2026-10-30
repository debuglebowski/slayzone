/**
 * Claude Code chat token streaming (plan 3.2): reloading the renderer mid-stream
 * keeps what was already streamed (the server's open-block snapshot,
 * `chat.getReplay`), the rest streams into the same row, and the block is saved
 * once.
 */
import { resetApp } from '../fixtures/electron'
import { ev, expect, step, streamEv, streamMessage, test } from '../fixtures/chat'

test.describe('Chat streaming: reload mid-stream', () => {
  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
  })

  test('partial text survives a reload and the reply finishes in one row', async ({ chat }) => {
    const t = await chat.openTask({
      title: 'Chat stream reload text',
      scenario: {
        processes: [
          {
            turns: [
              [
                step.emit(ev.init()),
                ...streamMessage('msg_157', [{ text: ['Before ', 'the reload, '] }], {
                  open: true
                }),
                step.sleep(5_000),
                step.emit(
                  streamEv.textDelta(0, 'after '),
                  streamEv.textDelta(0, 'the reload.'),
                  ev.text('Before the reload, after the reload.', { messageId: 'msg_157' }),
                  streamEv.blockStop(0),
                  streamEv.messageDelta(),
                  streamEv.messageStop(),
                  ev.result({ text: 'done' })
                )
              ]
            ]
          }
        ]
      }
    })
    await t.send('reload me')
    const row = t.panel.locator('[data-chat-text]')
    await expect(row).toHaveText('Before the reload,', { timeout: 5_000 })

    await t.reload()
    await expect(row).toHaveText('Before the reload,', { timeout: 5_000 })
    await expect(row).toHaveAttribute('data-streaming', 'true')
    await expect(row).toHaveText('Before the reload, after the reload.', { timeout: 10_000 })
    await expect(row).toHaveCount(1)
    await expect(t.panel.getByText('reload me')).toHaveCount(1)
    expect(t.epoch.runs()).toHaveLength(1)
    const texts = (await t.events()).filter((e) => e.event.kind === 'assistant-text')
    expect(texts.map((e) => e.event.text)).toEqual(['Before the reload, after the reload.'])
  })

  test('a tool input streaming at reload time is still shown, then completes', async ({ chat }) => {
    const t = await chat.openTask({
      title: 'Chat stream reload tool input',
      scenario: {
        processes: [
          {
            turns: [
              [
                step.emit(
                  ev.init(),
                  streamEv.messageStart('msg_157t'),
                  streamEv.toolUseStart(0, { id: 'toolu_157', name: 'Bash' }),
                  streamEv.inputJsonDelta(0, '{"command": "npm run '),
                  streamEv.inputJsonDelta(0, 'build')
                ),
                step.sleep(5_000),
                step.emit(
                  streamEv.inputJsonDelta(0, ' --watch"}'),
                  ev.toolUse({
                    id: 'toolu_157',
                    name: 'Bash',
                    input: { command: 'npm run build --watch' },
                    messageId: 'msg_157t'
                  }),
                  streamEv.blockStop(0),
                  streamEv.messageDelta('tool_use'),
                  streamEv.messageStop(),
                  ev.toolResult({ toolUseId: 'toolu_157', content: 'built' }),
                  ev.result({ text: 'built' })
                )
              ]
            ]
          }
        ]
      }
    })
    await t.send('build it')
    const command = t.panel.getByTestId('tool-bash').getByTestId('bash-command')
    await expect(command).toHaveText('npm run build', { timeout: 5_000 })

    await t.reload()
    await expect(command).toHaveText('npm run build', { timeout: 5_000 })
    await expect(command).toHaveText('npm run build --watch', { timeout: 10_000 })
    await expect(t.panel.getByTestId('tool-bash')).toHaveCount(1)
    await expect(t.panel.getByTestId('tool-bash')).toContainText('built')
  })
})
