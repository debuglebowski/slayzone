/**
 * Claude Code chat: following the end of a streaming reply lets go when the
 * user moves away, in a real browser (wheel smooth-scrolling, the native
 * scrollbar, the trailing padding). Unit contract: useFollowBottom.test.tsx.
 *
 * - a small wheel up that stays within the re-stick threshold stays let go
 * - a scrollbar drag up lets go (no wheel event is sent)
 * - a scroll into the padding below the last message lets go (growth would
 *   pull the view back up)
 */
import type { Page } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { resetApp } from '../fixtures/electron'
import { ev, expect, step, streamMessage, test, type ChatHarness } from '../fixtures/chat'
import { answeredLongSessionEvents, LAST_REPLY } from '../fixtures/chat-long-session'

/** History taller than the view: the stream starts followed, at the end of it. */
const history = (conversationId: string) =>
  answeredLongSessionEvents(2000).map((event) =>
    event.kind === 'turn-init' ? { ...event, sessionId: conversationId } : event
  )
const LINES = 60
/** One paragraph per token: every delta grows the content. */
const tokens = Array.from({ length: LINES }, (_, i) => `Line ${i + 1} of the reply.\n\n`)

interface ScrollState {
  top: number
  /** Where following puts scrollTop: the message end, padding excluded. */
  target: number
  /** Native scrollbar width (0 = overlay scrollbars). */
  scrollbar: number
  rect: { x: number; y: number; width: number; height: number }
}

function scrollState(page: Page): Promise<ScrollState> {
  return page.evaluate(() => {
    const panel = Array.from(document.querySelectorAll<HTMLElement>('[data-chat-panel]')).find(
      (p) => p.offsetParent !== null
    )
    const el = panel!.querySelector<HTMLElement>('[data-testid="chat-timeline-scroller"]')!
    const content = el.querySelector<HTMLElement>('[data-chat-scroll-content]')
    const padding = content ? Number.parseFloat(getComputedStyle(content).paddingBottom) || 0 : 0
    const box = el.getBoundingClientRect()
    return {
      top: el.scrollTop,
      target: Math.max(0, el.scrollHeight - padding - el.clientHeight),
      scrollbar: el.offsetWidth - el.clientWidth,
      rect: { x: box.x, y: box.y, width: box.width, height: box.height }
    }
  })
}

async function openStreaming(chat: ChatHarness, title: string) {
  const conversationId = randomUUID()
  const t = await chat.openTask({
    title,
    conversationId,
    seedEvents: history(conversationId),
    scenario: {
      processes: [
        {
          turns: [
            [
              step.emit(ev.init()),
              ...streamMessage('msg_201', [{ text: tokens }], { gapMs: 500 }),
              step.emit(ev.result({ text: tokens.join('') }))
            ]
          ]
        }
      ]
    }
  })
  await expect(t.panel.getByText(LAST_REPLY)).toBeVisible({ timeout: 20_000 })
  await t.send('stream many lines')
  const progress = t.panel.getByLabel('Message', { exact: true })
  await expect(progress).toBeVisible({ timeout: 5_000 })
  if (await progress.evaluate((el) => el.tagName === 'BUTTON')) await progress.click()
  await expect(t.panel.getByText('Line 3 of the reply.', { exact: true })).toBeVisible({
    timeout: 10_000
  })
  // Following: the view sits at the message end.
  await expect
    .poll(async () => {
      const s = await scrollState(t.page)
      return Math.abs(s.target - s.top)
    })
    .toBeLessThanOrEqual(2)
  return t
}

/** The content grew by more than `px` below where it was when `before` was read. */
async function waitForGrowth(page: Page, before: ScrollState, px: number) {
  await expect
    .poll(async () => (await scrollState(page)).target - before.target, { timeout: 10_000 })
    .toBeGreaterThan(px)
}

test.describe('Claude chat: following a streaming reply lets go', () => {
  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
  })

  test('a small wheel up near the end stays let go', async ({ chat }) => {
    test.setTimeout(90_000)
    const t = await openStreaming(chat, 'Follow small wheel up')
    await t.panel.getByTestId('chat-timeline-scroller').hover()
    await t.page.mouse.wheel(0, -40)
    // Lets its scroll event and a commit run.
    await t.page.waitForTimeout(400)
    const before = await scrollState(t.page)
    // Still within the re-stick threshold of the end: the window where it used
    // to re-stick on its own scroll event.
    expect(before.target - before.top).toBeLessThanOrEqual(70)
    await waitForGrowth(t.page, before, 80)
    const after = await scrollState(t.page)
    expect(Math.abs(after.top - before.top)).toBeLessThanOrEqual(2)
  })

  test('a scrollbar drag up lets go', async ({ chat, mainWindow }) => {
    test.setTimeout(90_000)
    // Exercise a real draggable track regardless of the machine's overlay-scrollbar preference.
    const style = await mainWindow.addStyleTag({
      content: `
      [data-testid="chat-timeline-scroller"]::-webkit-scrollbar { width: 12px; }
      [data-testid="chat-timeline-scroller"]::-webkit-scrollbar-track { background: Canvas; }
      [data-testid="chat-timeline-scroller"]::-webkit-scrollbar-thumb { background: GrayText; }
    `
    })
    const t = await openStreaming(chat, 'Follow scrollbar drag')
    const s = await scrollState(t.page)
    expect(s.scrollbar, 'classic (non-overlay) scrollbar').toBeGreaterThan(0)
    // At the end the thumb sits at the bottom of the track.
    const x = s.rect.x + s.rect.width - s.scrollbar / 2
    const y = s.rect.y + s.rect.height - 6
    await t.page.mouse.move(x, y)
    await t.page.mouse.down()
    // A long history makes the thumb small: 1px of it is ~80px of timeline.
    // Two pixels keep the streaming row in view (mounted, still growing).
    for (let i = 1; i <= 2; i++) await t.page.mouse.move(x, y - i)
    const before = await scrollState(t.page)
    expect(before.target - before.top).toBeGreaterThan(70)
    // Held still on the thumb while the reply grows.
    await waitForGrowth(t.page, before, 80)
    const held = await scrollState(t.page)
    await t.page.mouse.up()
    // Chromium moves a held native thumb proportionally when its track grows.
    // It must remain detached from the message end; after release the view stays put.
    expect(held.target - held.top).toBeGreaterThan(70)
    const released = await scrollState(t.page)
    await waitForGrowth(t.page, released, 40)
    expect(Math.abs((await scrollState(t.page)).top - released.top)).toBeLessThanOrEqual(2)
    await style.evaluate((node) => node.parentNode?.removeChild(node))
  })

  test('a scroll into the padding below the last message lets go', async ({ chat }) => {
    test.setTimeout(90_000)
    const t = await openStreaming(chat, 'Follow into padding')
    await t.panel.getByTestId('chat-timeline-scroller').hover()
    // Right after a delta: the scroll lands before the next one grows the content.
    const last = await scrollState(t.page)
    await waitForGrowth(t.page, last, 0)
    await t.page.mouse.wheel(0, 400)
    await t.page.waitForTimeout(400)
    const before = await scrollState(t.page)
    expect(before.top - before.target).toBeGreaterThan(70)
    await waitForGrowth(t.page, before, 80)
    const after = await scrollState(t.page)
    expect(Math.abs(after.top - before.top)).toBeLessThanOrEqual(2)
  })
})
