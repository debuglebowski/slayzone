import { resetApp } from '../fixtures/electron'
import { echoTurn, expect, test } from '../fixtures/chat'

test.describe('Answer threads', () => {
  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
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
    const main = t.page.locator('[data-chat-panel]:visible').first()
    const answer = main
      .getByTestId('chat-assistant-answer')
      .filter({ hasText: 'echo: main question' })
    await expect(answer).toBeVisible()
    await expect(answer).toHaveCSS('padding-top', '20px')
    await expect(answer).toHaveCSS('padding-bottom', '20px')
    await expect(answer.getByRole('toolbar', { name: 'Answer actions' })).toHaveCSS('opacity', '0')
    const original = (await t.run(0)).sessionId!
    await answer.hover()
    await expect(answer.getByRole('toolbar', { name: 'Answer actions' })).toHaveCSS('opacity', '1')
    const toolbar = answer.getByRole('toolbar', { name: 'Answer actions' })
    await expect(toolbar.getByRole('button', { name: 'Copy response', exact: true })).toBeVisible()
    const rowBounds = (await answer.boundingBox())!
    const toolbarBounds = (await toolbar.boundingBox())!
    expect(Math.abs(toolbarBounds.y - (rowBounds.y - 10))).toBeLessThan(1)
    expect(
      Math.abs(toolbarBounds.x + toolbarBounds.width - (rowBounds.x + rowBounds.width - 20))
    ).toBeLessThan(1)
    await t.page.screenshot({ path: '/tmp/slayzone-option-d-native.png' })
    await answer.getByRole('button', { name: 'Start thread', exact: true }).click()
    const side = t.page.getByRole('complementary', { name: 'Answer threads' })
    await side.getByRole('textbox', { name: 'First thread question' }).fill('first side question')
    await side.getByRole('button', { name: 'Start thread', exact: true }).click()
    await expect(side.getByText('echo: first side question', { exact: true })).toBeVisible()
    const fork = await t.run(1)
    expect(fork.flag('--resume')).toBe(original)
    expect(fork.peersAliveAtStart).toContain(0)
    expect(fork.forked).toBe(true)
    await side.getByRole('button', { name: 'New thread', exact: true }).click()
    await side.getByRole('textbox', { name: 'First thread question' }).fill('second side question')
    await side.getByRole('button', { name: 'Start thread', exact: true }).click()
    await expect(side.getByText('echo: second side question', { exact: true })).toBeVisible()
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
    await t.reload()
    const reopened = t.page.locator('[data-chat-panel]:visible').first()
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
    await t.reload()
    const restored = t.page.getByRole('complementary', { name: 'Answer threads' })
    await expect(
      restored.getByRole('tab', { name: 'second side question', exact: true })
    ).toHaveAttribute('aria-selected', 'true')
    await expect(restored.getByText('echo: second side question', { exact: true })).toBeVisible()
    await restored.getByRole('button', { name: 'Close threads', exact: true }).click()
    await t.reload()
    await expect(
      t.page
        .locator('[data-chat-panel]:visible')
        .first()
        .getByRole('button', { name: /Threads 2 items/ })
    ).toHaveCount(1)
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
    const main = t.page.locator('[data-chat-panel]:visible').first()
    const answer = main
      .getByTestId('chat-assistant-answer')
      .filter({ hasText: 'echo: main question' })
    await answer.hover()
    await answer.getByRole('button', { name: 'Start thread', exact: true }).click()
    const side = t.page.getByRole('complementary', { name: 'Answer threads' })
    for (const question of ['first side question', 'second side question']) {
      if (question !== 'first side question')
        await side.getByRole('button', { name: 'New thread', exact: true }).click()
      await side.getByRole('textbox', { name: 'First thread question' }).fill(question)
      await side.getByRole('button', { name: 'Start thread', exact: true }).click()
      await expect(side.getByText(`echo: ${question}`, { exact: true })).toBeVisible()
    }
    // The first thread's own (forked) conversation, which a reopen must resume.
    const mainConversation = (await t.run(0)).sessionId!
    const listed = await t.page.evaluate(
      (input) => window.getTrpcVanillaClient().chat.threads.list.query(input),
      { ...t.opts(), conversationId: mainConversation }
    )
    const firstConversation = listed.find((x) => x.title === 'first side question')?.conversationId
    expect(firstConversation).toBeTruthy()

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

    // Closed survives a reload.
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
    await expect(
      t.page
        .locator('[data-chat-panel]:visible')
        .first()
        .getByRole('button', { name: /Threads 2 closed/ })
    ).toBeVisible()
  })
})
