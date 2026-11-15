/**
 * A task move's chat export (FU4 item 1). It used to freeze the chat, read and
 * resolve its WHOLE history (every image back inline), encode every line into one
 * buffer and write it — one synchronous block per chat, seconds for a 200 MB chat.
 * Now it streams the chat as of the freeze (a read snapshot) page by page to the
 * file, the event loop running between pages, and the bytes stay exactly what the
 * whole-chat encoding gave.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test, vi } from 'vitest'
import type { AgentEvent } from '@slayzone/terminal-contracts'
import { openChatStorage, type ChatStorage } from './storage'
import { encodeTransfer } from './transfers'
import { createSessionMoves } from './session-moves'

const dirs: string[] = []
const stores: ChatStorage[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const s of stores.splice(0)) s.close()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const TASK = 'task-1'
function computer() {
  const root = mkdtempSync(join(tmpdir(), 'slz-move-export-'))
  dirs.push(root)
  const store = openChatStorage({ stateDir: root, hubScope: 'hub-a' })
  stores.push(store)
  return { store, moves: createSessionMoves(store) }
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
