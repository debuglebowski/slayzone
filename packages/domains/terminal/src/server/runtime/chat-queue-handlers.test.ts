/**
 * Queue ops for editing and reordering (plan item 4.2): a queued message being
 * edited is HELD — the drain never sends it (nor anything behind it) until the
 * edit is saved or cancelled, or the hold lapses. Edits and moves change what
 * the agent gets; a file attached in an edit passes the attachment gate.
 *
 * Run with: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron node_modules/vitest/vitest.mjs run --config packages/shared/test-utils/vitest.harness.config.ts packages/domains/terminal/src/server/runtime/chat-queue-handlers.test.ts
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type {
  OutgoingUserMessage,
  QueuedChatMessage,
  UserContentBlock
} from '@slayzone/terminal-contracts'

const transport = vi.hoisted(() => ({
  ready: true,
  dispatched: [] as Array<{ tabId: string; message: OutgoingUserMessage }>
}))
vi.mock('./chat-transport-manager', () => ({
  getSessionTerminalState: () => 'idle',
  isReadyForQueuedMessage: () => transport.ready,
  ensureSpawned: async () => undefined,
  registerChatQueueDrainer: () => undefined,
  getEventBufferSince: () => [],
  dispatchUserMessage: (tabId: string, message: OutgoingUserMessage) => {
    transport.dispatched.push({ tabId, message })
    return { id: message.id, state: 'queued' }
  }
}))

import { createChatQueueOps, drainChatQueue, HOLD_MS } from './chat-queue-handlers'
import type { ChatQueueData } from './chat-queue-data'
import type { AttachmentLookup } from './chat-attachment-guard'
import type { SlayzoneDb } from '@slayzone/platform'

/** An in-memory queue with the real store's semantics (held head → no pop). */
function memoryQueue(): ChatQueueData {
  let rows: QueuedChatMessage[] = []
  let n = 0
  return {
    list: async (tabId) => rows.filter((r) => r.tabId === tabId),
    push: async (tabId, send, original, opts) => {
      const row: QueuedChatMessage = {
        id: opts?.id ?? `q${++n}`,
        tabId,
        send,
        original,
        position: rows.length,
        createdAt: 'now',
        ...(opts?.content ? { content: opts.content } : {})
      }
      rows.push(row)
      return row
    },
    pop: async (tabId, heldIds = []) => {
      const head = rows.find((r) => r.tabId === tabId)
      if (!head || heldIds.includes(head.id)) return null
      rows = rows.filter((r) => r !== head)
      return head
    },
    requeue: async (msg) => {
      rows.unshift(msg)
    },
    update: async (id, next) => {
      const row = rows.find((r) => r.id === id)
      if (!row) return false
      Object.assign(row, next)
      return true
    },
    move: async (id, toIndex) => {
      const row = rows.find((r) => r.id === id)
      if (!row) return false
      rows = rows.filter((r) => r !== row)
      rows.splice(toIndex, 0, row)
      return true
    },
    remove: async (id) => {
      const before = rows.length
      rows = rows.filter((r) => r.id !== id)
      return rows.length < before
    },
    clear: async (tabId) => {
      const before = rows.length
      rows = rows.filter((r) => r.tabId !== tabId)
      return before - rows.length
    },
    getTabIdForItem: async (id) => rows.find((r) => r.id === id)?.tabId ?? null
  }
}

const lookup: AttachmentLookup = {
  tab: async () => ({ taskId: 'task-1', mode: 'claude-chat' }),
  artifacts: async (ids) =>
    new Map(ids.map((id) => [id, { taskId: 'task-1', contentHash: `h-${id}` }])),
  queued: async () => [],
  hasVersion: async () => false
}

const db = {} as SlayzoneDb
const sentTexts = (): string[] =>
  transport.dispatched.map((d) =>
    d.message.content.map((b) => (b.type === 'text' ? b.text : `[${b.attachment.name}]`)).join(' ')
  )

