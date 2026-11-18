/**
 * Chat event blobs (crash fix 4): base64 payloads of saved events live once in the
 * content-addressed blob store; events keep references; pins keep them alive.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { isChatBlobRef, resolveChatBlobs, type AgentEvent } from '@slayzone/terminal-contracts'
import { openChatStorage, CHAT_BLOB_CHUNK_BYTES } from './storage'
import { encodeTransfer } from './transfers'
import { createComputerChatRuntime } from './computer-runtime'
import { createChatRetention } from './retention'
// Fails the test on a lifecycle model / runtime disagreement.
import '../../../terminal/src/server/runtime/chat-lifecycle-strict-testkit'

const roots: string[] = []
const closers: Array<() => unknown> = []
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
function tmp() {
  const root = mkdtempSync(join(tmpdir(), 'slz-event-blobs-'))
  roots.push(root)
  return root
}
function open(root = tmp(), scope = 'hub-a') {
  const store = openChatStorage({ stateDir: root, hubScope: scope })
  closers.push(() => store.close())
  return { store, root }
}
function runtime(root = tmp()) {
  const r = createComputerChatRuntime({ stateDir: root, hubScope: 'hub-a', computerId: 'pc' })
  closers.push(() => r.close())
  for (const taskId of ['task-a', 'task-b'])
    r.bootstrap({
      identity: { id: taskId, taskId, tabId: `tab-${taskId}`, mode: 'claude-chat', epoch: 1 },
      projectId: null,
      cwd: root,
      revision: 1,
      providerConfig: {},
      defaultFlags: null,
      env: {}
    })
  return r
}

const identity = (id: string) => ({
  id,
  taskId: `task-${id}`,
  tabId: `tab-${id}`,
  mode: 'claude-chat',
  epoch: 1
})
const png = (seed: number, size = 4096) =>
  Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(size, seed)
  ])
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex')
const screenshot = (bytes: Buffer): AgentEvent => ({
  kind: 'tool-result',
  toolUseId: 'tool-1',
  isError: false,
  rawContent: [
    {
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: bytes.toString('base64') }
    }
  ],
  structured: null
})
const refOf = (event: AgentEvent) =>
  (event as { rawContent: Array<{ source: { data: unknown } }> }).rawContent[0].source.data
const rawRow = (store: ReturnType<typeof openChatStorage>, id: string, seq: number) =>
  store.compose((db) =>
    db.prepare('SELECT event,blob_form FROM events WHERE conversation_id=? AND seq=?').get(id, seq)
  ) as { event: string; blob_form: number }

describe('storage', () => {
  test('append moves the bytes to blobs/<sha256>, pins them, and reads back references', () => {
    const { store } = open()
    store.createConversation(identity('a'))
    const bytes = png(1)
    const saved = store.append('a', 1, screenshot(bytes), 10)
    expect(isChatBlobRef(refOf(saved.event))).toBe(true)
    expect(existsSync(join(store.dir, 'blobs', sha(bytes)))).toBe(true)
    const row = rawRow(store, 'a', 0)
    expect(row.blob_form).toBe(1)
    expect(row.event.length).toBeLessThan(1024)
    expect(store.read('a', -1)[0].event).toEqual(saved.event)
    expect(store.records('a', 'event-blob')).toEqual([
      {
        kind: 'event-blob',
        id: sha(bytes),
        value: { mediaType: 'image/png', size: bytes.length },
        at: 10
      }
    ])
  })

  test('identical bytes are stored once; every conversation pins them; a pin keeps its newest reference time', () => {
    const { store } = open()
    store.createConversation(identity('a'))
    store.createConversation(identity('b'))
    const bytes = png(2)
    store.append('a', 1, screenshot(bytes), 10)
    store.append('a', 1, screenshot(bytes), 20)
    store.append('b', 1, screenshot(bytes), 5)
    expect(store.records('a', 'event-blob').map((r) => r.at)).toEqual([20])
    expect(store.records('b', 'event-blob').map((r) => r.at)).toEqual([5])
  })

  test('a prepared event (extractEventBlobs, then appendAt) is saved exactly as prepared', () => {
    const { store } = open()
    store.createConversation(identity('a'))
    const prepared = store.extractEventBlobs(screenshot(png(3)))
    expect(store.appendAt('a', 1, 0, prepared, 7)).toBe('inserted')
    expect(store.read('a', -1)).toEqual([{ seq: 0, at: 7, event: prepared }])
  })

  test('appendAt refuses a reference whose bytes are not in the store', () => {
    const { store } = open()
    store.createConversation(identity('a'))
    const forged = {
      kind: 'tool-result',
      toolUseId: 't',
      isError: false,
      rawContent: [
        { $chatBlob: { v: 1, sha256: 'c'.repeat(64), mediaType: 'image/png', size: 4 } }
      ],
      structured: null
    } as AgentEvent
    expect(() => store.appendAt('a', 1, 0, forged, 1)).toThrow(/blob/i)
    expect(store.read('a', -1)).toEqual([])
  })

  test('a reference-shaped object in raw tool output stays literal and pins nothing', () => {
    const { store } = open()
    store.createConversation(identity('a'))
    const other = png(4)
    store.createConversation(identity('b'))
    store.append('b', 1, screenshot(other), 1)
    const forged = {
      kind: 'tool-result',
      toolUseId: 't',
      isError: false,
      rawContent: [
        { $chatBlob: { v: 1, sha256: sha(other), mediaType: 'image/png', size: other.length } }
      ],
      structured: null
    } as AgentEvent
    store.append('a', 1, forged, 2)
    expect(store.records('a', 'event-blob')).toEqual([])
    expect(() => store.readEventBlob('a', sha(other), 0)).toThrow()
  })

  test('readEventBlob serves pinned bytes of THAT conversation, in bounded chunks', () => {
    const { store } = open()
    store.createConversation(identity('a'))
    store.createConversation(identity('b'))
    const bytes = png(5, CHAT_BLOB_CHUNK_BYTES * 2 + 17)
    store.append('a', 1, screenshot(bytes), 1)
    const parts: Buffer[] = []
    let offset = 0
    for (;;) {
      const chunk = store.readEventBlob('a', sha(bytes), offset)
      expect(chunk).toMatchObject({ mediaType: 'image/png', size: bytes.length, offset })
      const data = Buffer.from(chunk.data, 'base64')
      expect(data.length).toBeLessThanOrEqual(CHAT_BLOB_CHUNK_BYTES)
      parts.push(data)
      offset += data.length
      if (offset >= chunk.size) break
    }
    expect(Buffer.concat(parts)).toEqual(bytes)
    expect(() => store.readEventBlob('b', sha(bytes), 0)).toThrow(/not part of this conversation/i)
    expect(() => store.readEventBlob('a', 'd'.repeat(64), 0)).toThrow(
      /not part of this conversation/i
    )
    expect(() => store.readEventBlob('a', '../chat.sqlite', 0)).toThrow()
    expect(() => store.readEventBlob('a', sha(bytes), bytes.length + 1)).toThrow(/offset/i)
    expect(() => store.readEventBlob('a', sha(bytes), -1)).toThrow(/offset/i)
    store.deleteConversation('a', 1)
    expect(() => store.readEventBlob('a', sha(bytes), 0)).toThrow()
  })

  test('clearHistory drops the pins with the events', () => {
    const { store } = open()
    store.createConversation(identity('a'))
    store.append('a', 1, screenshot(png(6)), 1)
    store.clearHistory('a', 1)
    expect(store.records('a', 'event-blob')).toEqual([])
  })

  test('export carries the original inline events (no pins); staging extracts them again', () => {
    const source = open().store
    source.createConversation(identity('a'))
    const bytes = png(7)
    const raw = screenshot(bytes)
    source.append('a', 1, raw, 3)
    source.freeze('a', 1, 'move-1')
    const snapshot = source.exportConversation('a', 1, 'move-1')
    expect(snapshot.events).toEqual([{ seq: 0, at: 3, event: raw }])
    expect(snapshot.records.some((r) => r.kind === 'event-blob')).toBe(false)
    const { bytes: wire, manifest } = encodeTransfer(snapshot)
    const target = open().store
    target.stageTransfer(manifest, wire.toString('utf8').split('\n').slice(0, -1))
    const [staged] = target.read('a', -1)
    expect(isChatBlobRef(refOf(staged.event))).toBe(true)
    expect(existsSync(join(target.dir, 'blobs', sha(bytes)))).toBe(true)
    expect(target.records('a', 'event-blob').map((r) => r.id)).toEqual([sha(bytes)])
  })

  test('a transfer from an older source drops its timeline pages (derived; rebuilt on open)', () => {
    const source = open().store
    source.createConversation(identity('a'))
    source.append('a', 1, screenshot(png(17)), 3)
    source.freeze('a', 1, 'move-2')
    const snapshot = source.exportConversation('a', 1, 'move-2')
    // What a pre-v13 source sends: its timeline pages, rows embedded raw.
    snapshot.records.push({ kind: 'timeline', id: 'page:0', value: { rows: '[]' }, at: 3 })
    const { bytes: wire, manifest } = encodeTransfer(snapshot)
    const target = open().store
    target.stageTransfer(manifest, wire.toString('utf8').split('\n').slice(0, -1))
    expect(target.records('a', 'timeline')).toEqual([])
    expect(target.read('a', -1)).toHaveLength(1)
  })

  test('export with a missing blob fails, and records a fault naming the conversation and the blob', () => {
    const { store } = open()
    store.createConversation(identity('a'))
    const bytes = png(19)
    store.append('a', 1, screenshot(bytes), 3)
    rmSync(join(store.dir, 'blobs', sha(bytes)))
    store.freeze('a', 1, 'move-3')
    expect(() => store.exportConversation('a', 1, 'move-3')).toThrow()
    const faults = store.listFaults().filter((f) => f.pass === 'computer.chat-event-blob')
    expect(faults).toHaveLength(1)
    expect(faults[0]).toMatchObject({ kind: 'structural', task_id: 'task-a' })
    expect(faults[0].item_key).toBe(`a:${sha(bytes)}`)
    expect(faults[0].message).not.toContain(bytes.toString('base64').slice(0, 16))
  })

  test('an upgraded v12 store marks its existing rows as legacy inline form', () => {
    const { store, root } = open()
    store.createConversation(identity('a'))
    const raw = screenshot(png(8))
    store.compose((db) => {
      db.exec('ALTER TABLE events DROP COLUMN blob_form')
      db.prepare('INSERT INTO events VALUES(?,?,?,?)').run('a', 0, 1, JSON.stringify(raw))
      db.pragma('user_version = 12')
    })
    store.close()
    const next = open(root).store
    expect(rawRow(next, 'a', 0).blob_form).toBe(0)
    expect(next.read('a', -1)[0].event).toEqual(raw)
    next.append('a', 1, raw, 2)
    expect(rawRow(next, 'a', 1).blob_form).toBe(1)
  })
})

test('legacy rows read back in stored form: a ref-shaped object a tool printed is escaped, never a reference', () => {
  const { store } = open()
  store.createConversation(identity('a'))
  const printed = {
    kind: 'tool-result',
    toolUseId: 't',
    isError: false,
    rawContent: [{ $chatBlob: { v: 1, sha256: 'b'.repeat(64), mediaType: 'image/png', size: 4 } }],
    structured: null
  } as AgentEvent
  store.compose((db) =>
    db
      .prepare('INSERT INTO events(conversation_id,seq,saved_at,event) VALUES(?,?,?,?)')
      .run('a', 0, 1, JSON.stringify(printed))
  )
  const [row] = store.read('a', -1)
  expect(isChatBlobRef((row.event as { rawContent: unknown[] }).rawContent[0])).toBe(false)
  expect(resolveChatBlobs(row.event, () => 'never')).toEqual(printed)
  store.freeze('a', 1, 'm')
  expect(store.exportConversation('a', 1, 'm').events[0].event).toEqual(printed)
})

describe('runtime', () => {
  test('retention keeps a pin while expired events that reference it are still there (an interrupted sweep)', async () => {
    const r = runtime()
    const now = Date.now(),
      old = now - 10 * 86_400_000
    const bytes = png(18)
    for (let n = 0; n < 599; n++)
      r.storage.append('task-a', 1, { kind: 'assistant-text', messageId: `m${n}`, text: 'x' }, old)
    r.storage.append('task-a', 1, screenshot(bytes), old + 1)
    const remaining = () =>
      r.storage.compose(
        (db) =>
          (
            db.prepare("SELECT count(*) AS n FROM events WHERE conversation_id='task-a'").get() as {
              n: number
            }
          ).n
      )
    // Busy exactly once: when the events loop is about to delete its second batch.
    let interrupted = false
    const retention = createChatRetention({
      automatic: false,
      storage: r.storage,
      local: r.local,
      busy: () => {
        if (!interrupted && remaining() === 100) {
          interrupted = true
          return true
        }
        return false
      },
      quiesce: async () => undefined,
      collectGarbage: () => r.attachments.collectGarbage(),
      changed: () => undefined
    })
    retention.configure(1)
    await retention.runNow(now)
    await retention.close()
    expect(interrupted).toBe(true)
    expect(remaining()).toBe(100)
    // The newest expired event still references the image: pinned, bytes kept.
    expect(r.storage.records('task-a', 'event-blob').map((p) => p.id)).toEqual([sha(bytes)])
    expect(existsSync(join(r.storage.dir, 'blobs', sha(bytes)))).toBe(true)
  })

  test('garbage collection keeps pinned event blobs and removes them after the conversation is deleted', async () => {
    const r = runtime()
    const bytes = png(9)
    r.storage.append('task-a', 1, screenshot(bytes), Date.now())
    r.attachments.collectGarbage()
    expect(existsSync(join(r.storage.dir, 'blobs', sha(bytes)))).toBe(true)
    await r.deleteConversation(r.storage.conversation('task-a')!.identity)
    expect(existsSync(join(r.storage.dir, 'blobs', sha(bytes)))).toBe(false)
  })

  test('retention expires a pin with its last referencing event, and keeps one a newer event still uses', async () => {
    const r = runtime()
    const now = Date.now(),
      old = now - 10 * 86_400_000
    const gone = png(10),
      kept = png(11)
    r.storage.append('task-a', 1, screenshot(gone), old)
    r.storage.append('task-a', 1, screenshot(kept), old)
    r.storage.append('task-a', 1, screenshot(kept), now)
    r.retention.configure(1)
    await r.retention.runNow(now)
    expect(r.storage.records('task-a', 'event-blob').map((p) => p.id)).toEqual([sha(kept)])
    expect(existsSync(join(r.storage.dir, 'blobs', sha(gone)))).toBe(false)
    expect(existsSync(join(r.storage.dir, 'blobs', sha(kept)))).toBe(true)
  })

  test('erasing a task leaves none of its images behind, and keeps another task’s', async () => {
    const r = runtime()
    const mine = png(12),
      shared = png(13),
      theirs = png(14)
    r.storage.append('task-a', 1, screenshot(mine), Date.now())
    r.storage.append('task-a', 1, screenshot(shared), Date.now())
    r.storage.append('task-b', 1, screenshot(shared), Date.now())
    r.storage.append('task-b', 1, screenshot(theirs), Date.now())
    // A backup holds GC off while the deletion lands: erasure itself must remove the bytes.
    const lease = r.storage.acquireBlobLease('backup', 60_000)
    await r.applyTaskLifecycle('task-a', 'deleted', 2)
    expect(existsSync(join(r.storage.dir, 'blobs', sha(mine)))).toBe(true)
    lease.release()
    expect(await r.eraseTask('task-a', 2)).toMatchObject({ erased: true })
    expect(existsSync(join(r.storage.dir, 'blobs', sha(mine)))).toBe(false)
    expect(existsSync(join(r.storage.dir, 'blobs', sha(shared)))).toBe(true)
    expect(existsSync(join(r.storage.dir, 'blobs', sha(theirs)))).toBe(true)
  })

  test('backups carry event blobs; a restored archive serves them to its own conversation only', async () => {
    const r = runtime()
    const bytes = png(15)
    r.storage.append('task-a', 1, screenshot(bytes), 1)
    const backup = await r.backups.create('manual')
    const archive = await r.backups.restore(backup.id)
    const [archived] = (await r.backups.read(archive.id, 'task-a', -1, 10)).events
    expect(isChatBlobRef(refOf(archived.event))).toBe(true)
    // A pre-v13 archive (no blob_form column): its rows are raw, served escaped.
    const printed = {
      kind: 'tool-result',
      toolUseId: 'p',
      isError: false,
      rawContent: [
        { $chatBlob: { v: 1, sha256: 'b'.repeat(64), mediaType: 'image/png', size: 4 } }
      ],
      structured: null
    } as AgentEvent
    r.storage.compose((db) =>
      db
        .prepare('INSERT INTO events(conversation_id,seq,saved_at,event) VALUES(?,?,?,?)')
        .run('task-b', 0, 1, JSON.stringify(printed))
    )
    const legacyBackup = await r.backups.create('manual')
    const legacyArchive = await r.backups.restore(legacyBackup.id)
    const [legacy] = (await r.backups.read(legacyArchive.id, 'task-b', -1, 10)).events
    expect(isChatBlobRef((legacy.event as { rawContent: unknown[] }).rawContent[0])).toBe(false)
    expect(resolveChatBlobs(legacy.event, () => 'never')).toEqual(printed)
    const chunk = await r.backups.blob(archive.id, 'task-a', sha(bytes), 0)
    expect(Buffer.from(chunk.data, 'base64')).toEqual(bytes)
    await expect(r.backups.blob(archive.id, 'task-b', sha(bytes), 0)).rejects.toThrow()
  })
})

describe('readBlob operation', () => {
  test('a tab reads its own conversation’s blobs through the invoker; never another tab’s', async () => {
    const r = runtime()
    const bytes = png(16)
    r.storage.append('task-a', 1, screenshot(bytes), 1)
    const call = (id: string, tabId: string, hash: string) =>
      r.invoke({
        route: { id, epoch: 1 },
        target: 'ops',
        method: 'readBlob',
        args: [tabId, hash, 0]
      })
    const chunk = (await call('task-a', 'tab-task-a', sha(bytes))) as { data: string; size: number }
    expect(Buffer.from(chunk.data, 'base64')).toEqual(bytes)
    expect(chunk.size).toBe(bytes.length)
    await expect(call('task-a', 'tab-task-b', sha(bytes))).rejects.toThrow(/ownership/i)
    await expect(call('task-b', 'tab-task-b', sha(bytes))).rejects.toThrow(
      /not part of this conversation/i
    )
    await expect(call('task-a', 'tab-task-a', 'not-a-hash')).rejects.toThrow()
  })
})
