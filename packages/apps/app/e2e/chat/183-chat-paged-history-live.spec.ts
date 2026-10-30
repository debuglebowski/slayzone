/**
 * Paged chat history (chat F), live: a turn on a paged session delivers the
 * result of a tool call made in its FIRST turn — a row whose page is not loaded.
 * The reducer waits for that page (as of its own events), applies the result
 * and goes on; the card shows it; the hub's stored page has it too; nothing
 * before or after moved.
 */
import { TIMELINE_PROJECTION_VERSION } from '@slayzone/terminal/timeline-checkpoint'
import { resetApp } from '../fixtures/electron'
import { ev, expect, step, test } from '../fixtures/chat'
import { LAST_REPLY, longSessionEvents } from '../fixtures/chat-long-session'

const LATE = 'LATE-183 output of a long-running command'

test.describe('Claude chat: paged history — a late result for a row not loaded', () => {
  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
  })

  test('the reducer loads the old page, the card and the stored page show the result', async ({
    chat
  }) => {
    test.setTimeout(240_000)
    const events = longSessionEvents(20_000)
    // The first Bash call (turn 0, the first page).
    const call = events.find((e) => e.kind === 'tool-call' && e.name === 'Bash') as {
      id: string
    }
    const t = await chat.openTask({
      title: 'Paged live',
      // The session's own conversation: the live turn continues it (no restart).
      conversationId: 'long-session',
      seedEvents: events,
      scenario: {
        processes: [
          {
            turns: [
              [
                step.emit(
                  ev.init(),
                  ev.toolResult({ toolUseId: call.id, content: LATE }),
                  ev.text('late result delivered'),
                  ev.result({ text: 'late result delivered' })
                )
              ]
            ]
          }
        ]
      }
    })
    const timeline = t.panel.getByTestId('chat-timeline-scroller')
    await expect(timeline.getByText(LAST_REPLY)).toBeVisible({ timeout: 60_000 })
    const total = Number(await timeline.getAttribute('data-rows-total'))
    expect(Number(await timeline.getAttribute('data-rows-loaded'))).toBeLessThan(512)

    await t.send('deliver the late result')
    await expect(timeline.getByText('late result delivered')).toBeVisible({ timeout: 30_000 })
    // The history is still all there (+ the new turn's rows).
    expect(Number(await timeline.getAttribute('data-rows-total'))).toBeGreaterThan(total)

    // The card, far up: its result is the late one.
    await t.composer.focus()
    await t.page.keyboard.press('Meta+ArrowUp')
    const card = timeline.locator(`[data-item-key="tool:${call.id}"]`)
    await expect(card).toBeVisible({ timeout: 20_000 })
    // (A Bash card shows its output.)
    await expect(card.getByText(LATE)).toBeVisible({ timeout: 10_000 })

    // The hub's stored page has it too (rows as of the newest event).
    const stored = await t.page.evaluate(
      async ({ tabId, id, version }) => {
        const client = window.getTrpcVanillaClient()
        const opened = await client.chat.openTimeline.query({ tabId, version })
        if (opened.kind !== 'paged') return `not paged: ${opened.kind}`
        const res = await client.chat.timelinePages.query({
          tabId,
          pages: [0],
          asOfSeq: opened.snapshot.seq,
          epoch: opened.snapshot.epoch
        })
        if (res.expired) return 'expired'
        const row = res.pages[0].rows.find((r) => r.kind === 'tool' && r.invocation.id === id) as
          | { invocation: { result?: { rawContent: unknown } } }
          | undefined
        return String(row?.invocation.result?.rawContent ?? 'no row')
      },
      { tabId: t.tabId, id: call.id, version: TIMELINE_PROJECTION_VERSION }
    )
    expect(stored).toBe(LATE)
  })
})
