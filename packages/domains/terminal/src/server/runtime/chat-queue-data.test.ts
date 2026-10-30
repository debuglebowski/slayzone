/**
 * Tests for the chat-queue data seam (`createDbChatQueueData`) against a real
 * in-memory sqlite db. Covers the drain-critical semantics the runtime relies
 * on: FIFO pop order after pushes, requeue-at-head retry, clear counts, and
 * the remove/getTabIdForItem pair used for the queue-changed broadcast.
 *
 * Uses the shared IPC test harness: real migrations (canonical chat_queue
 * schema + FK pragmas, so tab rows are seeded through terminal_tabs/tasks/
 * projects) and a `SlayzoneDb` adapter whose `namedTxn` dispatches through the
 * REAL production txn registry — a missing/renamed `chat-queue:*` registration
 * fails here, not just in production.
 */
import { describe, expect, test } from 'vitest'
import {
  createTestHarness,
  type TestHarness
} from '../../../../../shared/test-utils/ipc-harness.js'
import { createDbChatQueueData } from './chat-queue-data'

/**
 * chat_queue.tab_id references terminal_tabs(id) (FK enforced by the harness
 * pragmas), so every tab id used by a test needs the full parent chain.
 */
function seedTabs(h: TestHarness, ...tabIds: string[]): void {
  h.db
    .prepare("INSERT OR IGNORE INTO projects (id, name, color) VALUES ('proj-1', 'P', '#000')")
    .run()
  h.db
    .prepare("INSERT OR IGNORE INTO tasks (id, project_id, title) VALUES ('task-1', 'proj-1', 'T')")
    .run()
  const insertTab = h.db.prepare(
    "INSERT INTO terminal_tabs (id, task_id, mode, position) VALUES (?, 'task-1', 'claude-chat', 0)"
  )
  for (const id of tabIds) insertTab.run(id)
}