beforeEach(() => {
  vi.useFakeTimers()
  transport.ready = true
  transport.dispatched = []
})
afterEach(() => {
  vi.useRealTimers()
})

describe('queue: edit holds', () => {
  test('a held message is not sent when the agent is free; saving the edit sends the new text', async () => {
    const data = memoryQueue()
    const ops = createChatQueueOps(db, data, lookup)
    transport.ready = false
    const q = await ops.push('tab-1', 'first draft', 'first draft')
    expect(await ops.hold(q.id)).toBe(true)
    transport.ready = true
    await drainChatQueue(db, 'tab-1', data)
    expect(transport.dispatched).toEqual([])
    expect(
      await ops.update(q.id, {
        send: 'better',
        original: 'better',
        content: [{ type: 'text', text: 'better' }]
      })
    ).toBe(true)
    await ops.release(q.id)
    expect(sentTexts()).toEqual(['better'])
  })

  test('the hold keeps later messages waiting too (order is kept)', async () => {
    const data = memoryQueue()
    const ops = createChatQueueOps(db, data, lookup)
    transport.ready = false
    const a = await ops.push('tab-1', 'a', 'a')
    await ops.push('tab-1', 'b', 'b')
    await ops.hold(a.id)
    transport.ready = true
    await drainChatQueue(db, 'tab-1', data)
    expect(transport.dispatched).toEqual([])
    await ops.release(a.id)
    expect(sentTexts()).toEqual(['a'])
  })

  test('a hold lapses unless renewed (an editor that went away cannot block the queue)', async () => {
    const data = memoryQueue()
    const ops = createChatQueueOps(db, data, lookup)
    transport.ready = false
    const q = await ops.push('tab-1', 'x', 'x')
    await ops.hold(q.id)
    transport.ready = true
    await vi.advanceTimersByTimeAsync(HOLD_MS - 1000)
    expect(await ops.hold(q.id)).toBe(true) // renewed
    await vi.advanceTimersByTimeAsync(HOLD_MS - 1000)
    expect(transport.dispatched).toEqual([])
    await vi.advanceTimersByTimeAsync(2000)
    expect(sentTexts()).toEqual(['x'])
  })

  test('holding a message that was already sent fails (the editor never opens on it)', async () => {
    const data = memoryQueue()
    const ops = createChatQueueOps(db, data, lookup)
    const q = await ops.push('tab-1', 'x', 'x') // agent free: sent at once
    expect(sentTexts()).toEqual(['x'])
    expect(await ops.hold(q.id)).toBe(false)
  })
})

describe('queue: move and edit', () => {
  test('move changes the order messages go out in', async () => {
    const data = memoryQueue()
    const ops = createChatQueueOps(db, data, lookup)
    transport.ready = false
    await ops.push('tab-1', 'a', 'a')
    const b = await ops.push('tab-1', 'b', 'b')
    expect(await ops.move(b.id, 0)).toBe(true)
    transport.ready = true
    await drainChatQueue(db, 'tab-1', data)
    await drainChatQueue(db, 'tab-1', data)
    expect(sentTexts()).toEqual(['b', 'a'])
  })

  test('files added in an edit (or a push) are sealed by the attachment gate', async () => {
    const data = memoryQueue()
    const ops = createChatQueueOps(db, data, lookup)
    transport.ready = false
    const file: UserContentBlock = {
      type: 'attachment',
      attachment: {
        artifactId: 'a1',
        name: 'red.png',
        kind: 'image',
        mediaType: 'image/png',
        size: 9
      }
    }
    const q = await ops.push('tab-1', 'look', 'look', {
      content: [file, { type: 'text', text: 'look' }]
    })
    expect((await data.list('tab-1'))[0].content?.[0]).toMatchObject({
      attachment: { contentHash: 'h-a1' }
    })
    await ops.update(q.id, {
      send: 'again',
      original: 'again',
      content: [file, { type: 'text', text: 'again' }]
    })
    expect((await data.list('tab-1'))[0].content?.[0]).toMatchObject({
      attachment: { contentHash: 'h-a1' }
    })
  })
})
