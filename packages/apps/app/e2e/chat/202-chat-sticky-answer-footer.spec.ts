/**
 * Claude Code chat: an answer's footer buttons (Activities, Message details, …)
 * stay in view while any of the answer is on screen — pinned to the timeline's
 * bottom while its body scrolls past, to its top while an expanded Activities
 * list scrolls past. The rows of the virtualized timeline are positioned in a
 * way sticky positioning honours (a transform would not be).
 * Harness: fixtures/chat.ts.
 */
import type { Page } from '@playwright/test'
import { resetApp } from '../fixtures/electron'
import { expect, test } from '../fixtures/chat'

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

/**
 * Scroll the visible timeline so `part` of the answer ('body' or 'panels')
 * starts `above` px above the view's top; returns where the footer row is
 * relative to the view's top and bottom edges.
 */
function scrollAndMeasure(page: Page, part: 'body' | 'panels', above: number) {
  return page.evaluate(
    async ({ part, above }) => {
      const panel = Array.from(document.querySelectorAll<HTMLElement>('[data-chat-panel]')).find(
        (p) => p.offsetParent !== null
      )!
      const scroller = panel.querySelector<HTMLElement>('[data-testid="chat-timeline-scroller"]')!
      const footer = () => scroller.querySelector<HTMLElement>('[data-testid="chat-answer-footer"]')
      const target = () =>
        part === 'body'
          ? (footer()?.parentElement?.firstElementChild as HTMLElement | null)
          : scroller.querySelector<HTMLElement>('[data-testid="chat-answer-footer-panels"]')
      const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
      // The virtualizer re-measures rows as they mount: settle over a few rounds.
      for (let i = 0; i < 5; i++) {
        const el = target()
        if (!el) return null
        const s = scroller.getBoundingClientRect()
        scroller.scrollTop += el.getBoundingClientRect().top - s.top + above
        await frame()
      }
      const s = scroller.getBoundingClientRect()
      const f = footer()!.getBoundingClientRect()
      return { fromTop: Math.round(f.top - s.top), fromBottom: Math.round(s.bottom - f.bottom) }
    },
    { part, above }
  )
}

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
      .poll(() => scrollAndMeasure(t.page, 'body', 0), { timeout: 5_000 })
      .toMatchObject({ fromBottom: 0 })

    const activities = t.panel.getByRole('button', { name: /Activities/ })
    await expect(activities).toBeInViewport()
    await activities.click()
    await expect(activities).toHaveAttribute('aria-expanded', 'true')

    // Expanded list scrolled into: the row's own spot (above the list) is above
    // the view — it sits on the view's top edge.
    await expect
      .poll(() => scrollAndMeasure(t.page, 'panels', 300), { timeout: 5_000 })
      .toMatchObject({ fromTop: 0 })
    await expect(activities).toBeInViewport()
  })
})
