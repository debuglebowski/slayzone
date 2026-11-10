/**
 * Consistency rules for plan §5 (versions never trusted as proof): each
 * planted drift between the hub and a computer is reported by its rule; an
 * agreeing pair reports none.
 */
import { afterEach, expect, test } from 'vitest'
import { createTestHarness } from '../../../../shared/test-utils/ipc-harness'
import { checkComputerChatConsistency, checkHubChatConsistency } from './hub-consistency'
import { createChatOwnershipStore } from './hub-ownership'
import type { ChatMetadataSnapshot } from './local-data'

type Harness = Awaited<ReturnType<typeof createTestHarness>>
const harnesses: Harness[] = []
afterEach(() => {
  for (const h of harnesses.splice(0)) h.cleanup()
})

test('metadata cursor ahead, file missing, an unrouted queue tab and lifecycle divergence are each reported', async () => {
  const h = await createTestHarness()
  harnesses.push(h)
  h.db.exec(`INSERT INTO projects(id,name,color) VALUES('p','P','#000');
    INSERT INTO tasks(id,project_id,title) VALUES('task','p','T'),('bare','p','No chats');
    INSERT INTO terminal_tabs(id,task_id,mode,position) VALUES('tab','task','claude-chat',0)`)
  await createChatOwnershipStore(h.slayDb).register({
    id: 'c',
    taskId: 'task',
    tabId: 'tab',
    mode: 'claude-chat',
    computerId: 'pc',
    epoch: 1
  })
  // Agreeing state: cursor 3 in store s1; one file f1; the tab routed to c;
  // both tasks at the hub's acknowledged lifecycle.
  h.db.exec(`INSERT INTO chat_metadata_progress(conversation_id,sequence,store_id) VALUES('c',3,'s1');
    INSERT INTO task_artifacts(id,task_id,title) VALUES('f1','task','Chat attachment'),('f2','task','Chat attachment');
    INSERT INTO chat_artifact_locations(artifact_id,conversation_id) VALUES('f1','c');
    INSERT INTO chat_artifact_locations(artifact_id,conversation_id,unavailable_reason,unavailable_since) VALUES('f2','c','missing-on-computer',1);
    INSERT OR IGNORE INTO chat_task_computers VALUES('task','pc'),('bare','pc');
    UPDATE chat_task_lifecycle SET state='active',revision=2;
    INSERT INTO chat_lifecycle_acks VALUES('task','pc',2),('bare','pc',2)`)
  const computer = {
    counter: 3,
    storeId: 's1',
    files: ['f1'],
    lifecycles: [
      { taskId: 'bare', state: 'active', revision: 2 },
      { taskId: 'task', state: 'active', revision: 2 }
    ]
  }
  const request = async (_pc: string, raw: unknown): Promise<unknown> => {
    const r = raw as { kind: string }
    if (r.kind === 'task.lifecycles') return computer.lifecycles
    if (r.kind === 'turns') return []
    if (r.kind === 'taskPaths') return []
    if (r.kind !== 'metadata.snapshot') throw new Error(r.kind)
    const base = { conversationId: 'c', taskId: 'task', tabId: 'tab', epoch: 1 }
    const snapshot: ChatMetadataSnapshot = {
      identity: { id: 'c', taskId: 'task', tabId: 'tab', mode: 'claude-chat', epoch: 1 },
      counter: computer.counter,
      storeId: computer.storeId,
      pending: [],
      updates: [
        ...computer.files.map((id) => ({
          ...base,
          operationId: `snapshot:c:${id}`,
          sequence: computer.counter,
          kind: 'artifact-changed' as const,
          value: { id, folderId: null, order: 0 }
        }))
      ]
    }
    return snapshot
  }
  const rules = async () =>
    [
      ...(await checkHubChatConsistency(h.slayDb)),
      ...(await checkComputerChatConsistency(h.slayDb, request, 'pc'))
    ]
      .map((v) => v.rule)
      .sort()
  expect(await rules()).toEqual([])

  // The computer restored from a backup: counter behind, f1 gone (unmarked),
  // the pause the hub acknowledged is gone — and the hub no longer routes the
  // tab (its queued messages, reached through the tab since v208) to c.
  computer.counter = 1
  computer.files = []
  h.db.exec("DELETE FROM chat_tab_bindings WHERE tab_id='tab'")
  h.db.exec("UPDATE chat_task_lifecycle SET state='paused',revision=3 WHERE task_id='bare'")
  h.db.exec("UPDATE chat_lifecycle_acks SET revision=3 WHERE task_id='bare'")
  // And a computer ahead of the hub on another task (hub restored).
  computer.lifecycles[1] = { taskId: 'task', state: 'paused', revision: 9 }
  expect(await rules()).toEqual([
    'computer-file-missing',
    'lifecycle-divergence',
    'metadata-cursor-ahead',
    'queue-tab-unrouted'
  ])

  // Another chat database with an equal counter is still drift.
  computer.counter = 3
  computer.files = ['f1']
  h.db.exec("INSERT INTO chat_tab_bindings(tab_id,conversation_id) VALUES('tab','c')")
  computer.storeId = 's2'
  computer.lifecycles = [
    { taskId: 'bare', state: 'paused', revision: 3 },
    { taskId: 'task', state: 'active', revision: 2 }
  ]
  expect(await rules()).toEqual(['metadata-cursor-ahead'])
})

test('an unconfirmed receipt beyond its cursor is reported', async () => {
  const h = await createTestHarness()
  harnesses.push(h)
  h.db.exec(`INSERT INTO projects(id,name,color) VALUES('p','P','#000');
    INSERT INTO tasks(id,project_id,title) VALUES('task','p','T');
    INSERT INTO terminal_tabs(id,task_id,mode,position) VALUES('tab','task','claude-chat',0)`)
  await createChatOwnershipStore(h.slayDb).register({
    id: 'c',
    taskId: 'task',
    tabId: 'tab',
    mode: 'claude-chat',
    computerId: 'pc',
    epoch: 1
  })
  h.db.exec(`INSERT INTO chat_metadata_progress(conversation_id,sequence,store_id) VALUES('c',2,'s');
    INSERT INTO chat_metadata_receipts(conversation_id,operation_id,sequence,acked) VALUES('c','old',9,1),('c','ok',2,0)`)
  const rules = async () => (await checkHubChatConsistency(h.slayDb)).map((v) => v.rule)
  expect(await rules()).toEqual([])
  h.db.exec(
    "INSERT INTO chat_metadata_receipts(conversation_id,operation_id,sequence) VALUES('c','ahead',3)"
  )
  expect(await rules()).toEqual(['metadata-receipt-ahead-of-cursor'])
})
