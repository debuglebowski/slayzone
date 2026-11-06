import { afterEach, expect, test } from 'vitest'
import {
  createTestHarness,
  createSlayzoneDbAdapter
} from '../../../../shared/test-utils/ipc-harness'
import { createChatThreadStore } from './chat-threads-store'
import { listChatQueue, popChatQueueHead, pushChatQueue, requeueAtHead } from './chat-queue-store'
const harnesses: Awaited<ReturnType<typeof createTestHarness>>[] = []
afterEach(() => {
  for (const h of harnesses.splice(0)) h.db.close()
})

test('threads persist separately, can share an answer, and never replace main provider config', async () => {
  const h = await createTestHarness()
  harnesses.push(h)
  h.db.prepare("INSERT INTO projects (id,name,color) VALUES ('p','P','#000')").run()
  h.db
    .prepare(
      `INSERT INTO tasks (id,project_id,title,provider_config) VALUES ('t','p','T','{"claude-chat":{"chatConversationId":"main"}}')`
    )
    .run()
  h.db
    .prepare(
      "INSERT INTO terminal_tabs (id,task_id,mode,position) VALUES ('parent','t','claude-chat',0)"
    )
    .run()
  const store = createChatThreadStore(createSlayzoneDbAdapter(h.db))
  const base = {
    parentTabId: 'parent',
    taskId: 't',
    mode: 'claude-chat',
    parentConversationId: 'main',
    answerId: 'answer',
    sourceMessageId: 'question',
    sourceUuid: 'assistant-record',
    title: 'Question',
    conversationId: null,
    closedAt: null,
    createdAt: 1
  }
  await store.create({ ...base, id: 'thread-one' })
  await store.create({ ...base, id: 'thread-two' })
  await store.setConversation('thread-one', 'fork-one')
  expect((await store.list('parent', 'main')).map((t) => t.id)).toEqual([
    'thread-one',
    'thread-two'
  ])
  expect((await store.get('thread-one'))?.conversationId).toBe('fork-one')
  expect(
    (
      h.db.prepare('SELECT provider_config FROM tasks WHERE id = ?').get('t') as {
        provider_config: string
      }
    ).provider_config
  ).toContain('"main"')
  expect(await store.list('parent', 'another-conversation')).toEqual([])
  await expect(store.create({ ...base, id: 'foreign', taskId: 'missing' })).rejects.toThrow()
  expect(h.db.prepare("SELECT id FROM terminal_tabs WHERE id = 'foreign'").get()).toBeUndefined()
  pushChatQueue(h.db, 'parent', 'conclusion', 'conclusion', { expectedConversationId: 'main' })
  const queued = popChatQueueHead(h.db, 'parent')!
  expect(queued.expectedConversationId).toBe('main')
  requeueAtHead(h.db, queued)
  expect(
    (await listChatQueue(createSlayzoneDbAdapter(h.db), 'parent'))[0].expectedConversationId
  ).toBe('main')
  h.db.prepare("DELETE FROM terminal_tabs WHERE id = 'parent'").run()
  expect(await store.get('thread-one')).toBeUndefined()
  expect(h.db.prepare("SELECT id FROM terminal_tabs WHERE id LIKE 'thread-%'").all()).toEqual([])
})
