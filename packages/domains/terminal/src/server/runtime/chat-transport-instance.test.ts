import { afterEach, expect, test } from 'vitest'
import { createChatTransport } from './chat-transport-manager'

const runtimes: Array<ReturnType<typeof createChatTransport>> = []
afterEach(async () => {
  for (const r of runtimes.splice(0)) await r.shutdownAll({ termGraceMs: 1, hardTimeoutMs: 10 })
})
test('independent runtime instances do not share tabs, event logs or emitters', async () => {
  function runtime(text: string) {
    const value = createChatTransport({
      eventStore: {
        load: async () => [
          { seq: 0, at: 1, event: { kind: 'assistant-text', messageId: 'm', text } }
        ],
        insert: async () => 'inserted',
        readRange: async () => []
      }
    })
    runtimes.push(value)
    return value
  }
  const a = runtime('hub A'),
    b = runtime('hub B')
  const opts = {
    tabId: 'tab',
    taskId: 'task',
    mode: 'claude-chat',
    cwd: '/tmp',
    providerFlags: [],
    conversationId: null
  }
  await a.hydrateSession(opts)
  expect(b.getSessionInfo('tab')).toBeNull()
  await b.hydrateSession(opts)
  expect((await a.getReplay('tab', -1)).events[0].event).toMatchObject({ text: 'hub A' })
  expect((await b.getReplay('tab', -1)).events[0].event).toMatchObject({ text: 'hub B' })
  expect(a.chatEvents).not.toBe(b.chatEvents)
  await a.removeSession('tab')
  expect(b.getSessionInfo('tab')).not.toBeNull()
})
