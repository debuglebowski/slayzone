/**
 * Claude Code chat: a turn's footer buttons stay in view while the turn's block
 * is on screen. A finished answer's row (Activities, Message details, …) is
 * pinned to the timeline's bottom while the answer body scrolls past, to its
 * top while an expanded Activities list scrolls past. A running turn's row
 * (Activities) is pinned to the top over its expanded list, its block
 * highlights on hover like a finished answer, and its live
 * "Message" preview header stays right under that row while the expanded
 * streaming text scrolls past. The rows of the virtualized timeline are
 * positioned in a way sticky positioning honours (a transform would not be).
 * Harness: fixtures/chat.ts.
 */
import type { Page } from '@playwright/test'
import { resetApp } from '../fixtures/electron'
import { ev, expect, step, streamMessage, test } from '../fixtures/chat'

const TOOLS = 60

/** One finished turn: many tool calls, then a long answer. */
function history(): Array<Record<string, unknown>> {
  const tools = Array.from({ length: TOOLS }, (_, i) => [
    { kind: 'tool-call', id: `t${i}`, name: 'Bash', input: { command: `echo ${i}` } },
    {
      kind: 'tool-result',
      toolUseId: `t${i}`,
      isError: false,
      rawContent: `${i}`,
      structured: null
    }
  ]).flat()
  const answer = Array.from({ length: 80 }, (_, l) => `answer line ${l}`).join('\n\n')
  return [
    { kind: 'user-message', id: 'u0', text: 'Do the work', history: true },
    ...tools,
    { kind: 'assistant-text', messageId: 'a0', text: answer },
    {
      kind: 'result',
      subtype: 'success',
      isError: false,
      durationMs: 1,
      durationApiMs: 1,
      numTurns: 1,
      totalCostUsd: 0,
      stopReason: null,
      terminalReason: null,
      text: answer,
      modelUsage: {},
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0
      },
      permissionDenials: []
    }
  ]
}

interface Box {
  top: number
  bottom: number
}

/**
 * Scroll the visible timeline so `target` (a selector, or 'answer-body') starts
 * `above` px above the view's top; returns where `row` and the `marks` are,
 * relative to the view's top (`bottom` too: relative to the view's bottom edge).
 */
function scrollAndMeasure(
  page: Page,
  opts: { row: string; target: string; above: number; marks?: string[] }
) {
  return page.evaluate(async ({ row, target, above, marks = [] }) => {
    const panel = Array.from(document.querySelectorAll<HTMLElement>('[data-chat-panel]')).find(
      (p) => p.offsetParent !== null
    )!
    const scroller = panel.querySelector<HTMLElement>('[data-testid="chat-timeline-scroller"]')!
    const rowEl = () => scroller.querySelector<HTMLElement>(row)
    const targetEl = () =>
      target === 'answer-body'
        ? (rowEl()?.parentElement?.firstElementChild as HTMLElement | null)
        : scroller.querySelector<HTMLElement>(target)
    const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
    // The virtualizer re-measures rows as they mount: settle over a few rounds.
    for (let i = 0; i < 5; i++) {
      const el = targetEl()
      if (!el) return null
      const s = scroller.getBoundingClientRect()
      scroller.scrollTop += el.getBoundingClientRect().top - s.top + above
      await frame()
    }
    const s = scroller.getBoundingClientRect()
    const box = (el: Element | null) => {
      if (!el) return null
      const r = el.getBoundingClientRect()
      return { top: Math.round(r.top - s.top), bottom: Math.round(r.bottom - s.top) }
    }
    const r = rowEl()!.getBoundingClientRect()
    return {
      fromTop: Math.round(r.top - s.top),
      fromBottom: Math.round(s.bottom - r.bottom),
      row: box(rowEl()) as Box,
      marks: marks.map((m) => box(scroller.querySelector(m)))
    }
  }, opts)
}

const ANSWER_ROW = '[data-testid="chat-answer-footer"]'
const RUNNING_ROW = '[data-testid="chat-activity"] [data-testid="chat-activity-footer"]'

