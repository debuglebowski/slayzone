/**
 * A task move's chat export (FU4 item 1). It used to freeze the chat, read and
 * resolve its WHOLE history (every image back inline), encode every line into one
 * buffer and write it — one synchronous block per chat, seconds for a 200 MB chat.
 * Now it streams the chat as of the freeze (a read snapshot) page by page to the
 * file, the event loop running between pages, and the bytes stay exactly what the
 * whole-chat encoding gave.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test, vi } from 'vitest'
import Database from 'better-sqlite3'
import type { AgentEvent } from '@slayzone/terminal-contracts'
import { openChatStorage, type ChatStorage } from './storage'
import { encodeTransfer, EXPORT_STEP_BYTES, writeExportTransfer } from './transfers'
import { createSessionMoves } from './session-moves'

const dirs: string[] = []
const stores: ChatStorage[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const s of stores.splice(0)) s.close()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  vi.useRealTimers()
})

const TASK = 'task-1'
function computer() {
  const root = mkdtempSync(join(tmpdir(), 'slz-move-export-'))
  dirs.push(root)
  const store = openChatStorage({ stateDir: root, hubScope: 'hub-a' })
  stores.push(store)
  return { root, store, moves: createSessionMoves(store) }
}
const png = (seed: number) =>
  Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(96 * 1024, seed)
  ]).toString('base64')
const screenshot = (a: string, b: string): AgentEvent => ({
  kind: 'tool-result',
  toolUseId: 't',
  isError: false,
  rawContent: [
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: a } },
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: b } }
  ],
  // A tool that PRINTED a reference-shaped object: escaped on save, raw again on export.
  structured: { printed: { $chatBlob: { v: 1, sha256: 'f'.repeat(64), mediaType: 'x', size: 1 } } }
})

/** A chat over 3 history pages (4 MiB each), with images (one repeated) and records. */
function bigChat(store: ChatStorage, id = 'c1') {
  store.createConversation({ id, taskId: TASK, tabId: `tab-${id}`, mode: 'claude-chat', epoch: 1 })
  const shared = png(1)
  for (let i = 0; i < 24; i++) {
    store.append(
      id,
      1,
      { kind: 'assistant-text', messageId: `m${i}`, text: `${i}:${'t'.repeat(600 * 1024)}` },
      1000 + 2 * i
    )
    store.append(id, 1, screenshot(shared, png(10 + i)), 1001 + 2 * i)
  }
  store.putRecord(id, 1, { kind: 'settings', id: 'note', value: { a: 1 }, at: 5 })
}

/** The whole-chat encoding the export must keep producing, byte for byte. */
function wholeEncoding(store: ChatStorage, id: string, migrationId: string) {
  store.freeze(id, 1, migrationId)
  try {
    return encodeTransfer(store.exportConversation(id, 1, migrationId), { move: true })
  } finally {
    store.unfreeze(id, 1, migrationId)
  }
}

function spinner() {
  let ticks = 0,
    on = true
  const spin = () => {
    ticks++
    if (on) setImmediate(spin)
  }
  setImmediate(spin)
  return {
    get ticks() {
      return ticks
    },
    stop: () => {
      on = false
    }
  }
}

test('the streamed file and manifest are byte-identical to the whole-chat encoding', async () => {
  const { store, moves } = computer()
  bigChat(store)
  const expected = wholeEncoding(store, 'c1', 'move:m1')
  const exported = await moves.exportTask('m1', TASK)
  expect(exported.transfers).toEqual([expected.manifest])
  const bytes = Buffer.from(moves.read('m1', 'c1', 0, expected.manifest.bytes + 10), 'base64')
  expect(bytes.equals(expected.bytes)).toBe(true)
})

test('the event loop runs while a chat is exported: a page at a time, never the whole chat', async () => {
  const { store, moves } = computer()
  bigChat(store)
  const spin = spinner()
  await moves.exportTask('m1', TASK)
  spin.stop()
  // 3+ history pages, plus the images resolved back inline: many turns.
  expect(spin.ticks).toBeGreaterThanOrEqual(4)
})

test('the export holds a read snapshot (visible, with a blob lease) only while it runs', async () => {
  const { store, moves } = computer()
  bigChat(store)
  expect(store.hasExportReaders()).toBe(false)
  const running = moves.exportTask('m1', TASK)
  await new Promise<void>((r) => setImmediate(r))
  expect(store.hasExportReaders()).toBe(true)
  // Blob GC skips while a lease is held: the snapshot's images stay readable.
  expect(store.hasBlobLeases()).toBe(true)
  await running
  expect(store.hasExportReaders()).toBe(false)
  expect(store.hasBlobLeases()).toBe(false)
})

