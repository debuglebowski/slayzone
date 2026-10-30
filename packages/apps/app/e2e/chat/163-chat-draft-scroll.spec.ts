/**
 * Claude Code chat: nothing to retype (plan 4.2). A tab's draft — text and
 * attached files — and where its timeline was scrolled survive a reload and
 * switching the task's tab groups (both remount the chat). The draft is saved
 * per tab on the server, with a local journal so a reload right after typing
 * loses nothing; the scroll position is an anchor on a row, not a pixel offset.
 * Harness + scenario API: fixtures/chat.ts.
 */
import type { Page } from '@playwright/test'
import { resetApp } from '../fixtures/electron'
import { expect, test, type ChatTask } from '../fixtures/chat'

const RED = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC',
  'base64'
)

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

/** `turns` question/answer pairs, tall enough to scroll. */
function history(turns: number): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = []
  for (let i = 0; i < turns; i++) {
    const answer = Array.from({ length: 6 }, (_, l) => `answer ${i}, line ${l}`).join('\n\n')
    out.push(
      { kind: 'user-message', id: `u${i}`, text: `question ${i}` },
      { kind: 'assistant-text', messageId: `a${i}`, text: answer },
      { ...RESULT, text: answer }
    )
  }
  return out
}

/** Open a second tab group of the task, then go back (both unmount the chat). */
async function switchTabGroupAndBack(t: ChatTask): Promise<void> {
  const groupOf = (tabId: string) =>
    t.page.evaluate(
      async ({ taskId, tabId }) => {
        const tabs = await window.getTrpcVanillaClient().taskTerminals.list.query({ taskId })
        return tabs.find((tab: { id: string }) => tab.id === tabId)?.groupId ?? null
      },
      { taskId: t.taskId, tabId }
    )
  const chatGroup = await groupOf(t.tabId)
  await t.page
    .locator('[data-testid="terminal-tabbar"]:visible [data-testid="terminal-tab-add"]')
    .first()
    .click()
  await expect(t.panel).toHaveCount(0)
  await t.page.getByTestId(`terminal-tab-${chatGroup}`).click()
  await expect(t.panel).toBeVisible()
}

/** The row at the top of the (visible) timeline and how far the view is into it. */
function topRow(page: Page) {
  return page.evaluate(() => {
    const panel = Array.from(document.querySelectorAll<HTMLElement>('[data-chat-panel]')).find(
      (p) => p.offsetParent !== null
    )
    const scroller = panel?.querySelector('[data-testid="chat-timeline-scroller"]')
    if (!scroller) return null
    const top = scroller.getBoundingClientRect().top
    for (const row of scroller.querySelectorAll<HTMLElement>('[data-anchor-key]')) {
      const box = row.getBoundingClientRect()
      if (box.bottom > top) return { key: row.dataset.anchorKey, offset: Math.round(top - box.top) }
    }
    return null
  })
}

test.describe('Claude chat: draft and scroll position survive remounts and reloads', () => {
  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
  })

  test('the draft (text + attached file) survives a reload right after typing, and a tab-group switch', async ({
    chat
  }) => {
    const t = await chat.openTask({
      title: 'Draft survives',
      spawn: 'on-send',
      scenario: { processes: [] }
    })
    await t.panel
      .getByTestId('chat-attach-input')
      .setInputFiles([{ name: 'red.png', mimeType: 'image/png', buffer: RED }])
    await expect(t.panel.getByTestId('chat-attachment-chip')).toHaveCount(1)
    await t.composer.fill('half a thought, not sent yet')
    // No waiting: the local journal covers a reload inside the save delay.
    await t.reload()
    await expect(t.composer).toHaveValue('half a thought, not sent yet')
    await expect(t.panel.getByTestId('chat-attachment-chip')).toHaveCount(1)

    await t.composer.fill('edited after the reload')
    await switchTabGroupAndBack(t)
    await expect(t.composer).toHaveValue('edited after the reload')
    await expect(t.panel.getByTestId('chat-attachment-chip')).toHaveCount(1)
  })

  test('the timeline keeps its place across a reload and a tab-group switch', async ({ chat }) => {
    const t = await chat.openTask({
      title: 'Scroll survives',
      spawn: 'on-send',
      seedEvents: history(30),
      scenario: { processes: [] }
    })
    const scroller = t.panel.getByTestId('chat-timeline-scroller')
    await expect(t.panel.getByText('question 29')).toBeVisible()
    await scroller.hover()
    for (let i = 0; i < 8; i++) await t.page.mouse.wheel(0, -600)
    await expect.poll(async () => (await topRow(t.page))?.key ?? null).not.toBeNull()
    // Let the scroll settle and the position save (it waits for a pause).
    await t.page.waitForTimeout(1_200)
    const before = await topRow(t.page)
    expect(before?.key).toMatch(/^(user|text):/)
    expect(before?.key).not.toMatch(/^text:a29(:|$)/)

    await t.reload()
    await expect
      .poll(async () => (await topRow(t.page))?.key, { timeout: 10_000 })
      .toBe(before?.key)
    const afterReload = await topRow(t.page)
    expect(Math.abs((afterReload?.offset ?? 0) - (before?.offset ?? 0))).toBeLessThanOrEqual(2)

    await switchTabGroupAndBack(t)
    await expect
      .poll(async () => (await topRow(t.page))?.key, { timeout: 10_000 })
      .toBe(before?.key)
  })
})