test.describe('Claude chat: sticky answer footer', () => {
  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
  })

  test('footer buttons stay in view over the answer body and its expanded activities', async ({
    chat
  }) => {
    const t = await chat.openTask({
      title: 'Sticky footer',
      spawn: 'on-send',
      seedEvents: history(),
      scenario: { processes: [] }
    })
    await expect(t.panel.getByText('answer line 79')).toBeVisible({ timeout: 10_000 })

    // Body taller than the view, scrolled to its top: the row's own spot is far
    // below the view — it sits on the view's bottom edge.
    await expect
      .poll(() => scrollAndMeasure(t.page, { row: ANSWER_ROW, target: 'answer-body', above: 0 }), {
        timeout: 5_000
      })
      .toMatchObject({ fromBottom: 0 })

    const activities = t.panel.getByRole('button', { name: /Activities/ })
    await expect(activities).toBeInViewport()
    await activities.click()
    await expect(activities).toHaveAttribute('aria-expanded', 'true')

    // Expanded list scrolled into: the row's own spot (above the list) is above
    // the view — it sits on the view's top edge.
    await expect
      .poll(
        () =>
          scrollAndMeasure(t.page, {
            row: ANSWER_ROW,
            target: '[data-testid="chat-answer-footer-panels"]',
            above: 300
          }),
        { timeout: 5_000 }
      )
      .toMatchObject({ fromTop: 0 })
    await expect(activities).toBeInViewport()
  })

  test('a running turn keeps its Activities row and live Message header in view', async ({
    chat
  }) => {
    const reply = Array.from({ length: 80 }, (_, l) => `running line ${l}\n\n`)
    const t = await chat.openTask({
      title: 'Sticky running footer',
      scenario: {
        processes: [
          {
            turns: [
              [
                step.emit(
                  ev.init(),
                  ...Array.from({ length: TOOLS }, (_, i) => [
                    ev.toolUse({ id: `r${i}`, name: 'Bash', input: { command: `echo ${i}` } }),
                    ev.toolResult({ toolUseId: `r${i}`, content: `${i}` })
                  ]).flat()
                ),
                // The reply streams and the turn stays running.
                ...streamMessage('msg_running', [{ text: reply }], { open: true }),
                step.hang()
              ]
            ]
          }
        ]
      }
    })
    await t.send('work on it')

    // Hovered, the running turn's block highlights like a finished answer, and
    // its opaque sticky row shows the same tint.
    const block = t.panel.getByTestId('chat-turn-progress')
    await expect(block.getByTestId('chat-activity-footer')).toBeVisible({ timeout: 10_000 })
    await block.hover()
    const tints = () =>
      block.evaluate((el) => ({
        block: getComputedStyle(el).backgroundColor,
        row: getComputedStyle(el.querySelector('[data-testid="chat-activity-footer"]')!, '::before')
          .backgroundColor
      }))
    await expect.poll(async () => (await tints()).block).not.toBe('rgba(0, 0, 0, 0)')
    await expect
      .poll(async () => {
        const c = await tints()
        return c.row === c.block
      })
      .toBe(true)

    // Live preview expanded, scrolled into its streaming text: the Activities
    // row sits on the view's top edge, the Message header right under it.
    const message = t.panel.getByLabel('Message', { exact: true })
    await expect(message).toBeVisible({ timeout: 10_000 })
    await message.click()
    await expect(t.panel.getByText('running line 79', { exact: true })).toBeVisible({
      timeout: 10_000
    })
    await expect
      .poll(
        async () => {
          const m = await scrollAndMeasure(t.page, {
            row: RUNNING_ROW,
            target: '[data-testid="chat-activity-footer-panels"]',
            above: 600,
            marks: ['[aria-label="Message"]']
          })
          return m && { fromTop: m.fromTop, headerUnderRow: m.marks[0]!.top - m.row.bottom }
        },
        { timeout: 5_000 }
      )
      .toEqual({ fromTop: 0, headerUnderRow: 0 })
    await expect(message).toBeInViewport()
    await message.click()

    // Activities expanded, scrolled into the list: the row sits on the top edge.
    const activities = t.panel.getByRole('button', { name: /Activities/ })
    await activities.click()
    await expect(activities).toHaveAttribute('aria-expanded', 'true')
    await expect
      .poll(
        () =>
          scrollAndMeasure(t.page, {
            row: RUNNING_ROW,
            target: '[data-testid="chat-activity-footer-panels"]',
            above: 300
          }),
        { timeout: 5_000 }
      )
      .toMatchObject({ fromTop: 0 })
    await expect(activities).toBeInViewport()
  })
})