test('the chat stays writable while it is exported; the export is the chat as of its start', async () => {
  const { store, moves } = computer()
  bigChat(store)
  const expected = wholeEncoding(store, 'c1', 'move:m1')
  const running = moves.exportTask('m1', TASK)
  await new Promise<void>((r) => setImmediate(r))
  // A live agent's event: never refused (a frozen chat refuses writes).
  expect(() =>
    store.append('c1', 1, { kind: 'assistant-text', messageId: 'late', text: 'late' }, 9999)
  ).not.toThrow()
  const exported = await running
  expect(exported.transfers).toEqual([expected.manifest])
  expect(store.conversation('c1')?.state).toBe('active')
})

test('the same move asked twice at once: one export, one answer', async () => {
  const { store, moves } = computer()
  bigChat(store)
  const freeze = vi.spyOn(store, 'freeze')
  const [a, b] = await Promise.all([moves.exportTask('m1', TASK), moves.exportTask('m1', TASK)])
  expect(b).toEqual(a)
  expect(freeze).toHaveBeenCalledTimes(1)
})

test('the store closing mid-export: the export fails and its snapshot is closed', async () => {
  const { store, moves } = computer()
  bigChat(store)
  const running = moves.exportTask('m1', TASK)
  await new Promise<void>((r) => setImmediate(r))
  expect(store.hasExportReaders()).toBe(true)
  store.close()
  await expect(running).rejects.toThrow()
  expect(store.hasExportReaders()).toBe(false)
})

test.each(['whole', 'streamed'] as const)(
  '%s export excludes large derived bodies in SQL, before even selecting their values',
  async (mode) => {
    const { store, moves } = computer()
    store.createConversation({
      id: 'c1',
      taskId: TASK,
      tabId: 'tab',
      mode: 'claude-chat',
      epoch: 1
    })
    store.putRecord('c1', 1, { kind: 'settings', id: 'keep', value: { text: 'retained' }, at: 1 })
    store.compose((db) => {
      const put = db.prepare('INSERT INTO records VALUES(?,?,?,?,?)')
      const page = JSON.stringify({ rows: 'x'.repeat(1024 * 1024) })
      db.transaction(() => {
        for (let i = 0; i < 32; i++) put.run('c1', 'timeline', `page:${i}`, page, 1)
        put.run('c1', 'event-blob', 'pin', '{}', 1)
      })()
    })
    const expected = wholeEncoding(store, 'c1', 'move:m1')
    // A native SQLite tripwire: merely selecting an excluded value fails, even
    // if JS would filter before parsing. Counts/key-only reads remain valid.
    store.compose((db) =>
      db.exec(`
      ALTER TABLE records RENAME TO export_test_records;
      CREATE VIEW records AS SELECT conversation_id,kind,id,
        CASE WHEN kind IN ('timeline','event-blob') THEN json('excluded body selected')
          ELSE value END AS value,saved_at FROM export_test_records;
    `)
    )
    if (mode === 'whole') {
      const actual = wholeEncoding(store, 'c1', 'move:m1')
      expect(actual.bytes.equals(expected.bytes)).toBe(true)
    } else {
      const actual = await moves.exportTask('m1', TASK)
      expect(actual.transfers).toEqual([expected.manifest])
      expect(Buffer.from(moves.read('m1', 'c1', 0, expected.manifest.bytes), 'base64')).toEqual(
        expected.bytes
      )
    }
  }
)

