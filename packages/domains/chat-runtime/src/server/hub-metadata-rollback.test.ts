/**
 * Plan §5: chat metadata stamps are never trusted as proof. The computer is the
 * authority over a conversation's metadata; its counter can go BACK (restored
 * from a backup, a recreated chat database). An update the hub cannot place is
 * a reason to re-read the conversation in full — never to ack and drop it.
 */
import { afterEach, expect, test } from 'vitest'
import { createTestHarness } from '../../../../shared/test-utils/ipc-harness'
import { createChatOwnershipStore } from './hub-ownership'
import { createHubChatRelay } from './hub-relay'
import type { ChatMetadataSnapshot, ChatMetadataUpdate } from './local-data'

type Harness = Awaited<ReturnType<typeof createTestHarness>>
const harnesses: Harness[] = []
afterEach(() => {
  for (const h of harnesses.splice(0)) h.cleanup()
})

/** A scripted computer holding one conversation `c` of task `task`. */
async function setup() {
  const h = await createTestHarness()
  harnesses.push(h)
  h.db.exec(
    "INSERT INTO projects(id,name,color) VALUES('p','P','#000'); INSERT INTO tasks(id,project_id,title) VALUES('task','p','T'); INSERT INTO terminal_tabs(id,task_id,mode,position) VALUES('tab','task','claude-chat',0)"
  )
  const ownership = createChatOwnershipStore(h.slayDb)
  await ownership.register({
    id: 'c',
    taskId: 'task',
    tabId: 'tab',
    mode: 'claude-chat',
    computerId: 'pc',
    epoch: 1
  })
  let ops = 0
  const pc = {
    storeId: 'store-1',
    counter: 0,
    /** Files the computer holds: id → order. */
    files: new Map<string, number>(),
    /** Unacknowledged updates (the computer's `metadata:*` records). */
    pending: [] as ChatMetadataUpdate[],
    snapshots: 0,
    acked: [] as string[],
    failAck: false
  }
  const backup = () => ({
    storeId: pc.storeId,
    counter: pc.counter,
    files: new Map(pc.files),
    pending: [...pc.pending]
  })
  const restore = (b: ReturnType<typeof backup>) => Object.assign(pc, b)
  const stamp = (u: ChatMetadataUpdate) => ({ ...u, storeId: pc.storeId })
  /** The computer writes a file and queues its metadata update. */
  const writeFile = (id: string, order = 0) => {
    pc.files.set(id, order)
    const update: ChatMetadataUpdate = {
      operationId: `op-${++ops}`,
      sequence: ++pc.counter,
      conversationId: 'c',
      taskId: 'task',
      tabId: 'tab',
      epoch: 1,
      kind: 'artifact-changed',
      value: { id, folderId: null, order }
    }
    pc.pending.push(update)
    return stamp(update)
  }
  const relay = createHubChatRelay({
    onSessionsChanged: () => {},
    db: h.slayDb,
    ownership,
    request: async (_computer, raw) => {
      const r = raw as { kind: string; id: string; operationId: string }
      if (r.kind === 'metadata.snapshot') {
        pc.snapshots++
        const snapshot: ChatMetadataSnapshot = {
          identity: { id: 'c', taskId: 'task', tabId: 'tab', mode: 'claude-chat', epoch: 1 },
          counter: pc.counter,
          storeId: pc.storeId,
          pending: pc.pending.map((u) => u.operationId),
          updates: [...pc.files].map(([id, order]) => ({
            operationId: `snapshot:c:${id}`,
            sequence: pc.counter,
            conversationId: 'c',
            taskId: 'task',
            tabId: 'tab',
            epoch: 1,
            kind: 'artifact-changed' as const,
            value: { id, folderId: null, order }
          }))
        }
        return snapshot
      }
      if (r.kind === 'ackMetadata') {
        if (pc.failAck) throw new Error('computer disconnected')
        pc.pending = pc.pending.filter((u) => u.operationId !== r.operationId)
        pc.acked.push(r.operationId)
        return { ok: true }
      }
      if (r.kind === 'pendingMetadata') return pc.pending.map(stamp)
      throw new Error(`unexpected ${r.kind}`)
    },
    resolveComputer: async () => 'pc',
    defaultComputer: async () => 'pc',
    bootstrap: async () => {
      throw new Error('Metadata must not bootstrap')
    },
    migrate: async () => {
      throw new Error('Metadata must not migrate')
    }
  })
  const progress = () =>
    h.db
      .prepare("SELECT sequence,store_id FROM chat_metadata_progress WHERE conversation_id='c'")
      .get() as { sequence: number; store_id: string | null } | undefined
  const file = (id: string) =>
    h.db
      .prepare(
        'SELECT a.id,a."order",l.conversation_id,l.unavailable_reason FROM task_artifacts a LEFT JOIN chat_artifact_locations l ON l.artifact_id=a.id WHERE a.id=?'
      )
      .get(id) as
      | { id: string; order: number; conversation_id: string; unavailable_reason: string | null }
      | undefined
  /** Applied updates the computer has not confirmed yet. */
  const receipts = () =>
    (
      h.db
        .prepare('SELECT operation_id FROM chat_metadata_receipts WHERE acked=0 ORDER BY 1')
        .all() as Array<{
        operation_id: string
      }>
    ).map((r) => r.operation_id)
  return { h, pc, relay, writeFile, backup, restore, progress, file, receipts }
}

