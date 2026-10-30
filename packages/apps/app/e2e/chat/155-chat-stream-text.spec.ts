/**
 * Claude Code chat token streaming (plan 3.2): a reply renders as its deltas
 * arrive, and the saved block replaces the live one in place — same DOM node, no
 * flicker, one row, saved once.
 * Fake CLI streaming: packages/shared/test-utils/fake-claude/README.md (stream.ts).
 */
import { resetApp } from '../fixtures/electron'
import { ev, expect, step, streamMessage, test } from '../fixtures/chat'

const FINAL = 'Streaming answer arrives piece by piece.'

test.describe('Chat streaming: text', () => {
  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
  })

  test('a reply streams in and is finalized in place', async ({ chat }) => {
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
    const row = t.panel.locator('[data-chat-text]')
    // Partial text shows while the reply is still streaming.
    await expect(row).toContainText('Streaming answer', { timeout: 5_000 })
    await expect(row).toHaveAttribute('data-streaming', 'true')
    expect(await row.textContent()).not.toContain('piece.')

    // Tag the live row's node: if the saved block re-mounted it, the tag is gone.
    await row.evaluate((el) => el.setAttribute('data-probe', 'live-node'))

    await expect(row).toHaveText(FINAL, { timeout: 8_000 })
    await expect(row).not.toHaveAttribute('data-streaming', 'true')
    await expect(row).toHaveAttribute('data-probe', 'live-node')
    await expect(row).toHaveCount(1)

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
    const rows = t.panel.locator('[data-chat-text]')
    await expect(rows).toHaveCount(2, { timeout: 8_000 })
    await expect(rows.nth(0)).toHaveText('First block.')
    await expect(rows.nth(1)).toHaveText('Second block.')
    await expect(t.panel.locator('[data-chat-text][data-streaming="true"]')).toHaveCount(0)
  })
})
