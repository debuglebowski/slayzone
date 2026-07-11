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
 * Run with: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron --import tsx/esm <file>
 */
import {
  createTestHarness,
  describe,
  test,
  expect,
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

await describe('chat-queue data seam', () => {
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
})
