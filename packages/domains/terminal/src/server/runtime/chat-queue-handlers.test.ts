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
  conversationId: 'source',
  dispatched: [] as Array<{ tabId: string; message: OutgoingUserMessage }>,
  steered: [] as Array<{ tabId: string; message: OutgoingUserMessage }>,
  steerResult: { ok: true } as { ok: true } | { ok: false; reason: string },
  withdrawn: [] as string[],
  withdrawResult: true,
  steerListener: null as
    | ((tabId: string, id: string, outcome: 'picked-up' | 'returned') => void)
    | null
}))
vi.mock('./chat-transport-manager', () => ({
  getSessionTerminalState: () => 'idle',
  getSessionInfo: () => ({ sessionId: transport.conversationId }),
  isReadyForQueuedMessage: () => transport.ready,
  ensureSpawned: async () => undefined,
  registerChatQueueDrainer: () => undefined,
  registerSteerListener: (
    fn: (tabId: string, id: string, outcome: 'picked-up' | 'returned') => void
  ) => {
    transport.steerListener = fn
  },
  steerUserMessage: async (tabId: string, message: OutgoingUserMessage) => {
    transport.steered.push({ tabId, message })
    return transport.steerResult
  },
  withdrawSteer: async (_tabId: string, id: string) => {
    transport.withdrawn.push(id)
    return transport.withdrawResult
  },
  getEventBufferSince: () => [],
  dispatchUserMessage: (tabId: string, message: OutgoingUserMessage) => {
    transport.dispatched.push({ tabId, message })
    return { id: message.id, state: 'queued' }
  }
}))

import { chatQueueEvents, createChatQueueOps, drainChatQueue, HOLD_MS } from './chat-queue-handlers'
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
        ...(opts?.content ? { content: opts.content } : {}),
        ...(opts?.expectedConversationId
          ? { expectedConversationId: opts.expectedConversationId }
          : {})
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
  transport.conversationId = 'source'
  transport.dispatched = []
  transport.steered = []
  transport.steerResult = { ok: true }
  transport.withdrawn = []
  transport.withdrawResult = true
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

test('a returned thread answer waits for its source conversation after a session switch', async () => {
  const data = memoryQueue()
  const ops = createChatQueueOps(db, data, lookup)
  transport.ready = false
  await ops.push('tab-1', 'thread conclusion', 'thread conclusion', {
    expectedConversationId: 'source'
  })
  transport.conversationId = 'another-conversation'
  transport.ready = true
  await drainChatQueue(db, 'tab-1', data)
  expect(sentTexts()).toEqual([])
  expect(await data.list('tab-1')).toHaveLength(1)
  transport.conversationId = 'source'
  await drainChatQueue(db, 'tab-1', data)
  expect(sentTexts()).toEqual(['thread conclusion'])
})

