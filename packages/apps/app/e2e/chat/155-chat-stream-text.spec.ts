/**
 * Claude Code chat token streaming (plan 3.2): a reply renders as its deltas
 * arrive in the activity preview, then become one final answer, saved once.
 * Fake CLI streaming: packages/shared/test-utils/fake-claude/README.md (stream.ts).
 */
import { resetApp } from '../fixtures/electron'
import { ev, expect, step, streamMessage, test } from '../fixtures/chat'
import { expandActivities } from '../fixtures/chat-activity'

const FINAL = 'Streaming answer arrives piece by piece.'

test.describe('Chat streaming: text', () => {
  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
  })

  test('a reply streams in the preview and becomes one final answer', async ({ chat }) => {
    const t = await chat.openTask({
      title: 'Chat stream text',
      scenario: {
        processes: [
          {
            turns: [
              [
                step.emit(ev.init()),
                ...streamMessage(
                  'msg_155',
                  [{ text: ['Streaming ', 'answer ', 'arrives ', 'piece ', 'by ', 'piece.'] }],
                  { gapMs: 450 }
                ),
                step.sleep(800),
                step.emit(ev.result({ text: FINAL }))
              ]
            ]
          }
        ]
      }
    })
    // The adapter asks the CLI for partial messages.
    expect((await t.run(0)).argv).toContain('--include-partial-messages')

    await t.send('stream please')
    const row = t.panel.getByRole('button', { name: 'Message', exact: true })
    // Partial text shows while the reply is still streaming.
    await expect(row).toContainText('Streaming answer', { timeout: 5_000 })
    await expect(t.stopButton).toBeVisible()
    expect(await row.textContent()).not.toContain('piece.')

    // Consolidating the saved block preserves the preview until turn completion.
    await row.evaluate((el) => el.setAttribute('data-probe', 'live-node'))

    await expect(row).toHaveText(FINAL, { timeout: 8_000 })
    await expect(row).toHaveAttribute('data-probe', 'live-node')
    // Completion promotes the progress preview into the final answer.
    await expect(t.panel.locator('[data-chat-text]')).toHaveText(FINAL)
    await expect(t.panel.locator('[data-chat-text]')).toHaveCount(1)
    await expect(row).toHaveCount(0)

    // Saved once, as the one consolidated block; fragments are never saved.
    const events = await t.events()
    const texts = events.filter((e) => e.event.kind === 'assistant-text')
    expect(texts.map((e) => e.event.text)).toEqual([FINAL])
    expect(events.some((e) => e.event.kind.startsWith('stream-'))).toBe(false)
  })

  test('two text blocks of one message stream into two rows', async ({ chat }) => {
    const t = await chat.openTask({
      title: 'Chat stream two blocks',
      scenario: {
        processes: [
          {
            turns: [
              [
                step.emit(ev.init()),
                ...streamMessage(
                  'msg_155b',
                  [{ text: ['First ', 'block.'] }, { text: ['Second ', 'block.'] }],
                  {
                    gapMs: 150
                  }
                ),
                step.emit(ev.result({ text: 'Second block.' }))
              ]
            ]
          }
        ]
      }
    })
    await t.send('two blocks')
    await expect(t.panel.locator('[data-chat-text]')).toHaveText('Second block.', {
      timeout: 8_000
    })
    await expandActivities(t.panel)
    await expect(t.panel.getByLabel('Message', { exact: true })).toHaveText('First block.')
    await expect(t.panel.locator('[data-chat-text][data-streaming="true"]')).toHaveCount(0)
  })
})
