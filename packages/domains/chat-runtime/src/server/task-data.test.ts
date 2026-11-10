import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { z } from 'zod'
import { openChatStorage } from './storage'
import { createComputerTaskData, type DataImportKinds } from './task-data'

const roots: string[] = []
const stores: Array<ReturnType<typeof openChatStorage>> = []
function open() {
  const root = mkdtempSync(join(tmpdir(), 'slz-task-data-'))
  roots.push(root)
  const store = openChatStorage({ stateDir: root, hubScope: 'hub-a' })
  stores.push(store)
  return store
}
afterEach(() => {
  for (const store of stores.splice(0)) store.close()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** A kind like the real ones: keyed rows, the newer `at` wins. */
function probeKind(): DataImportKinds {
  return {
    probe: {
      value: z.object({ text: z.string(), at: z.number() }),
      apply(storage, item) {
        storage.compose((db) => {
          db.exec(
            'CREATE TABLE IF NOT EXISTS probe(key TEXT PRIMARY KEY, task_id TEXT, text TEXT, at INTEGER)'
          )
          db.prepare(
            `INSERT INTO probe VALUES(?,?,?,?) ON CONFLICT(key) DO UPDATE SET text=excluded.text, at=excluded.at
             WHERE excluded.at > probe.at`
          ).run(item.key, item.taskId, item.value.text, item.value.at)
        })
      }
    }
  }
}

describe('computer task data', () => {
  test('import applies valid items, skips deleted tasks, rejects invalid values; idempotent', () => {
    const storage = open()
    const data = createComputerTaskData({
      storage,
      computerId: 'pc',
      imports: probeKind(),
      providerConfig: () => ({})
    })
    storage.applyTaskLifecycle('gone', 'deleted', 1)
    const batch = {
      kind: 'probe',
      items: [
        { key: 'a', taskId: 't', value: { text: 'hub', at: 1 } },
        { key: 'b', taskId: 'gone', value: { text: 'x', at: 1 } },
        { key: 'c', taskId: 't', value: { text: 7 } }
      ]
    }
    const first = data.importBatch(batch)
    expect(first.applied).toEqual(['a'])
    expect(first.skipped).toEqual(['b'])
    expect(first.rejected.map((r) => r.key)).toEqual(['c'])
    // Delivered twice (ack lost): same answer, no duplicate.
    expect(data.importBatch(batch).applied).toEqual(['a'])
    // A newer local row is never overwritten by an older hub copy.
    storage.compose((db) => db.prepare("UPDATE probe SET text='local', at=5 WHERE key='a'").run())
    data.importBatch(batch)
    expect(storage.compose((db) => db.prepare('SELECT text FROM probe').all())).toEqual([
      { text: 'local' }
    ])
  })

  test('an unknown kind is rejected, never thrown', () => {
    const data = createComputerTaskData({
      storage: open(),
      computerId: 'pc',
      providerConfig: () => ({})
    })
    expect(
      data.importBatch({ kind: 'nope', items: [{ key: 'a', taskId: 't', value: 1 }] })
    ).toEqual({
      applied: [],
      skipped: [],
      rejected: [{ key: 'a', message: 'Unknown data kind: nope' }]
    })
  })

  test('describe names the computer, its store and the task lifecycle', () => {
    const storage = open()
    const data = createComputerTaskData({ storage, computerId: 'pc', providerConfig: () => ({}) })
    storage.applyTaskLifecycle('t', 'paused', 1)
    expect(data.read('t', { kind: 'describe' })).toEqual({
      computerId: 'pc',
      storeId: storage.storeId(),
      lifecycle: 'paused'
    })
    expect(() => data.read('t', { kind: 'nope' })).toThrow()
  })
})
