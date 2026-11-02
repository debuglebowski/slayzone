/**
 * Claude Code chat: jump between turns (plan 4.3). Cmd+K → Chat… → "Go to
 * turn…" lists one entry per user turn — its first line — and picking one
 * scrolls the (virtualized) timeline to that turn, even far up where its rows
 * were never mounted. Cmd+Alt+↑ / ↓ (macOS; Alt+PgUp / PgDn elsewhere) move to
 * the previous / next turn.
 * Harness: fixtures/chat.ts.
 */
import type { Page } from '@playwright/test'
import { resetApp } from '../fixtures/electron'
import { pressShortcut } from '../fixtures/shortcuts'
import { expect, test } from '../fixtures/chat'

const RESULT = {
  kind: 'result',
  subtype: 'success',
  isError: false,
  durationMs: 1,
  durationApiMs: 1,
  numTurns: 1,
  totalCostUsd: 0,
  stopReason: null,
  terminalReason: null,
  modelUsage: {},
  usage: { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
  permissionDenials: []
}

/** `turns` finished turns, tall enough that most are far out of view; turn 2 failed. */
function history(turns: number): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = []
  for (let i = 0; i < turns; i++) {
    const answer = Array.from({ length: 8 }, (_, l) => `answer ${i}, line ${l}`).join('\n\n')
    out.push(
      {
        kind: 'user-message',
        id: `u${i}`,
        text: `Turn ${i} question\nwith a second line`,
        history: true
      },
      { kind: 'assistant-text', messageId: `a${i}`, text: answer },
      { ...RESULT, isError: i === 2, text: answer }
    )
  }
  return out
}

/** Where the user message of turn `n` is, relative to the top of the visible timeline. */
function promptTop(page: Page, n: number) {
  return page.evaluate((i) => {
    const panel = Array.from(document.querySelectorAll<HTMLElement>('[data-chat-panel]')).find(
      (p) => p.offsetParent !== null
    )
    const scroller = panel?.querySelector('[data-testid="chat-timeline-scroller"]')
    const row = scroller?.querySelector<HTMLElement>(`[data-anchor-key="user:u${i}"]`)
    if (!scroller || !row) return null
    return Math.round(row.getBoundingClientRect().top - scroller.getBoundingClientRect().top)
  }, n)
}

test.describe('Claude chat: go to turn', () => {
  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
  })

  test('lists the turns and jumps to one far up; keys move to the previous / next turn', async ({
    chat
  }) => {
    const t = await chat.openTask({
      title: 'Turn outline',
      spawn: 'on-send',
      seedEvents: history(60),
      scenario: { processes: [] }
    })
    await expect(t.panel.getByText('answer 59, line 7')).toBeVisible({ timeout: 10_000 })
    expect(await promptTop(t.page, 5)).toBeNull() // far up: not mounted

    const palette = t.page.locator('[cmdk-root]')
    const row = (text: string) => palette.locator('[cmdk-item]').filter({ hasText: text })
    await pressShortcut(t.page, 'search')
    await expect(palette.locator('[cmdk-input]')).toBeFocused()
    await row('Chat…').click()
    await row('Go to turn…').click()
    const items = palette.locator('[cmdk-item]')
    await expect(items).toHaveCount(60)
    // First line only.
    await expect(items.nth(5)).toHaveText('6. Turn 5 question')

    await items.nth(5).click()
    await expect(palette).toHaveCount(0)
    await expect.poll(() => promptTop(t.page, 5), { timeout: 5_000 }).toBe(0)

    // Keys: previous / next turn from where the view is.
    await t.composer.focus()
    await t.page.keyboard.press('Meta+Alt+ArrowDown')
    await expect.poll(() => promptTop(t.page, 6), { timeout: 5_000 }).toBe(0)
    await t.page.keyboard.press('Meta+Alt+ArrowUp')
    await expect.poll(() => promptTop(t.page, 5), { timeout: 5_000 }).toBe(0)
    await t.page.keyboard.press('Meta+Alt+ArrowUp')
    await expect.poll(() => promptTop(t.page, 4), { timeout: 5_000 }).toBe(0)
    // The composer kept its text and focus (keys did not type or move the caret away).
    await expect(t.composer).toBeFocused()
  })
})
