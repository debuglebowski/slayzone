import type { Locator, Page } from '@playwright/test'
import { resetApp } from '../fixtures/electron'
import { type ChatTask, echoTurn, expect, test } from '../fixtures/chat'

/**
 * The answer-threads panel this tab has open, as `answer-threads-panel.ts` keeps it
 * in localStorage (key `slayzone:chat-threads-panel:[hubId, tabId]`); null = closed.
 * A reload restores what is stored, so a test awaits the write before reloading.
 */
async function storedPanel(t: ChatTask): Promise<{ activeId: string | null } | null> {
  return t.page.evaluate((tabId) => {
    const prefix = 'slayzone:chat-threads-panel:'
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (!key?.startsWith(prefix)) continue
      const [, tab] = JSON.parse(key.slice(prefix.length)) as [string, string]
      if (tab === tabId) return JSON.parse(localStorage.getItem(key) ?? 'null')
    }
    return null
  }, t.tabId)
}

/** This main conversation's threads, as the server stores them. */
async function listThreads(t: ChatTask, conversationId: string) {
  return t.page.evaluate((input) => window.getTrpcVanillaClient().chat.threads.list.query(input), {
    ...t.opts(),
    conversationId
  })
}

/** No turn running anywhere in `scope` (main panel and its thread panels). */
async function expectIdle(scope: Locator): Promise<void> {
  await expect(scope.getByRole('button', { name: 'Stop generation' })).toHaveCount(0)
}

/** Ask a new thread's first question and wait for its turn to finish. */
async function startThread(page: Page, side: Locator, question: string): Promise<void> {
  await side.getByRole('textbox', { name: 'First thread question' }).fill(question)
  await side.getByRole('button', { name: 'Start thread', exact: true }).click()
  await expect(side.getByText(`echo: ${question}`, { exact: true })).toBeVisible()
  await expectIdle(page.getByRole('complementary', { name: 'Answer threads' }))
}