test.each(['reads', 'writes'] as const)(
  'retained records and receipts: bounded %s from the original live snapshot',
  async (check) => {
    const { root, store } = computer()
    store.createConversation({
      id: 'c1',
      taskId: TASK,
      tabId: 'tab',
      mode: 'claude-chat',
      epoch: 1
    })
    const marker = 'EXPORT-RETAINED:'
    // Multibyte text: stored/encoded bytes, not JS string lengths, bound each step.
    const value = { text: marker + 'µ'.repeat(300 * 1024) }
    for (let i = 0; i < 11; i++) {
      store.putRecord('c1', 1, {
        kind: i < 5 ? 'settings' : 'workspace',
        id: `r${i < 5 ? i : i - 5}`,
        value,
        at: i
      })
      store.acceptCommand('c1', 1, `receipt${i}`, { i })
      store.completeCommand('c1', 1, `receipt${i}`, value)
    }
    const expected = wholeEncoding(store, 'c1', 'move:m1')
    let tick = 0
    const parsed = new Map<number, number>()
    const parse = JSON.parse
    vi.spyOn(JSON, 'parse').mockImplementation((text, reviver) => {
      if (text.includes(marker)) parsed.set(tick, (parsed.get(tick) ?? 0) + Buffer.byteLength(text))
      return parse(text, reviver)
    })
    store.freeze('c1', 1, 'move:m1')
    const reader = store.openExportReader('c1', 1, 'move:m1')
    store.unfreeze('c1', 1, 'move:m1')
    const path = join(root, 'export.data')
    const written: number[] = []
    let last = 0,
      spinning = true
    const sample = () => {
      const file = existsSync(`${path}.tmp`) ? `${path}.tmp` : path
      const bytes = existsSync(file) ? statSync(file).size : 0
      written.push(bytes - last)
      last = bytes
    }
    const spin = () => {
      sample()
      tick++
      if (spinning) setImmediate(spin)
    }
    try {
      if (check === 'reads')
        expect(parsed.size, 'opening a frozen snapshot must not parse any retained bodies').toBe(0)
      parsed.clear()
      setImmediate(spin)
      const running = writeExportTransfer(reader, path, { move: true })
      await new Promise<void>((resolve) => setImmediate(resolve))
      // Mutate records not yet loaded and receipts not yet written. The reader must
      // keep its original WAL snapshot, including the original counts and order.
      store.removeRecord('c1', 1, 'workspace', 'r4')
      store.putRecord('c1', 1, { kind: 'settings', id: 'late', value: { text: 'late' }, at: 99 })
      store.completeCommand('c1', 1, 'receipt9', { text: 'changed' })
      store.acceptCommand('c1', 1, 'late-receipt', {})
      expect(await running).toEqual(expected.manifest)
      sample()
      expect(readFileSync(path).equals(expected.bytes)).toBe(true)
      expect(Math.max(...written)).toBeLessThanOrEqual(EXPORT_STEP_BYTES)
      expect(tick).toBeGreaterThanOrEqual(4)
      expect(Math.max(...parsed.values())).toBeLessThanOrEqual(EXPORT_STEP_BYTES)
    } finally {
      spinning = false
      reader.close()
    }
  }
)

test('an individual event, retained record or receipt above the budget is preserved whole', async () => {
  const { store, moves } = computer()
  store.createConversation({ id: 'c1', taskId: TASK, tabId: 'tab', mode: 'claude-chat', epoch: 1 })
  const text = 'x'.repeat(EXPORT_STEP_BYTES + 1)
  store.append('c1', 1, { kind: 'assistant-text', messageId: 'large', text }, 1)
  store.putRecord('c1', 1, { kind: 'settings', id: 'large', value: { text }, at: 1 })
  store.acceptCommand('c1', 1, 'large', {})
  store.completeCommand('c1', 1, 'large', { text })
  const expected = wholeEncoding(store, 'c1', 'move:m1')
  const actual = await moves.exportTask('m1', TASK)
  expect(actual.transfers).toEqual([expected.manifest])
  expect(
    Buffer.from(moves.read('m1', 'c1', 0, expected.manifest.bytes), 'base64').equals(expected.bytes)
  ).toBe(true)
})

test('failed initialization after acquiring a blob lease closes the connection and leaves no renewal', () => {
  const { store } = computer()
  store.createConversation({ id: 'c1', taskId: TASK, tabId: 'tab', mode: 'claude-chat', epoch: 1 })
  store.freeze('c1', 1, 'move:m1')
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
  const acquire = vi.spyOn(store, 'acquireBlobLease')
  let connection: Database.Database | undefined
  const prepare = Database.prototype.prepare
  vi.spyOn(Database.prototype, 'prepare').mockImplementation(function (
    this: Database.Database,
    sql
  ) {
    if (this.readonly) {
      connection = this
      if (sql.includes('COUNT(*) AS n FROM events')) throw new Error('export initialization fault')
    }
    return prepare.call(this, sql)
  })
  expect(() => store.openExportReader('c1', 1, 'move:m1')).toThrow('export initialization fault')
  expect(acquire).toHaveBeenCalledTimes(1)
  expect(store.hasExportReaders()).toBe(false)
  expect(store.hasBlobLeases()).toBe(false)
  expect(connection?.open).toBe(false)
  expect(vi.getTimerCount()).toBe(0)
  vi.advanceTimersByTime(120_000)
  expect(acquire).toHaveBeenCalledTimes(1)
  store.unfreeze('c1', 1, 'move:m1')
})

