/**
 * Render measurements of a long chat session in real Chromium (the perf specs
 * e2e/perf/chat-long-session*.spec.ts): reopening its tab until its end shows,
 * settling at its first turn and back, a fast scroll through it, and the
 * renderer's heap. Limits: `render` / `render100k` in
 * task-terminals/src/client/chat/__perf__/budget.json.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, type Page } from '@playwright/test'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

interface RenderBudget {
  openMs: number
  scrollSettleMs: number
  frameP95Ms: number
  frameMaxMs: number
  mountedRowsMax: number
}

const BUDGETS = JSON.parse(
  readFileSync(
    path.resolve(
      __dirname,
      '../../../../domains/task-terminals/src/client/chat/__perf__/budget.json'
    ),
    'utf8'
  )
) as {
  render: RenderBudget
  render100k: RenderBudget & { events: number; heapMbMax: number }
}
/** The 10,000-event session's render limits. */
export const BUDGET = BUDGETS.render
/** The 100,000-event session's (opened paged). */
export const BUDGET_100K = BUDGETS.render100k

export type ProbeWindow = Window & {
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

export interface RenderNumbers {
  openMs: number
  topMs: number
  bottomMs: number
  frameP95Ms: number
  frameMaxMs: number
  mountedMax: number
  /** Renderer JS heap in use after opening + the scroll (MB). */
  heapMb: number
}

/**
 * Measure the session open in `taskId`'s tab (its end showing): close and open
 * the tab again, then its first turn and back, then a fast scroll.
 */
export async function measureLongSession(
  page: Page,
  taskId: string,
  text: { first: string; last: string }
): Promise<RenderNumbers> {
  // Open: the session's tab was closed; open it again (mount + open + first paint).
  await page.evaluate((id) => {
    ;(window as ProbeWindow).__slayzone_tabStore?.getState().closeTabByTaskId(id)
  }, taskId)
  await expect(page.locator('[data-chat-panel]:visible')).toHaveCount(0)
  const openMs = await timeUntilShown(page, 'open', text.last, taskId)
  const topMs = await timeUntilShown(page, 'top', text.first, taskId)
  const bottomMs = await timeUntilShown(page, 'bottom', text.last, taskId)
  const { frames, mountedMax } = await sweep(page)
  const heap = await page.evaluate(
    () =>
      (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory
        ?.usedJSHeapSize ?? 0
  )
  return {
    openMs: Math.round(openMs),
    topMs: Math.round(topMs),
    bottomMs: Math.round(bottomMs),
    frameP95Ms: Math.round(percentile(frames, 0.95) * 10) / 10,
    frameMaxMs: Math.round(Math.max(...frames) * 10) / 10,
    mountedMax,
    heapMb: Math.round(heap / 1e5) / 10
  }
}

/** Every number within `budget` (heap only where the budget has one). */
export function expectWithin(
  numbers: RenderNumbers,
  budget: RenderBudget & { heapMbMax?: number }
): void {
  expect(numbers.openMs).toBeLessThanOrEqual(budget.openMs)
  expect(numbers.topMs).toBeLessThanOrEqual(budget.scrollSettleMs)
  expect(numbers.bottomMs).toBeLessThanOrEqual(budget.scrollSettleMs)
  expect(numbers.frameP95Ms).toBeLessThanOrEqual(budget.frameP95Ms)
  expect(numbers.frameMaxMs).toBeLessThanOrEqual(budget.frameMaxMs)
  expect(numbers.mountedMax).toBeLessThanOrEqual(budget.mountedRowsMax)
  if (budget.heapMbMax !== undefined) expect(numbers.heapMb).toBeLessThanOrEqual(budget.heapMbMax)
}