test.describe('Answer threads', () => {
  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
  })

  test('a finished answer shows its hover toolbar on the top-right edge', async ({ chat }) => {
    const t = await chat.openTask({
      title: 'Answer toolbar',
      scenario: { processes: [{ defaultTurn: echoTurn() }] }
    })
    await t.send('main question')
    const main = t.panel
    const answer = main
      .getByTestId('chat-assistant-answer')
      .filter({ hasText: 'echo: main question' })
    await expect(answer).toBeVisible()
    // A completed answer: its layout no longer grows.
    await expectIdle(main)
    await expect(answer).toHaveCSS('padding-top', '20px')
    await expect(answer).toHaveCSS('padding-bottom', '20px')
    const toolbar = answer.getByRole('toolbar', { name: 'Answer actions' })
    await expect(toolbar).toHaveCSS('opacity', '0')
    await answer.hover()
    await expect(toolbar).toHaveCSS('opacity', '1')
    await expect(toolbar.getByRole('button', { name: 'Copy response', exact: true })).toBeVisible()
    // Both rects from ONE layout snapshot: 10px above the row, 20px in from its right edge.
    const offsets = () =>
      answer.evaluate((row) => {
        const bar = row.querySelector('[role="toolbar"][aria-label="Answer actions"]')
        const r = row.getBoundingClientRect()
        const b = bar!.getBoundingClientRect()
        return {
          top: Math.abs(b.y - (r.y - 10)),
          right: Math.abs(b.x + b.width - (r.x + r.width - 20))
        }
      })
    await expect.poll(async () => Math.max(...Object.values(await offsets()))).toBeLessThan(1)
    const settled = await offsets()
    expect(settled.top).toBeLessThan(1)
    expect(settled.right).toBeLessThan(1)
    await test.info().attach('answer-toolbar', {
      body: await t.page.screenshot(),
      contentType: 'image/png'
    })
  })

  test('side threads preserve main, support tabs, reopen, and return an edited conclusion', async ({
    chat
  }) => {
    const t = await chat.openTask({
      title: 'Threaded answer',
      scenario: {
        processes: [
          { defaultTurn: echoTurn() },
          { defaultTurn: echoTurn() },
          { defaultTurn: echoTurn() }
        ]
      }
    })
    await t.send('main question')
    const main = t.panel
    const answer = main
      .getByTestId('chat-assistant-answer')
      .filter({ hasText: 'echo: main question' })
    await expect(answer).toBeVisible()
    await expectIdle(main)
    const original = (await t.run(0)).sessionId!
    await answer.hover()
    await answer.getByRole('button', { name: 'Start thread', exact: true }).click()
    const side = t.page.getByRole('complementary', { name: 'Answer threads' })
    await startThread(t.page, side, 'first side question')
    const fork = await t.run(1)
    expect(fork.flag('--resume')).toBe(original)
    expect(fork.peersAliveAtStart).toContain(0)
    expect(fork.forked).toBe(true)
    await side.getByRole('button', { name: 'New thread', exact: true }).click()
    await startThread(t.page, side, 'second side question')
    await expect(side.getByRole('tab')).toHaveCount(2)
    await side.getByRole('tab', { name: 'first side question', exact: true }).click()
    await expect(side.getByText('echo: first side question', { exact: true })).toBeVisible()
    await side.getByRole('button', { name: 'Send to main', exact: true }).click()
    const dialog = t.page.getByRole('alertdialog')
    await dialog
      .getByRole('textbox', { name: 'Thread conclusion' })
      .fill('Use queued delivery while main is working.')
    await dialog.getByRole('button', { name: 'Send to main', exact: true }).click()
    await expect(main.getByText(/Answer from thread “first side question”/)).toBeVisible()
    await side.getByRole('button', { name: 'Close threads', exact: true }).click()
    await expect(answer.getByRole('button', { name: /Threads 2 items/ })).toBeVisible()
    await main
      .getByRole('button', { name: 'Open thread: first side question', exact: true })
      .click()
    await expect(side.getByRole('tab')).toHaveCount(2)
    await side.getByRole('button', { name: 'Close threads', exact: true }).click()
    // Reload only once the conclusion's main turn finished and the closed panel is stored.
    await expect(main.getByText(/^echo: Answer from thread “first side question”/)).toBeVisible()
    await expectIdle(main)
    await expect.poll(() => storedPanel(t)).toBeNull()
    await t.reload()
    const reopened = t.panel
    await expect(reopened.getByRole('button', { name: /Threads 2 items/ })).toHaveCount(1)
    await reopened.getByRole('button', { name: /Threads 2 items/ }).click()
    await expect(
      t.page.getByRole('complementary', { name: 'Answer threads' }).getByRole('tab')
    ).toHaveCount(2)
    expect((await t.run(0)).sessionId).toBe(original)

    // The open panel and its selected thread survive a reload; closing it is remembered too.
    await t.page
      .getByRole('complementary', { name: 'Answer threads' })
      .getByRole('tab', { name: 'second side question', exact: true })
      .click()
    const second = (await listThreads(t, original)).find((x) => x.title === 'second side question')
    expect(second).toBeTruthy()
    await expect.poll(async () => (await storedPanel(t))?.activeId).toBe(second!.id)
    await t.reload()
    const restored = t.page.getByRole('complementary', { name: 'Answer threads' })
    await expect(
      restored.getByRole('tab', { name: 'second side question', exact: true })
    ).toHaveAttribute('aria-selected', 'true')
    await expect(restored.getByText('echo: second side question', { exact: true })).toBeVisible()
    // The task handle still names one panel, its own, while a thread's chat is open beside it.
    await expect(t.panel).toBeVisible()
    await expect(t.panel.getByText('echo: main question', { exact: true })).toBeVisible()
    await restored.getByRole('button', { name: 'Close threads', exact: true }).click()
    await expect.poll(() => storedPanel(t)).toBeNull()
    await t.reload()
    await expect(t.panel.getByRole('button', { name: /Threads 2 items/ })).toHaveCount(1)
    await expect(t.page.getByRole('complementary', { name: 'Answer threads' })).toHaveCount(0)
  })

  test('a thread closes (agent stops, leaves the tabs) and reopens with its history', async ({
    chat
  }) => {
    const t = await chat.openTask({
      title: 'Closable threads',
      scenario: {
        processes: [
          { defaultTurn: echoTurn() },
          { defaultTurn: echoTurn() },
          { defaultTurn: echoTurn() },
          { defaultTurn: echoTurn() }
        ]
      }
    })
    await t.send('main question')
    const main = t.panel
    const answer = main
      .getByTestId('chat-assistant-answer')
      .filter({ hasText: 'echo: main question' })
    await expect(answer).toBeVisible()
    await expectIdle(main)
    await answer.hover()
    await answer.getByRole('button', { name: 'Start thread', exact: true }).click()
    const side = t.page.getByRole('complementary', { name: 'Answer threads' })
    for (const question of ['first side question', 'second side question']) {
      if (question !== 'first side question')
        await side.getByRole('button', { name: 'New thread', exact: true }).click()
      await startThread(t.page, side, question)
    }
    // The first thread's own (forked) conversation, which a reopen must resume.
    const mainConversation = (await t.run(0)).sessionId!
    const listed = await listThreads(t, mainConversation)
    const firstConversation = listed.find((x) => x.title === 'first side question')?.conversationId
    expect(firstConversation).toBeTruthy()
    const second = listed.find((x) => x.title === 'second side question')
    expect(second).toBeTruthy()

    // Closing the selected thread stops its agent and selects the next open one.
    await side.getByRole('tab', { name: 'first side question', exact: true }).click()
    await side
      .getByRole('button', { name: 'Close thread: first side question', exact: true })
      .click()
    await expect(side.getByRole('tab')).toHaveCount(1)
    await expect(
      side.getByRole('tab', { name: 'second side question', exact: true })
    ).toHaveAttribute('aria-selected', 'true')
    await expect.poll(async () => (await t.run(1)).exit()).toBeTruthy()
    await expect(answer.getByRole('button', { name: /Threads 1 open · 1 closed/ })).toBeVisible()

    // Closed survives a reload (stored server-side; the selection is stored locally).
    await expect
      .poll(async () =>
        (await listThreads(t, mainConversation)).map((x) => [x.title, x.closedAt != null])
      )
      .toContainEqual(['first side question', true])
    await expect.poll(async () => (await storedPanel(t))?.activeId).toBe(second!.id)
    await t.reload()
    const restored = t.page.getByRole('complementary', { name: 'Answer threads' })
    await expect(restored.getByRole('tab')).toHaveCount(1)

    // Reopen from the closed list: its history is back and it resumes its conversation.
    await restored.getByRole('button', { name: 'Closed threads (1)', exact: true }).click()
    await t.page.getByRole('menuitem', { name: 'first side question' }).click()
    await expect(restored.getByRole('tab')).toHaveCount(2)
    await expect(
      restored.getByRole('tab', { name: 'first side question', exact: true })
    ).toHaveAttribute('aria-selected', 'true')
    await expect(restored.getByText('echo: first side question', { exact: true })).toBeVisible()
    await expect(restored.getByRole('button', { name: /Closed threads/ })).toHaveCount(0)
    const threadComposer = restored.locator('[data-chat-panel]:visible textarea').first()
    await threadComposer.fill('follow-up after reopen')
    await threadComposer.press('Enter')
    await expect(restored.getByText('echo: follow-up after reopen', { exact: true })).toBeVisible()
    const resumed = await t.run(3)
    expect(resumed.flag('--resume')).toBe(firstConversation)
    expect(resumed.forked).toBe(false)
    await expectIdle(restored)

    // Closing every thread leaves the "New thread" state with the closed list.
    await restored
      .getByRole('button', { name: 'Close thread: first side question', exact: true })
      .click()
    await restored
      .getByRole('button', { name: 'Close thread: second side question', exact: true })
      .click()
    await expect(restored.getByRole('tab')).toHaveCount(0)
    await expect(restored.getByRole('textbox', { name: 'First thread question' })).toBeVisible()
    await expect(
      restored.getByRole('button', { name: 'Closed threads (2)', exact: true })
    ).toBeVisible()
    await expect(t.panel.getByRole('button', { name: /Threads 2 closed/ })).toBeVisible()
  })
})
