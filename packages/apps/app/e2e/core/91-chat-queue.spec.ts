import { test, expect, seed, resetApp } from '../fixtures/electron'
import { TEST_PROJECT_PATH } from '../fixtures/electron'

/**
 * Backend-persisted chat queue (table `chat_queue`). Validates the IPC layer
 * + DB persistence + FK cascade without spawning a real claude subprocess —
 * the drainer no-ops when no session exists, but push/list/remove/clear all
 * exercise the same SQLite store the runtime uses.
 */
test.describe('Chat queue persistence', () => {
  let taskId: string
  let mainTabId: string

  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
    const s = seed(mainWindow)
    const p = await s.createProject({
      name: 'Chat Queue',
      color: '#22d3ee',
      path: TEST_PROJECT_PATH
    })

    const task = await s.createTask({ projectId: p.id, title: 'Queue task', status: 'in_progress' })
    taskId = task.id

    await mainWindow.evaluate(
      async (id) =>
        window.getTrpcVanillaClient().task.update.mutate({ id, terminalMode: 'claude-code' } as never),
      taskId
    )
    await s.refreshData()

    // Materialize a main tab so chat_queue rows have a valid FK target.
    mainTabId = await mainWindow.evaluate(async (id) => {
      const tab = await window
        .getTrpcVanillaClient()
        .taskTerminals.ensureMain.mutate({ taskId: id, mode: 'claude-code' })
      return tab.id
    }, taskId)
  })

  test('push/list maintains FIFO order', async ({ mainWindow }) => {
    await mainWindow.evaluate(
      async (id) => window.getTrpcVanillaClient().chat.queue.clear.mutate({ tabId: id }),
      mainTabId
    )

    await mainWindow.evaluate(
      async (id) =>
        window
          .getTrpcVanillaClient()
          .chat.queue.push.mutate({ tabId: id, send: 'first send', original: 'first og' }),
      mainTabId
    )
    await mainWindow.evaluate(
      async (id) =>
        window
          .getTrpcVanillaClient()
          .chat.queue.push.mutate({ tabId: id, send: 'second send', original: 'second og' }),
      mainTabId
    )

    const list = await mainWindow.evaluate(
      async (id) => window.getTrpcVanillaClient().chat.queue.list.query({ tabId: id }),
      mainTabId
    )
    expect(list).toHaveLength(2)
    expect(list[0]?.send).toBe('first send')
    expect(list[0]?.original).toBe('first og')
    expect(list[1]?.send).toBe('second send')
    expect(list[0]!.position).toBeLessThan(list[1]!.position)
  })

  test('remove drops one item and preserves the rest', async ({ mainWindow }) => {
    const list = await mainWindow.evaluate(
      async (id) => window.getTrpcVanillaClient().chat.queue.list.query({ tabId: id }),
      mainTabId
    )
    const firstId = list[0]!.id

    const removed = await mainWindow.evaluate(
      async (id) => window.getTrpcVanillaClient().chat.queue.remove.mutate({ id }),
      firstId
    )
    expect(removed).toBe(true)

    const after = await mainWindow.evaluate(
      async (id) => window.getTrpcVanillaClient().chat.queue.list.query({ tabId: id }),
      mainTabId
    )
    expect(after).toHaveLength(1)
    expect(after[0]?.send).toBe('second send')
  })

  test('clear empties the queue for a tab', async ({ mainWindow }) => {
    const cleared = await mainWindow.evaluate(
      async (id) => window.getTrpcVanillaClient().chat.queue.clear.mutate({ tabId: id }),
      mainTabId
    )
    expect(cleared).toBeGreaterThanOrEqual(1)

    const after = await mainWindow.evaluate(
      async (id) => window.getTrpcVanillaClient().chat.queue.list.query({ tabId: id }),
      mainTabId
    )
    expect(after).toEqual([])
  })

  test('queue survives across re-listing (DB persistence)', async ({ mainWindow }) => {
    await mainWindow.evaluate(
      async (id) =>
        window
          .getTrpcVanillaClient()
          .chat.queue.push.mutate({ tabId: id, send: 'persisted', original: 'persisted' }),
      mainTabId
    )

    // Force a fresh roundtrip — list always reads SQLite, no in-memory cache.
    const list1 = await mainWindow.evaluate(
      async (id) => window.getTrpcVanillaClient().chat.queue.list.query({ tabId: id }),
      mainTabId
    )
    const list2 = await mainWindow.evaluate(
      async (id) => window.getTrpcVanillaClient().chat.queue.list.query({ tabId: id }),
      mainTabId
    )
    expect(list1).toEqual(list2)
    expect(list1).toHaveLength(1)
    expect(list1[0]?.send).toBe('persisted')

    await mainWindow.evaluate(
      async (id) => window.getTrpcVanillaClient().chat.queue.clear.mutate({ tabId: id }),
      mainTabId
    )
  })

  test('chat:queue-changed broadcast fires on push', async ({ mainWindow }) => {
    // Subscribe in renderer, capture next event for this tab, then push.
    const observed = await mainWindow.evaluate(async (id) => {
      return new Promise<string>((resolve) => {
        const off = window.api.chatQueue.onChanged((tabId) => {
          if (tabId === id) {
            off()
            resolve(tabId)
          }
        })
        void window
          .getTrpcVanillaClient()
          .chat.queue.push.mutate({ tabId: id, send: 'broadcast probe', original: 'broadcast probe' })
      })
    }, mainTabId)
    expect(observed).toBe(mainTabId)

    await mainWindow.evaluate(
      async (id) => window.getTrpcVanillaClient().chat.queue.clear.mutate({ tabId: id }),
      mainTabId
    )
  })

  test('FK cascade clears queue when tab deleted', async ({ mainWindow }) => {
    // Make a fresh tab so we can delete it without affecting other tests.
    const ephemeralTabId = await mainWindow.evaluate(async (id) => {
      const tab = await window
        .getTrpcVanillaClient()
        .taskTerminals.create.mutate({ taskId: id, mode: 'claude-code' })
      return tab.id
    }, taskId)

    await mainWindow.evaluate(
      async (id) =>
        window
          .getTrpcVanillaClient()
          .chat.queue.push.mutate({ tabId: id, send: 'will cascade', original: 'will cascade' }),
      ephemeralTabId
    )
    const before = await mainWindow.evaluate(
      async (id) => window.getTrpcVanillaClient().chat.queue.list.query({ tabId: id }),
      ephemeralTabId
    )
    expect(before).toHaveLength(1)

    await mainWindow.evaluate(
      async (id) => window.getTrpcVanillaClient().taskTerminals.delete.mutate({ tabId: id }),
      ephemeralTabId
    )

    const after = await mainWindow.evaluate(
      async (id) => window.getTrpcVanillaClient().chat.queue.list.query({ tabId: id }),
      ephemeralTabId
    )
    expect(after).toEqual([])
  })
})
