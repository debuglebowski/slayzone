/**
 * A chat tab reloads its history (chat.hydrate + replay) when its inputs change
 * while it stays mounted — e.g. the task's agent flags are edited. The reload
 * must show the history once, exactly as a fresh open does, not replay it on top
 * of the messages already on screen.
 *
 * No agent subprocess: the history is seeded straight into `chat_events`, which
 * chat.hydrate loads into a session skeleton without spawning (startup = manual).
 */
import { test, expect, seed, resetApp, TEST_PROJECT_PATH } from '../fixtures/electron'
import { openTaskViaSearch } from '../fixtures/browser-view'

const MESSAGES = ['seeded-alpha-message', 'seeded-beta-message']

test.describe('Chat reload', () => {
  let taskId = ''

  test.beforeAll(async ({ mainWindow, electronApp }) => {
    await resetApp(mainWindow)
    await mainWindow.evaluate(() =>
      window
        .getTrpcVanillaClient()
        .settings.set.mutate({ key: 'terminal_agent_startup', value: 'manual' })
    )
    const s = seed(mainWindow)
    const p = await s.createProject({
      name: 'Chat Reload',
      color: '#22d3ee',
      path: TEST_PROJECT_PATH
    })
    const task = await s.createTask({ projectId: p.id, title: 'Chat reload task', status: 'todo' })
    taskId = task.id
    await mainWindow.evaluate(
      (id) =>
        window
          .getTrpcVanillaClient()
          .task.update.mutate({ id, terminalMode: 'claude-chat' } as never),
      taskId
    )
    const tabId = await mainWindow.evaluate(async (id) => {
      const tab = await window
        .getTrpcVanillaClient()
        .taskTerminals.ensureMain.mutate({ taskId: id, mode: 'claude-chat' })
      return tab.id
    }, taskId)

    // Two completed turns: user message → assistant reply → result.
    const events = MESSAGES.flatMap((text, i) => [
      { kind: 'user-message', text },
      { kind: 'assistant-text', messageId: `m${i}`, text: `reply ${i}` },
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
        text: `reply ${i}`,
        modelUsage: {},
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0
        },
        permissionDenials: []
      }
    ])
    await electronApp.evaluate(
      async ({}, { tab, evs }) => {
        const db = (globalThis as Record<string, unknown>).__db as {
          run: (sql: string, params?: unknown[]) => Promise<unknown>
        }
        for (const [seq, ev] of evs.entries()) {
          await db.run('INSERT INTO chat_events (tab_id, seq, event) VALUES (?, ?, ?)', [
            tab,
            seq,
            JSON.stringify(ev)
          ])
        }
      },
      { tab: tabId, evs: events }
    )
    await s.refreshData()
    await openTaskViaSearch(mainWindow, 'Chat reload task')
  })

  test('editing the agent flags reloads the chat without duplicating it', async ({
    mainWindow
  }) => {
    const first = mainWindow.getByText(MESSAGES[0], { exact: true })
    await expect(first).toHaveCount(1, { timeout: 10_000 })
    await expect(mainWindow.getByText(MESSAGES[1], { exact: true })).toHaveCount(1)

    // Record every change in how many times the first message is on screen. A
    // reload either clears the list (→ 0) or replays on top (→ 2), so a non-1 entry
    // proves the reload ran; the count must then settle at 1.
    await mainWindow.evaluate((msg) => {
      const count = (): number => {
        let n = 0
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
        while (walker.nextNode()) if (walker.currentNode.textContent?.trim() === msg) n++
        return n
      }
      const seen: number[] = [count()]
      ;(window as unknown as { __msgCounts: number[] }).__msgCounts = seen
      new MutationObserver(() => {
        const n = count()
        if (n !== seen[seen.length - 1]) seen.push(n)
      }).observe(document.body, { childList: true, subtree: true, characterData: true })
    }, MESSAGES[0])
    const counts = (): Promise<number[]> =>
      mainWindow.evaluate(() => (window as unknown as { __msgCounts: number[] }).__msgCounts)

    await mainWindow.evaluate(
      (id) =>
        window.getTrpcVanillaClient().task.update.mutate({
          id,
          providerConfig: { 'claude-chat': { flags: '--verbose' } }
        } as never),
      taskId
    )
    await seed(mainWindow).refreshData()
    await expect
      .poll(async () => (await counts()).some((n) => n !== 1), { timeout: 10_000 })
      .toBe(true)
    await expect(first).toHaveCount(1, { timeout: 5_000 })
    expect(Math.max(...(await counts()))).toBe(1)
    await expect(mainWindow.getByText(MESSAGES[1], { exact: true })).toHaveCount(1)
  })
})
