import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { openChatStorage } from './storage'
import { createChatTransfers, encodeTransfer } from './transfers'
const dirs: string[] = [],
  stores: Array<ReturnType<typeof openChatStorage>> = []
afterEach(() => {
  for (const s of stores.splice(0)) s.close()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
function open(root = mkdtempSync(join(tmpdir(), 'slz-chat-transfer-'))) {
  if (!dirs.includes(root)) dirs.push(root)
  const s = openChatStorage({ stateDir: root, hubScope: 'hub' })
  stores.push(s)
  return { s, root, t: createChatTransfers(s) }
}
const identity = { id: 'c', taskId: 't', tabId: 'tab', mode: 'claude-chat', epoch: 1 }
function payload() {
  return encodeTransfer({
    version: 1,
    migrationId: 'move',
    identity,
    events: [
      {
        seq: 8,
        at: 123,
        event: { kind: 'assistant-text', messageId: 'm', text: 'private history' }
      }
    ],
    records: [],
    receipts: [],
    hash: 'unused'
  })
}
test('transfer resumes after restart and duplicate chunks do not duplicate history', () => {
  const a = open(),
    p = payload(),
    start = a.t.begin(p.manifest)
  const split = Math.floor(p.bytes.length / 2)
  a.t.chunk(start.id, 0, p.bytes.subarray(0, split))
  a.s.close()
  const b = open(a.root),
    resumed = b.t.begin(p.manifest)
  expect(resumed.offset).toBe(split)
  b.t.chunk(start.id, 0, p.bytes.subarray(0, split))
  b.t.chunk(start.id, split, p.bytes.subarray(split))
  b.t.finish(start.id)
  expect(b.s.conversation('c')).toMatchObject({ state: 'prepared', identity: { epoch: 2 } })
  b.s.activate('c', 'move', 2, p.manifest.hash)
  expect(b.s.read('c', -1)).toHaveLength(1)
  expect(b.s.read('c', -1)[0]).toMatchObject({ seq: 8, at: 123 })
})
test('corrupt transfer never creates a usable conversation', () => {
  const { s, t } = open(),
    p = payload(),
    start = t.begin(p.manifest),
    bad = Buffer.from(p.bytes)
  bad[bad.length - 3] ^= 1
  t.chunk(start.id, 0, bad)
  expect(() => t.finish(start.id)).toThrow(/integrity|hash|JSON/i)
  expect(s.conversation('c')).toBeNull()
})

test('activated transfers discard duplicate content while finish retries keep their proof', async () => {
  const { existsSync } = await import('node:fs')
  const { s, t } = open(),
    p = payload(),
    start = t.begin(p.manifest)
  t.chunk(start.id, 0, p.bytes)
  const proof = t.finish(start.id)
  t.collectActivated()
  const path = join(s.dir, 'transfers', start.id + '.data')
  expect(existsSync(path)).toBe(true)
  s.activate('c', 'move', 2, p.manifest.hash)
  t.collectActivated()
  expect(existsSync(path)).toBe(false)
  expect(t.finish(start.id)).toEqual(proof)
})

test('damaged staging metadata cannot block cleanup of other live conversations', async () => {
  const { writeFileSync } = await import('node:fs')
  const { s, t } = open()
  writeFileSync(join(s.dir, 'transfers', 'c'.repeat(64) + '.json'), '{}')
  expect(() => t.collectActivated()).not.toThrow()
})