describe('chat-queue data seam', () => {
  test('push assigns FIFO positions and pop drains in push order', async () => {
    const h = await createTestHarness()
    try {
      seedTabs(h, 'tab-1', 'tab-2')
      const data = createDbChatQueueData(h.slayDb)
      const m1 = await data.push('tab-1', 'one', '/one')
      const m2 = await data.push('tab-1', 'two', '/two')
      const m3 = await data.push('tab-1', 'three', '/three')
      await data.push('tab-2', 'other', '/other')

      expect(m1.tabId).toBe('tab-1')
      expect(m1.send).toBe('one')
      expect(m1.original).toBe('/one')
      expect([m1.position, m2.position, m3.position]).toEqual([0, 1, 2])
      expect((await data.list('tab-1')).map((m) => m.send)).toEqual(['one', 'two', 'three'])

      const drained: string[] = []
      for (let head = await data.pop('tab-1'); head; head = await data.pop('tab-1')) {
        drained.push(head.send)
      }
      expect(drained).toEqual(['one', 'two', 'three'])
      expect(await data.pop('tab-1')).toBeNull()
      expect(await data.list('tab-2')).toHaveLength(1)
    } finally {
      h.cleanup()
    }
  })

  test('requeue re-inserts at head so the next drain retries it', async () => {
    const h = await createTestHarness()
    try {
      seedTabs(h, 'tab-1')
      const data = createDbChatQueueData(h.slayDb)
      await data.push('tab-1', 'first', '/first')
      await data.push('tab-1', 'second', '/second')

      const head = await data.pop('tab-1')
      expect(head?.send).toBe('first')

      // Send failed — put it back; it must come out first again.
      await data.requeue(head!)
      expect((await data.list('tab-1')).map((m) => m.send)).toEqual(['first', 'second'])

      const retry = await data.pop('tab-1')
      expect(retry?.id).toBe(head!.id)
      expect((await data.pop('tab-1'))?.send).toBe('second')
    } finally {
      h.cleanup()
    }
  })

  test('clear removes only that tab and returns the removed count', async () => {
    const h = await createTestHarness()
    try {
      seedTabs(h, 'tab-1', 'tab-2')
      const data = createDbChatQueueData(h.slayDb)
      await data.push('tab-1', 'a', '/a')
      await data.push('tab-1', 'b', '/b')
      await data.push('tab-2', 'c', '/c')

      expect(await data.clear('tab-1')).toBe(2)
      expect(await data.list('tab-1')).toHaveLength(0)
      expect(await data.list('tab-2')).toHaveLength(1)
      expect(await data.clear('tab-1')).toBe(0)
    } finally {
      h.cleanup()
    }
  })

  test('remove deletes by id; getTabIdForItem resolves the owning tab', async () => {
    const h = await createTestHarness()
    try {
      seedTabs(h, 'tab-1')
      const data = createDbChatQueueData(h.slayDb)
      const msg = await data.push('tab-1', 'x', '/x')

      expect(await data.getTabIdForItem(msg.id)).toBe('tab-1')
      expect(await data.remove(msg.id)).toBe(true)
      expect(await data.getTabIdForItem(msg.id)).toBeNull()
      expect(await data.remove(msg.id)).toBe(false)
    } finally {
      h.cleanup()
    }
  })

  test('update rewrites text, original and content (and re-stamps it); false once it is gone', async () => {
    const h = await createTestHarness()
    try {
      seedTabs(h, 'tab-1')
      const data = createDbChatQueueData(h.slayDb)
      const msg = await data.push('tab-1', 'old', 'old', {
        content: [{ type: 'text', text: 'old' }]
      })
      h.db
        .prepare("UPDATE chat_queue SET created_at = '2000-01-01 00:00:00' WHERE id = ?")
        .run(msg.id)
      const content = [{ type: 'text' as const, text: 'new' }]
      expect(await data.update(msg.id, { send: 'new', original: 'new', content })).toBe(true)
      const [row] = await data.list('tab-1')
      expect(row).toMatchObject({ id: msg.id, send: 'new', original: 'new', content, position: 0 })
      expect(row.createdAt).not.toBe('2000-01-01 00:00:00')
      await data.pop('tab-1')
      expect(await data.update(msg.id, { send: 'x', original: 'x', content })).toBe(false)
    } finally {
      h.cleanup()
    }
  })

  test('move puts an item at a new index, others keep their order', async () => {
    const h = await createTestHarness()
    try {
      seedTabs(h, 'tab-1')
      const data = createDbChatQueueData(h.slayDb)
      const a = await data.push('tab-1', 'a', 'a')
      await data.push('tab-1', 'b', 'b')
      const c = await data.push('tab-1', 'c', 'c')
      expect(await data.move(c.id, 0)).toBe(true)
      expect((await data.list('tab-1')).map((m) => [m.send, m.position])).toEqual([
        ['c', 0],
        ['a', 1],
        ['b', 2]
      ])
      expect(await data.move(c.id, 99)).toBe(true)
      expect((await data.list('tab-1')).map((m) => m.send)).toEqual(['a', 'b', 'c'])
      expect(await data.move(a.id, 1)).toBe(true)
      expect((await data.list('tab-1')).map((m) => m.send)).toEqual(['b', 'a', 'c'])
      expect(await data.move('nope', 0)).toBe(false)
    } finally {
      h.cleanup()
    }
  })

  test('pop leaves a held head in place (an edit in progress); the rest waits behind it', async () => {
    const h = await createTestHarness()
    try {
      seedTabs(h, 'tab-1')
      const data = createDbChatQueueData(h.slayDb)
      const a = await data.push('tab-1', 'a', 'a')
      await data.push('tab-1', 'b', 'b')
      expect(await data.pop('tab-1', [a.id])).toBeNull()
      expect(await data.list('tab-1')).toHaveLength(2)
      expect((await data.pop('tab-1', ['other']))?.send).toBe('a')
    } finally {
      h.cleanup()
    }
  })
})
