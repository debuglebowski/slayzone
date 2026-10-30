/**
 * Claude Code chat: long sessions stay smooth (plan 4.1). A 10,000-event
 * conversation opens at its end with only the rows in view mounted, scrolls to
 * its first turn and back, finds text in rows that are not mounted, keeps its
 * place across a reload and a task-tab switch (the hidden tab stays mounted
 * with display:none), keeps what was expanded while a row is scrolled away, and
 * a reply streaming at the bottom stays pinned there.
 *
 * Checks are load-independent (mounted rows, what shows where); the wall-clock
 * render budget of the same session is e2e/perf/chat-long-session.spec.ts.
 * Session data: @slayzone/test-utils/chat-long-session. Harness: fixtures/chat.ts.
 */
import type { Page } from '@playwright/test'
import { openTaskById, resetApp, seed } from '../fixtures/electron'
import { ev, expect, step, streamMessage, test, type ChatHarness } from '../fixtures/chat'
import {
  FIRST_PROMPT,
  LAST_REPLY,
  NEEDLE,
  PROBE_COMMAND,
  longSessionEvents
} from '../fixtures/chat-long-session'

/** Mounted rows: what virtualization bounds (plan budget: render.mountedRowsMax). */
const MOUNTED_MAX = 80
const session = () => longSessionEvents()

/** Mounted row count of the visible chat panel's timeline. */
function mountedRows(page: Page): Promise<number> {
  return page.evaluate(() => {
    const panel = Array.from(document.querySelectorAll<HTMLElement>('[data-chat-panel]')).find(
      (p) => p.offsetParent !== null
    )
    return panel?.querySelectorAll('[data-virtual-list] > [data-index]').length ?? -1
  })
}

/** The row at the top of the visible timeline and how far the view is into it. */
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

async function openLong(chat: ChatHarness, title: string) {
  const t = await chat.openTask({
    title,
    spawn: 'on-send',
    seedEvents: session(),
    scenario: { processes: [] }
  })
  await expect(t.panel.getByText(LAST_REPLY)).toBeVisible({ timeout: 20_000 })
  return { t }
}

