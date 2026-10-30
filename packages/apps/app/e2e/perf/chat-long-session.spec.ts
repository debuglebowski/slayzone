/**
 * Render budget of a 10,000-event Claude Code chat session (plan 4.1), in real
 * Chromium: opening the session's tab, settling at its first turn and back at
 * its end, and frame times + mounted rows while scrolling through it fast.
 * Limits: `render` in task-terminals/src/client/chat/__perf__/budget.json (the
 * reducer's own budget is checked by `pnpm test:chat:perf`).
 *
 * Wall-clock: run alone on a quiet machine (`pnpm test:e2e:perf`), like
 * boot-budget. The load-independent checks of the same session are in the
 * default suite: e2e/chat/165-chat-long-session.spec.ts.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Page } from '@playwright/test'
import { resetApp } from '../fixtures/electron'
import { expect, test } from '../fixtures/chat'
import { FIRST_PROMPT, LAST_REPLY, longSessionEvents } from '../fixtures/chat-long-session'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const BUDGET = (
  JSON.parse(
    readFileSync(
      path.resolve(
        __dirname,
        '../../../../domains/task-terminals/src/client/chat/__perf__/budget.json'
      ),
      'utf8'
    )
  ) as {
    render: {
      openMs: number
      scrollSettleMs: number
      frameP95Ms: number
      frameMaxMs: number
      mountedRowsMax: number
    }
  }
).render

type ProbeWindow = Window & {
  __slayzone_openTask?: (id: string) => void
  __slayzone_tabStore?: { getState(): { closeTabByTaskId(id: string): void } }
}

/**
 * In the page: run `act`, then wait frame by frame until `text` shows in the
 * visible chat timeline. Milliseconds from just before `act`.
 */
function timeUntilShown(page: Page, act: 'open' | 'top' | 'bottom', text: string, taskId: string) {
  return page.evaluate(
    ({ act, text, taskId }) =>
      new Promise<number>((resolve, reject) => {
        const w = window as ProbeWindow
        const panel = () =>
          Array.from(document.querySelectorAll<HTMLElement>('[data-chat-panel]')).find(
            (p) => p.offsetParent !== null
          )
        const scroller = () =>
          panel()?.querySelector<HTMLElement>('[data-testid="chat-timeline-scroller"]') ?? null
        const shown = () =>
          Array.from(
            panel()?.querySelectorAll<HTMLElement>('[data-virtual-list] > [data-index]') ?? []
          ).some((row) => row.textContent?.includes(text) && row.getBoundingClientRect().height > 0)
        const t0 = performance.now()
        if (act === 'open') w.__slayzone_openTask?.(taskId)
        else if (act === 'top') scroller()?.scrollTo({ top: 0 })
        else {
          const el = scroller()
          el?.scrollTo({ top: el.scrollHeight })
        }
        const tick = () => {
          if (shown()) return resolve(performance.now() - t0)
          if (performance.now() - t0 > 30_000) return reject(new Error(`"${text}" never showed`))
          requestAnimationFrame(tick)
        }
        requestAnimationFrame(tick)
      }),
    { act, text, taskId }
  )
}

/** Scroll fast through the history (up, then down), sampling every frame. */
function sweep(page: Page) {
  return page.evaluate(
    () =>
      new Promise<{ frames: number[]; mountedMax: number }>((resolve) => {
        const panel = Array.from(document.querySelectorAll<HTMLElement>('[data-chat-panel]')).find(
          (p) => p.offsetParent !== null
        )
        const el = panel!.querySelector<HTMLElement>('[data-testid="chat-timeline-scroller"]')!
        const frames: number[] = []
        let mountedMax = 0
        let last = performance.now()
        let step = 0
        const STEPS = 240
        const tick = () => {
          const now = performance.now()
          frames.push(now - last)
          last = now
          mountedMax = Math.max(
            mountedMax,
            panel!.querySelectorAll('[data-virtual-list] > [data-index]').length
          )
          // 3 viewports per frame: far faster than a hand on a wheel.
          const delta = el.clientHeight * 3 * (step < STEPS / 2 ? -1 : 1)
          el.scrollTop += delta
          step++
          if (step < STEPS) requestAnimationFrame(tick)
          else resolve({ frames: frames.slice(1), mountedMax })
        }
        requestAnimationFrame(tick)
      })
  )
}

const percentile = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.floor(s.length * p))] ?? 0
}

test.describe('chat long-session render budget', () => {
  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
  })

  test('a 10,000-event session opens, settles at both ends, and scrolls within budget', async ({
    chat
  }) => {
    test.setTimeout(180_000)
    const t = await chat.openTask({
      title: 'Long session budget',
      spawn: 'on-send',
      seedEvents: longSessionEvents(),
      scenario: { processes: [] }
    })
    await expect(t.panel.getByText(LAST_REPLY)).toBeVisible({ timeout: 30_000 })

    // Open: the session's tab was closed; open it again (mount + replay + first paint).
    await t.page.evaluate((id) => {
      ;(window as ProbeWindow).__slayzone_tabStore?.getState().closeTabByTaskId(id)
    }, t.taskId)
    await expect(t.page.locator('[data-chat-panel]:visible')).toHaveCount(0)
    const openMs = await timeUntilShown(t.page, 'open', LAST_REPLY, t.taskId)

    const topMs = await timeUntilShown(t.page, 'top', FIRST_PROMPT, t.taskId)
    const bottomMs = await timeUntilShown(t.page, 'bottom', LAST_REPLY, t.taskId)
    const { frames, mountedMax } = await sweep(t.page)
    const p95 = percentile(frames, 0.95)
    const max = Math.max(...frames)

    const numbers = {
      openMs: Math.round(openMs),
      topMs: Math.round(topMs),
      bottomMs: Math.round(bottomMs),
      frameP95Ms: Math.round(p95 * 10) / 10,
      frameMaxMs: Math.round(max * 10) / 10,
      mountedMax
    }
    console.log(`[chat-long-session] ${JSON.stringify(numbers)} budget ${JSON.stringify(BUDGET)}`)
    expect(numbers.openMs).toBeLessThanOrEqual(BUDGET.openMs)
    expect(numbers.topMs).toBeLessThanOrEqual(BUDGET.scrollSettleMs)
    expect(numbers.bottomMs).toBeLessThanOrEqual(BUDGET.scrollSettleMs)
    expect(numbers.frameP95Ms).toBeLessThanOrEqual(BUDGET.frameP95Ms)
    expect(numbers.frameMaxMs).toBeLessThanOrEqual(BUDGET.frameMaxMs)
    expect(numbers.mountedMax).toBeLessThanOrEqual(BUDGET.mountedRowsMax)
  })
})