describe('queue: add to the running turn (steer)', () => {
  // Steering state lives in the module's queue runtime: each test gets its own tab.
  let n = 0
  let tab = ''
  /** A turn is running (the queue holds), with `a` and `b` queued. */
  async function queued() {
    tab = `steer-tab-${++n}`
    const data = memoryQueue()
    const ops = createChatQueueOps(db, data, lookup)
    transport.ready = false
    const a = await ops.push(tab, 'a', 'a')
    const b = await ops.push(tab, 'b', '/b-original')
    return { data, ops, a, b }
  }

  test('steer hands the message to the turn; it stays listed, marked, until picked up', async () => {
    const { ops, b } = await queued()
    expect(await ops.steer(b.id)).toEqual({ ok: true })
    expect(transport.steered).toEqual([
      { tabId: tab, message: { id: b.id, content: [{ type: 'text', text: 'b' }] } }
    ])
    const list = await ops.list(tab)
    expect(list.map((m) => [m.send, m.steering ?? false])).toEqual([
      ['a', false],
      ['b', true]
    ])
  })

  test('picked up: the row leaves the queue (drained, with its original text)', async () => {
    const { ops, b } = await queued()
    const drained: string[] = []
    const onDrained = (_tab: string, original: string) => drained.push(original)
    chatQueueEvents.on('queue-drained', onDrained)
    await ops.steer(b.id)
    transport.steerListener!(tab, b.id, 'picked-up')
    await vi.waitFor(async () => expect((await ops.list(tab)).map((m) => m.send)).toEqual(['a']))
    chatQueueEvents.off('queue-drained', onDrained)
    expect(drained).toEqual(['/b-original'])
  })

  test('nothing drains while a steered message waits: it goes first', async () => {
    const { data, ops, b } = await queued()
    await ops.steer(b.id)
    transport.ready = true
    await drainChatQueue(db, tab, data)
    expect(transport.dispatched).toEqual([])
    // Picked up, it is the agent's message in flight: the queue waits for its answer.
    transport.ready = false
    transport.steerListener!(tab, b.id, 'picked-up')
    await vi.waitFor(async () => expect(await ops.list(tab)).toHaveLength(1))
    transport.ready = true
    await drainChatQueue(db, tab, data)
    expect(sentTexts()).toEqual(['a'])
  })

  test('returned: an ordinary queued message again, in its place', async () => {
    const { data, ops, b } = await queued()
    await ops.steer(b.id)
    transport.steerListener!(tab, b.id, 'returned')
    await vi.waitFor(async () =>
      expect((await ops.list(tab)).map((m) => m.steering ?? false)).toEqual([false, false])
    )
    transport.ready = true
    await drainChatQueue(db, tab, data)
    await drainChatQueue(db, tab, data)
    expect(sentTexts()).toEqual(['a', 'b'])
  })

  test('refused by the agent: unmarked, and why', async () => {
    const { ops, b } = await queued()
    transport.steerResult = { ok: false, reason: 'no active turn to steer' }
    expect(await ops.steer(b.id)).toEqual({ ok: false, reason: 'no active turn to steer' })
    expect((await ops.list(tab)).every((m) => !m.steering)).toBe(true)
  })

  test('a held (edited) message cannot be steered; a steered one cannot be edited or moved', async () => {
    const { ops, a, b } = await queued()
    await ops.hold(a.id)
    expect(await ops.steer(a.id)).toMatchObject({ ok: false })
    expect(transport.steered).toEqual([])
    await ops.steer(b.id)
    expect(await ops.hold(b.id)).toBe(false)
    expect(
      await ops.update(b.id, { send: 'x', original: 'x', content: [{ type: 'text', text: 'x' }] })
    ).toBe(false)
    expect(await ops.move(b.id, 0)).toBe(false)
    expect(await ops.steer(b.id)).toMatchObject({ ok: false })
  })

  test('removing a steered message withdraws it first; one the agent kept stays', async () => {
    const { ops, a, b } = await queued()
    await ops.steer(b.id)
    transport.withdrawResult = false
    expect(await ops.remove(b.id)).toBe(false)
    expect((await ops.list(tab)).map((m) => m.id)).toEqual([a.id, b.id])

    transport.withdrawResult = true
    expect(await ops.remove(b.id)).toBe(true)
    expect(transport.withdrawn).toEqual([b.id, b.id])
    expect((await ops.list(tab)).map((m) => m.id)).toEqual([a.id])
  })

  test('clear withdraws steered messages too; one the agent kept is left listed', async () => {
    const { ops, b } = await queued()
    await ops.steer(b.id)
    transport.withdrawResult = false
    expect(await ops.clear(tab)).toBe(1)
    expect((await ops.list(tab)).map((m) => m.id)).toEqual([b.id])
  })
})

describe('queue: item ops are scoped to the tab that names them (robustness plan §9, v208)', () => {
  test('an item op naming another tab finds nothing and changes nothing', async () => {
    const data = memoryQueue()
    const ops = createChatQueueOps(db, data, lookup)
    transport.ready = false
    const q = await ops.push('tab-1', 'mine', 'mine')
    const text = [{ type: 'text' as const, text: 'x' }]
    expect(await ops.update(q.id, { send: 'x', original: 'x', content: text }, 'tab-2')).toBe(false)
    expect(await ops.move(q.id, 0, 'tab-2')).toBe(false)
    expect(await ops.hold(q.id, 'tab-2')).toBe(false)
    expect(await ops.steer(q.id, 'tab-2')).toMatchObject({ ok: false })
    expect(await ops.remove(q.id, 'tab-2')).toBe(false)
    expect((await ops.list('tab-1')).map((m) => m.send)).toEqual(['mine'])
    // The right tab still reaches it.
    expect(await ops.hold(q.id, 'tab-1')).toBe(true)
    await ops.release(q.id, 'tab-2')
    transport.ready = true
    await drainChatQueue(db, 'tab-1', data)
    expect(transport.dispatched).toEqual([])
    transport.ready = false
    await ops.release(q.id, 'tab-1')
    expect(await ops.remove(q.id, 'tab-1')).toBe(true)
  })
})