test.describe('Claude chat: a 10,000-event session', () => {
  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
  })

  test('opens at its end with only the rows in view mounted, and scrolls to its first turn and back', async ({
    chat
  }) => {
    test.setTimeout(120_000)
    const { t } = await openLong(chat, 'Long session open')
    expect(await mountedRows(t.page)).toBeGreaterThan(0)
    expect(await mountedRows(t.page)).toBeLessThanOrEqual(MOUNTED_MAX)
    await expect(t.panel.getByText('Jump to latest')).toHaveCount(0)

    // Cmd+↑: the first turn, still only a window of rows.
    await t.composer.focus()
    await t.page.keyboard.press('Meta+ArrowUp')
    await expect(t.panel.getByText(FIRST_PROMPT)).toBeVisible({ timeout: 10_000 })
    expect(await mountedRows(t.page)).toBeLessThanOrEqual(MOUNTED_MAX)
    await expect(t.panel.getByText(LAST_REPLY)).toHaveCount(0)
    await expect(t.panel.getByText('Jump to latest')).toBeVisible()

    // Cmd+↓: back at the end, following it again.
    await t.page.keyboard.press('Meta+ArrowDown')
    await expect(t.panel.getByText(LAST_REPLY)).toBeVisible({ timeout: 10_000 })
    await expect(t.panel.getByText('Jump to latest')).toHaveCount(0)
    expect(await mountedRows(t.page)).toBeLessThanOrEqual(MOUNTED_MAX)

    // Jump to latest after scrolling up by hand.
    await t.panel.getByTestId('chat-timeline-scroller').hover()
    for (let i = 0; i < 6; i++) await t.page.mouse.wheel(0, -800)
    await expect(t.panel.getByText('Jump to latest')).toBeVisible()
    await t.panel.getByText('Jump to latest').click()
    await expect(t.panel.getByText(LAST_REPLY)).toBeVisible()
    await expect(t.panel.getByText('Jump to latest')).toHaveCount(0)
  })

  test('Cmd+F counts matches in rows that are not mounted; next / prev scroll to them', async ({
    chat
  }) => {
    test.setTimeout(120_000)
    const { t } = await openLong(chat, 'Long session search')
    await expect(t.panel.getByText(`${NEEDLE} the first one`)).toHaveCount(0)
    await t.composer.focus()
    await t.page.keyboard.press('Meta+f')
    const search = t.panel.getByPlaceholder('Find in chat…')
    await search.fill(NEEDLE)
    await expect(t.panel.getByText('1/2')).toBeVisible()
    await expect(t.panel.getByText(`${NEEDLE} the first one`)).toBeVisible({ timeout: 10_000 })
    await search.press('Enter')
    await expect(t.panel.getByText('2/2')).toBeVisible()
    await expect(t.panel.getByText(`${NEEDLE} the second one`)).toBeVisible({ timeout: 10_000 })
    await expect(t.panel.getByText(`${NEEDLE} the first one`)).toHaveCount(0)
    expect(await mountedRows(t.page)).toBeLessThanOrEqual(MOUNTED_MAX)
  })

  test('keeps its place far up the history across a reload and a task-tab switch', async ({
    chat
  }) => {
    test.setTimeout(150_000)
    const { t } = await openLong(chat, 'Long session place')
    // Go far up (rows there were never mounted on open): via search, then close it.
    await t.composer.focus()
    await t.page.keyboard.press('Meta+f')
    await t.panel.getByPlaceholder('Find in chat…').fill(`${NEEDLE} the first`)
    await expect(t.panel.getByText(`${NEEDLE} the first one`)).toBeVisible({ timeout: 10_000 })
    await t.page.keyboard.press('Escape')
    await t.panel.getByTestId('chat-timeline-scroller').hover()
    await t.page.mouse.wheel(0, 300)
    await t.page.waitForTimeout(1_200)
    const before = await topRow(t.page)
    expect(before?.key).toBeTruthy()

    // A reload remounts the panel: the saved anchor's row is far from the end.
    await t.reload()
    await expect
      .poll(async () => (await topRow(t.page))?.key, { timeout: 15_000 })
      .toBe(before?.key)
    expect(
      Math.abs(((await topRow(t.page))?.offset ?? 0) - (before?.offset ?? 0))
    ).toBeLessThanOrEqual(2)

    // Another task's tab in front: this one stays mounted, hidden (display:none).
    const s = seed(t.page)
    const project = await s.createProject({ name: 'Other 165', color: '#a3e635', path: t.cwd })
    const other = await s.createTask({
      projectId: project.id,
      title: 'Other task 165',
      status: 'todo',
      terminalMode: 'claude-chat'
    })
    await s.refreshData()
    await openTaskById(t.page, other.id)
    await expect(t.page.getByText('Other task 165').first()).toBeVisible()
    await openTaskById(t.page, t.taskId)
    await expect
      .poll(async () => (await topRow(t.page))?.key, { timeout: 10_000 })
      .toBe(before?.key)
    expect(await mountedRows(t.page)).toBeLessThanOrEqual(MOUNTED_MAX)
  })

  test('a card keeps its state while scrolled away; "Collapse all" closes it off screen too', async ({
    chat
  }) => {
    test.setTimeout(120_000)
    const { t } = await openLong(chat, 'Long session row state')
    const probe = t.panel.getByTestId('tool-bash').filter({ hasText: PROBE_COMMAND })
    const output = probe.getByTestId('bash-output')
    await expect(output).toBeVisible() // Bash cards start open
    await probe.getByRole('button').first().click()
    await expect(output).toHaveCount(0)

    await t.composer.focus()
    await t.page.keyboard.press('Meta+ArrowUp')
    await expect(t.panel.getByText(FIRST_PROMPT)).toBeVisible({ timeout: 10_000 })
    await expect(probe).toHaveCount(0) // unmounted
    await t.page.keyboard.press('Meta+ArrowDown')
    await expect(probe).toBeVisible({ timeout: 10_000 })
    await expect(output).toHaveCount(0) // still collapsed

    // Open it again, scroll away, "Collapse all": it comes back closed.
    await probe.getByRole('button').first().click()
    await expect(output).toBeVisible()
    await t.composer.focus()
    await t.page.keyboard.press('Meta+ArrowUp')
    await expect(t.panel.getByText(FIRST_PROMPT)).toBeVisible({ timeout: 10_000 })
    await t.panel.getByText(FIRST_PROMPT).click({ button: 'right' })
    await t.page.getByRole('menuitem', { name: 'Collapse all expanded blocks' }).click()
    await t.composer.focus()
    await t.page.keyboard.press('Meta+ArrowDown')
    await expect(probe).toBeVisible({ timeout: 10_000 })
    await expect(output).toHaveCount(0)
  })

  test('a reply streaming at the bottom of the long session stays pinned to it', async ({
    chat
  }) => {
    test.setTimeout(150_000)
    const words = Array.from({ length: 40 }, (_, i) => `word${i}\n\n`)
    const t = await chat.openTask({
      title: 'Long session stream',
      seedEvents: session(),
      scenario: {
        processes: [
          {
            turns: [
              [
                step.emit(ev.init()),
                ...streamMessage('msg_165', [{ text: words }], { gapMs: 60 }),
                step.emit(ev.result({ text: words.join('') }))
              ]
            ]
          }
        ]
      }
    })
    await expect(t.panel.getByText(LAST_REPLY)).toBeVisible({ timeout: 20_000 })
    // Sample the distance from the bottom after every growth of the content. A
    // ResizeObserver made now runs after the follow lock's (made at mount), so
    // it sees the view where that left it — what gets painted.
    await t.page.evaluate(() => {
      const w = window as Window & { __gaps165?: number[]; __stop165?: () => void }
      const panel = Array.from(document.querySelectorAll<HTMLElement>('[data-chat-panel]')).find(
        (p) => p.offsetParent !== null
      )
      const el = panel!.querySelector<HTMLElement>('[data-testid="chat-timeline-scroller"]')!
      const gaps: number[] = []
      w.__gaps165 = gaps
      const ro = new ResizeObserver(() =>
        gaps.push(el.scrollHeight - el.scrollTop - el.clientHeight)
      )
      ro.observe(el.firstElementChild!)
      w.__stop165 = () => ro.disconnect()
    })
    await t.send('stream a long one')
    await expect(t.panel.getByText('word39')).toBeVisible({ timeout: 20_000 })
    await expect(t.panel.locator('[data-chat-text][data-streaming="true"]')).toHaveCount(0, {
      timeout: 10_000
    })
    const gaps = await t.page.evaluate(() => {
      const w = window as Window & { __gaps165?: number[]; __stop165?: () => void }
      w.__stop165?.()
      return w.__gaps165 ?? []
    })
    expect(gaps.length).toBeGreaterThan(10)
    // Pinned: at the bottom after every growth (follow-bottom's own threshold).
    expect(Math.max(...gaps)).toBeLessThanOrEqual(70)
    await expect(t.panel.getByText('Jump to latest')).toHaveCount(0)
    expect(await mountedRows(t.page)).toBeLessThanOrEqual(MOUNTED_MAX)
  })
})