test('computer restored from a backup: an update at an already-consumed position is re-read, never acked and dropped', async () => {
  const { pc, relay, writeFile, backup, restore, progress, file } = await setup()
  await relay.reconcileMetadata('pc', writeFile('f1'))
  const old = backup()
  await relay.reconcileMetadata('pc', writeFile('f2'))
  expect(progress()?.sequence).toBe(2)
  restore(old)
  // The restored computer counts from 1 again: f3 lands at position 2.
  const f3 = writeFile('f3')
  expect(f3.sequence).toBe(2)
  await relay.reconcileMetadata('pc', f3)
  expect(pc.snapshots).toBe(1)
  expect(file('f3')).toMatchObject({ conversation_id: 'c', unavailable_reason: null })
  // The hub's newer file is kept, marked: the computer no longer has it.
  expect(file('f2')).toMatchObject({ unavailable_reason: 'missing-on-computer' })
  expect(file('f1')).toMatchObject({ unavailable_reason: null })
  expect(progress()).toEqual({ sequence: 2, store_id: 'store-1' })
  expect(pc.pending).toEqual([])
  // Reported again: the mark clears.
  await relay.reconcileMetadata('pc', writeFile('f2', 4))
  expect(file('f2')).toMatchObject({ order: 4, unavailable_reason: null })
})

test('an update the hub applied but whose ack was lost is acked on redelivery without a re-read', async () => {
  const { pc, relay, writeFile, progress, receipts } = await setup()
  const f1 = writeFile('f1')
  pc.failAck = true
  await expect(relay.reconcileMetadata('pc', f1)).rejects.toThrow('computer disconnected')
  expect(receipts()).toEqual([f1.operationId])
  pc.failAck = false
  await relay.reconcileMetadata('pc', f1)
  expect(pc.snapshots).toBe(0)
  expect(pc.acked).toEqual([f1.operationId])
  expect(receipts()).toEqual([])
  expect(progress()?.sequence).toBe(1)
})

test('a snapshot behind the hub cursor rebases (cursor moves back) instead of fencing the chat', async () => {
  const { pc, relay, writeFile, backup, restore, progress, file } = await setup()
  const empty = backup()
  await relay.reconcileMetadata('pc', writeFile('f1'))
  await relay.reconcileMetadata('pc', writeFile('f2'))
  restore(empty)
  await relay.recoverMetadata('pc', 'c')
  expect(progress()).toEqual({ sequence: 0, store_id: 'store-1' })
  expect(file('f1')).toMatchObject({ unavailable_reason: 'missing-on-computer' })
  // A later normal re-read keeps a marked file marked (never deletes it).
  await relay.recoverMetadata('pc', 'c')
  expect(file('f2')).toMatchObject({ unavailable_reason: 'missing-on-computer' })
  expect(pc.snapshots).toBe(2)
})

test('another chat database (store id): its counters restart, the hub re-reads from them', async () => {
  const { pc, relay, writeFile, progress, file } = await setup()
  await relay.reconcileMetadata('pc', writeFile('f1'))
  await relay.reconcileMetadata('pc', writeFile('f2'))
  await relay.reconcileMetadata('pc', writeFile('f3'))
  Object.assign(pc, { storeId: 'store-2', counter: 0, files: new Map(), pending: [] })
  const fresh = writeFile('f9')
  await relay.reconcileMetadata('pc', fresh)
  expect(pc.snapshots).toBe(1)
  expect(file('f9')).toMatchObject({ conversation_id: 'c', unavailable_reason: null })
  expect(progress()).toEqual({ sequence: 1, store_id: 'store-2' })
})

test('pending updates a re-read already covered are acked without being applied again', async () => {
  const { pc, relay, writeFile, file, receipts } = await setup()
  await relay.reconcileMetadata('pc', writeFile('f1'))
  const older = writeFile('f2', 1)
  const newer = writeFile('f2', 5)
  // A gap: the newer update arrives first, so the hub re-reads in full.
  await relay.reconcileMetadata('pc', newer)
  expect(pc.snapshots).toBe(1)
  expect(receipts()).toEqual([older.operationId])
  await relay.reconcileMetadata('pc', older)
  expect(pc.snapshots).toBe(1)
  expect(file('f2')).toMatchObject({ order: 5 })
  expect(receipts()).toEqual([])
  expect(pc.pending).toEqual([])
})

test('a live notification of an update a drain already acked is recognized, not read as a rollback', async () => {
  const { pc, relay, writeFile } = await setup()
  const f1 = writeFile('f1')
  await relay.drainMetadata('pc')
  expect(pc.acked).toEqual([f1.operationId])
  // The same update's live notification arrives after the drain acked it.
  await relay.reconcileMetadata('pc', f1)
  expect(pc.snapshots).toBe(0)
})
