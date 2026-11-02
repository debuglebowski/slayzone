import { expect, test } from 'vitest'
import { createChatTransport } from './chat-transport-manager'
import { createChatQueueRuntime } from './chat-queue-handlers'

test('queue notifications stay inside their hub runtime', () => {
  const a = createChatQueueRuntime(createChatTransport())
  const b = createChatQueueRuntime(createChatTransport())
  const seen: string[] = []
  a.chatQueueEvents.on('queue-changed', (id) => seen.push(`a:${id}`))
  b.chatQueueEvents.on('queue-changed', (id) => seen.push(`b:${id}`))
  a.notifyChatQueueChanged('same-tab')
  b.notifyChatQueueChanged('same-tab')
  expect(seen).toEqual(['a:same-tab', 'b:same-tab'])
})