test('an actual SQLite unfreeze failure closes the acquired snapshot, lease and renewal', async () => {
  const { store, moves } = computer()
  store.createConversation({ id: 'c1', taskId: TASK, tabId: 'tab', mode: 'claude-chat', epoch: 1 })
  store.append('c1', 1, { kind: 'assistant-text', messageId: 'old', text: 'preserved history' }, 1)
  store.compose((db) =>
    db.exec(`CREATE TRIGGER fail_export_unfreeze BEFORE UPDATE ON conversations
    WHEN OLD.state='frozen' AND NEW.state='active' BEGIN SELECT RAISE(ABORT,'simulated unfreeze write failure'); END`)
  )
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
  const acquire = vi.spyOn(store, 'acquireBlobLease')
  let connection: Database.Database | undefined
  const prepare = Database.prototype.prepare
  vi.spyOn(Database.prototype, 'prepare').mockImplementation(function (
    this: Database.Database,
    sql
  ) {
    if (this.readonly) connection = this
    return prepare.call(this, sql)
  })
  await expect(moves.exportTask('m1', TASK)).rejects.toThrow('simulated unfreeze write failure')
  expect(store.conversation('c1')?.state).toBe('frozen')
  store.compose((db) => db.exec('DROP TRIGGER fail_export_unfreeze'))
  store.unfreeze('c1', 1, 'move:m1')
  expect(store.hasExportReaders()).toBe(false)
  expect(store.hasBlobLeases()).toBe(false)
  expect(connection?.open).toBe(false)
  expect(vi.getTimerCount()).toBe(0)
  vi.advanceTimersByTime(120_000)
  expect(acquire).toHaveBeenCalledTimes(1)
  expect(store.read('c1', -1)[0].event).toMatchObject({ text: 'preserved history' })
})

test('unfreeze SQLite error remains primary even if closing the acquired snapshot also fails', async () => {
  const { store, moves } = computer()
  store.createConversation({ id: 'c1', taskId: TASK, tabId: 'tab', mode: 'claude-chat', epoch: 1 })
  store.compose((db) =>
    db.exec(`CREATE TRIGGER fail_export_unfreeze BEFORE UPDATE ON conversations
    WHEN OLD.state='frozen' AND NEW.state='active' BEGIN SELECT RAISE(ABORT,'primary unfreeze failure'); END`)
  )
  const open = store.openExportReader.bind(store)
  vi.spyOn(store, 'openExportReader').mockImplementation((...args) => {
    const reader = open(...args)
    const close = reader.close
    reader.close = () => {
      close()
      throw new Error('secondary close failure')
    }
    return reader
  })
  const error = vi.spyOn(console, 'error').mockImplementation(() => {})
  await expect(moves.exportTask('m1', TASK)).rejects.toThrow('primary unfreeze failure')
  expect(error).toHaveBeenCalledWith(
    '[session-moves] closing failed export snapshot:',
    expect.objectContaining({ message: 'secondary close failure' })
  )
  expect(store.hasExportReaders()).toBe(false)
  expect(store.hasBlobLeases()).toBe(false)
  store.compose((db) => db.exec('DROP TRIGGER fail_export_unfreeze'))
  store.unfreeze('c1', 1, 'move:m1')
})

test('a retained body failing during export closes its reader, blob lease and renewal', async () => {
  const { store, moves } = computer()
  store.createConversation({ id: 'c1', taskId: TASK, tabId: 'tab', mode: 'claude-chat', epoch: 1 })
  store.compose((db) =>
    db
      .prepare('INSERT INTO records VALUES(?,?,?,?,?)')
      .run('c1', 'settings', 'corrupt', 'invalid retained JSON', 1)
  )
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
  await expect(moves.exportTask('m1', TASK)).rejects.toThrow()
  expect(store.hasExportReaders()).toBe(false)
  expect(store.hasBlobLeases()).toBe(false)
  expect(vi.getTimerCount()).toBe(0)
  expect(store.conversation('c1')?.state).toBe('active')
})

test('each simultaneous export reader owns its own blob lease and renewal', () => {
  const { store } = computer()
  store.createConversation({ id: 'c1', taskId: TASK, tabId: 'tab', mode: 'claude-chat', epoch: 1 })
  store.freeze('c1', 1, 'move:m1')
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
  const a = store.openExportReader('c1', 1, 'move:m1')
  const b = store.openExportReader('c1', 1, 'move:m1')
  store.unfreeze('c1', 1, 'move:m1')
  a.close()
  a.close()
  expect(store.hasExportReaders()).toBe(true)
  expect(store.hasBlobLeases()).toBe(true)
  expect(vi.getTimerCount()).toBe(1)
  b.close()
  expect(store.hasExportReaders()).toBe(false)
  expect(store.hasBlobLeases()).toBe(false)
  expect(vi.getTimerCount()).toBe(0)
})
