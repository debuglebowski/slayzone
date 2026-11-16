/**
 * Storage compaction (fu-2): a user-started rebuild (`VACUUM INTO` in a worker, writes
 * captured and replayed, swapped in) that switches the store to incremental
 * auto-vacuum; then short reclaim slices — automatic on stores already switched.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { createComputerChatRuntime } from './computer-runtime'
import { openChatStorage, type ChatStorage } from './storage'
import {
  rebuildStoreFile,
  createStorageCompaction,
  type StorageCompactionOptions,
  type StorageCompaction
} from './storage-compaction'

const roots: string[] = []
const stores: ChatStorage[] = []
const services: StorageCompaction[] = []
const runtimes: Array<ReturnType<typeof createComputerChatRuntime>> = []
afterEach(async () => {
  vi.restoreAllMocks()
  syncBuiltinESMExports()
  for (const r of runtimes.splice(0)) await r.close()
  for (const s of services.splice(0)) await s.close()
  for (const s of stores.splice(0)) s.close()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
const MiB = 1024 * 1024
const identity = { id: 'conv-a', taskId: 'task-a', tabId: 'tab-a', mode: 'claude-chat', epoch: 1 }
const text = (t: string) => ({ kind: 'assistant-text', messageId: t, text: t }) as const

function open(root = mkdtempSync(join(tmpdir(), 'slz-chat-compact-'))) {
  if (!roots.includes(root)) roots.push(root)
  const store = openChatStorage({ stateDir: root, hubScope: 'hub-a' })
  stores.push(store)
  return { store, root }
}
/** A store with ~`liveMb` of history and ~`freeMb` of free pages (deleted big events). */
function seeded(liveMb = 4, freeMb = 16) {
  const { store, root } = open()
  store.createConversation(identity)
  const big = 'b'.repeat(100_000)
  store.transaction(() => {
    for (let i = 0; i < freeMb * 10; i++) store.append(identity.id, 1, text(`gone ${i} ${big}`))
    for (let i = 0; i < liveMb * 10; i++) store.append(identity.id, 1, text(`kept ${i} ${big}`))
  })
  store.compose((db) => db.prepare("DELETE FROM events WHERE event LIKE '%gone %'").run())
  // Tables a real store has: no primary key; AUTOINCREMENT (sqlite_sequence).
  store.compose((db) =>
    db.exec(`CREATE TABLE IF NOT EXISTS test_nopk(v TEXT);
      CREATE TABLE IF NOT EXISTS test_auto(id INTEGER PRIMARY KEY AUTOINCREMENT, v TEXT);
      INSERT INTO test_nopk VALUES('a'); INSERT INTO test_auto(v) VALUES('a');`)
  )
  checkpointHere(store)
  return { store, root }
}
function compaction(store: ChatStorage, opts: Partial<StorageCompactionOptions> = {}) {
  const c = createStorageCompaction({
    storage: store,
    backfillDone: () => true,
    automaticReclaim: false,
    log: (l: string) => console.log(l),
    ...opts
  })
  services.push(c)
  return c
}
/** Every table's rows and the schema, hashed: equal = same content. */
function fingerprint(store: ChatStorage): string {
  return store.compose((db: Database.Database) => {
    const hash = createHash('sha256')
    const schema = db
      .prepare(
        "SELECT type,name,tbl_name,sql FROM main.sqlite_master WHERE name NOT LIKE 'sqlite_autoindex%' ORDER BY type,name"
      )
      .all()
    hash.update(JSON.stringify(schema))
    for (const { name } of db
      .prepare("SELECT name FROM main.sqlite_master WHERE type='table' ORDER BY name")
      .all() as Array<{ name: string }>) {
      const cols = (db.pragma(`main.table_info("${name}")`) as Array<{ name: string }>).length
      const order = Array.from({ length: cols }, (_, i) => i + 1).join(',')
      // The job's own result row is written after the swap.
      const where =
        name === 'maintenance_cursors' ? " WHERE id <> 'storage-compaction-v1:last'" : ''
      const rows = db
        .prepare(`SELECT * FROM main."${name}"${where} ORDER BY ${order}`)
        .raw(true)
        .all()
      hash.update(
        `${name}:${JSON.stringify(rows, (_k, v) => (typeof v === 'bigint' ? `${v}n` : v))}`
      )
    }
    return hash.digest('hex')
  })
}
const leftovers = (store: ChatStorage) =>
  readdirSync(store.dir).filter((n) => n.startsWith('chat.sqlite.'))

describe('rebuild', () => {
  test('cancelled native copy cleanup failure retains cause; verified retry removes every abandoned secret copy', async () => {
    const { store } = seeded(0, 1)
    store.append(identity.id, 1, text('abandoned cancelled secret'))
    const original = fs.rmSync
    const failure = Object.assign(new Error('copy unlink refused'), { code: 'EACCES' })
    let refuse = true
    const spy = vi.spyOn(fs, 'rmSync').mockImplementation((path, options) => {
      if (refuse && String(path).startsWith(`${store.path}.compact-`)) throw failure
      return original(path, options)
    })
    syncBuiltinESMExports()
    let cancel = true
    const c = compaction(store, {
      onPhase(phase) {
        if (phase === 'copied' && cancel) c.cancel()
      }
    })
    try {
      c.start()
      await c.idle()
      expect(c.status().job?.phase).toBe('failed')
      expect(leftovers(store).length).toBeGreaterThan(0)
      store.compose((db) =>
        db.prepare("DELETE FROM events WHERE event LIKE '%abandoned cancelled secret%'").run()
      )
      cancel = false
      await expect(c.rebuildForErasure()).rejects.toMatchObject({
        errors: expect.arrayContaining([failure])
      })
      refuse = false
      await c.rebuildForErasure()
      expect(leftovers(store)).toEqual([])
      expect(readFileSync(store.path).includes(Buffer.from('abandoned cancelled secret'))).toBe(
        false
      )
    } finally {
      refuse = false
      spy.mockRestore()
      syncBuiltinESMExports()
    }
  })

  test.each(['closed', 'linked', 'renamed'] as const)(
    'failed %s window then retry conserves exact derived schema/rows/stateVersion',
    async (boundary) => {
      const { store } = seeded(0, 1)
      await store.writeTimeline(identity.id, 1, {
        dropPagesFrom: null,
        pages: [
          { page: 0, value: '{"rows":[]}', summary: '{"kept":true}', searchText: 'kept search' }
        ],
        checkpoint: '{"seq":0}'
      })
      let armed = true
      let expected = ''
      let version = 0
      let schema: unknown
      const c = compaction(store, {
        onPhase(phase) {
          if (phase === 'copied') {
            store.append(identity.id, 1, { kind: 'user-message', text: `window ${armed}` })
            store.putRecord(identity.id, 1, {
              kind: 'timeline',
              id: 'page:0',
              value: { rows: [], armed },
              at: 1
            })
            store.compose((db) =>
              db
                .prepare('INSERT INTO timeline_page_metadata VALUES(?,?,?,?)')
                .run(identity.id, 'page:0', '{"kept":true}', 'kept search')
            )
          }
          if (phase === 'verified') {
            expected = fingerprint(store)
            version = store.stateVersion(identity.taskId)
            schema = store.compose((db) =>
              db
                .prepare('SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name')
                .all()
            )
          }
          if (phase === boundary && armed) {
            armed = false
            throw new Error(`failed ${boundary} window`)
          }
        }
      })
      c.start()
      await c.idle()
      expect(c.status().job).toMatchObject({
        phase: 'failed',
        message: expect.stringContaining(`failed ${boundary} window`)
      })
      expect(fingerprint(store)).toBe(expected)
      expect(store.stateVersion(identity.taskId)).toBe(version)
      c.start()
      await c.idle()
      expect(c.status().job?.phase).toBe('done')
      expect(fingerprint(store)).toBe(expected)
      expect(store.stateVersion(identity.taskId)).toBe(version)
      expect(
        store.compose((db) =>
          db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name').all()
        )
      ).toEqual(schema)
      expect(
        store.compose((db) => db.prepare('SELECT count(*) n FROM timeline_page_metadata').get())
      ).toEqual({ n: 1 })
      expect(
        store.compose((db) => db.prepare('SELECT count(*) n FROM event_markers').get())
      ).toEqual({ n: 2 })
    }
  )

  test.each([false, true])(
    'native BUSY retry preserves exact schema and derived data (worker resume: %s)',
    async (resume) => {
      const { store } = seeded(0, 1)
      const epoch = store.maintenance.connectionEpoch()
      let iterator: IterableIterator<unknown> | undefined
      let refusals = 0
      let expected = ''
      let schema: unknown
      const write = (n: number) => {
        store.append(identity.id, 1, { kind: 'user-message', text: `prompt ${n}` })
        store.putRecord(identity.id, 1, { kind: 'timeline', id: `page:${n}`, value: { n }, at: n })
        store.compose((db) =>
          db
            .prepare('INSERT OR REPLACE INTO timeline_page_metadata VALUES(?,?,?,?)')
            .run(identity.id, `page:${n}`, '{}', `search ${n}`)
        )
      }
      const c = compaction(store, {
        finalKeys: resume ? 4 : 256,
        idleMs: 1,
        onPhase(phase) {
          if (phase === 'copied') write(0)
          if (phase === 'verified') {
            expected = fingerprint(store)
            schema = store.compose((db) =>
              db
                .prepare('SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name')
                .all()
            )
          }
          if (phase === 'verified' && refusals === 0 && !iterator) {
            iterator = store.compose((db) => db.prepare('SELECT * FROM events').iterate())
            iterator.next()
          }
          if (phase === 'waiting' && iterator) {
            expect(store.maintenance.connectionEpoch()).toBe(epoch)
            iterator.return?.()
            iterator = undefined
            refusals++
            for (let n = 1; n <= (resume ? 8 : 1); n++) write(n)
          }
        }
      })
      try {
        c.start()
        await c.idle()
      } finally {
        iterator?.return?.()
      }
      expect(refusals).toBe(1)
      expect(c.status().job).toMatchObject({ phase: 'done' })
      expect(store.maintenance.connectionEpoch()).toBe(epoch + 1)
      expect(
        store.compose((db) =>
          db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name').all()
        )
      ).toEqual(schema)
      expect(fingerprint(store)).toBe(expected)
      expect(
        store.compose((db) => db.prepare('SELECT count(*) n FROM event_markers').get())
      ).toEqual({ n: resume ? 9 : 2 })
      expect(
        store.compose((db) => db.prepare('SELECT count(*) n FROM timeline_page_metadata').get())
      ).toEqual({ n: resume ? 9 : 2 })
      expect(leftovers(store)).toEqual([])
    }
  )

  test('returns the free pages, switches to incremental, keeps every row and trigger', async () => {
    const { store } = seeded()
    await store.maintenance.pauseCheckpointer()
    try {
      checkpointHere(store)
    } finally {
      store.maintenance.resumeCheckpointer()
    }
    const before = fingerprint(store)
    const sizeBefore = statSync(store.path).size
    const c = compaction(store)
    const status = c.status()
    expect(status.autoVacuum).toBe('none')
    expect(status.reclaimableBytes).toBeGreaterThan(10 * MiB)

    const job = c.start()
    expect(job.kind).toBe('rebuild')
    await c.idle()

    const done = c.status()
    expect(done.job?.phase).toBe('done')
    expect(done.autoVacuum).toBe('incremental')
    expect(done.reclaimableBytes).toBe(0)
    expect(statSync(store.path).size).toBeLessThan(sizeBefore - 10 * MiB)
    expect(fingerprint(store)).toBe(before)
    expect(done.last).toMatchObject({ kind: 'rebuild', beforeBytes: sizeBefore })
    expect(done.last?.holdMs).toBeGreaterThanOrEqual(0)
    expect(store.compose((db) => db.pragma('quick_check', { simple: true }))).toBe('ok')
    // persistent triggers survived and fire
    const version = () =>
      store.compose((db) =>
        db.prepare('SELECT * FROM task_state_versions WHERE task_id=?').get(identity.taskId)
      )
    const v0 = version()
    store.putRecord(identity.id, 1, { kind: 'settings', id: 'x', value: 1, at: 1 })
    expect(version()).not.toEqual(v0)
    expect(leftovers(store)).toEqual([])
  })

  test('no write is lost: writes during copy, catch-up and right before the window', async () => {
    const { store } = seeded()
    let n = 0
    const write = () => {
      n++
      store.append(identity.id, 1, text(`live ${n}`))
      store.putRecord(identity.id, 1, { kind: 'settings', id: `r${n % 3}`, value: n, at: n })
      store.compose((db) => {
        db.prepare('INSERT INTO test_nopk VALUES(?)').run(`v${n}`)
        db.prepare('INSERT INTO test_auto(v) VALUES(?)').run(`v${n}`)
        db.prepare("DELETE FROM test_auto WHERE v='a'").run()
        db.prepare('DELETE FROM events WHERE conversation_id=? AND seq=?').run(identity.id, n)
      })
    }
    const timer = setInterval(write, 2)
    let atSwap = ''
    const c = compaction(store, {
      onPhase: (phase) => {
        if (phase === 'copied' || phase === 'round' || phase === 'window') write()
        // inside the swap, after the final delta, before the live file closes
        if (phase === 'verified') atSwap = fingerprint(store)
      }
    })
    c.start()
    await c.idle()
    clearInterval(timer)
    expect(c.status().job?.phase).toBe('done')
    expect(atSwap).not.toBe('')
    expect(fingerprint(store)).toBe(atSwap)
    expect(n).toBeGreaterThan(3)
    const appended = store
      .read(identity.id, -1)
      .filter((e) => /^live /.test((e.event as { text: string }).text))
    expect(appended).toHaveLength(n)
  })

  test('a delta over the budget gets more catch-up rounds; the hold stays bounded', async () => {
    const { store } = seeded()
    let rounds = 0
    let forced = 0
    const c = compaction(store, {
      finalKeys: 4,
      onPhase: (phase) => {
        if (phase === 'round') rounds++
        // a burst before each budget check, three times
        if (phase === 'budget' && forced++ < 3)
          for (let i = 0; i < 10; i++) store.append(identity.id, 1, text(`burst ${forced} ${i}`))
      }
    })
    c.start()
    await c.idle()
    expect(c.status().job?.phase).toBe('done')
    expect(rounds).toBeGreaterThanOrEqual(3)
    expect(c.status().job?.result?.holdMs).toBeLessThan(1000)
    expect(
      store.read(identity.id, -1).filter((e) => /^burst /.test((e.event as { text: string }).text))
    ).toHaveLength(30)
  })

  test('a write storm that never fits the budget fails cleanly; the live store is untouched', async () => {
    const { store } = seeded()
    const c = compaction(store, {
      finalKeys: 1,
      maxRounds: 2,
      onPhase: (phase) => {
        if (phase === 'budget')
          for (let i = 0; i < 5; i++) store.append(identity.id, 1, text(`storm ${i}`))
      }
    })
    c.start()
    await c.idle()
    const status = c.status()
    expect(status.job?.phase).toBe('failed')
    expect(status.job?.message).toMatch(/busy/i)
    expect(status.autoVacuum).toBe('none')
    expect(leftovers(store)).toEqual([])
    store.append(identity.id, 1, text('still writable'))
  })

  test('the event loop keeps running (no gap near the 1 s stall threshold)', async () => {
    const { store } = seeded(8, 32)
    let last = performance.now(),
      worst = 0
    const timer = setInterval(() => {
      const now = performance.now()
      worst = Math.max(worst, now - last)
      last = now
    }, 10)
    const c = compaction(store)
    c.start()
    await c.idle()
    clearInterval(timer)
    expect(c.status().job?.phase).toBe('done')
    expect(worst).toBeLessThan(1000)
  })

  test('the copy is written in throttled batches: fsync and a pause every few MiB, progress shown', async () => {
    const { store } = seeded(8, 16)
    const progress: number[] = []
    let syncs = 0
    const c = compaction(store, {
      copyBatchBytes: 256 * 1024,
      copySyncBytes: 1024 * 1024,
      copyPauseMs: 1,
      onPhase: (phase) => {
        if (phase === 'copy-synced') {
          syncs++
          progress.push(c.status().job?.progress ?? -1)
        }
      }
    })
    c.start()
    await c.idle()
    expect(c.status().job?.phase).toBe('done')
    // ~8 MiB live → at least 6 synced batches of 1 MiB
    expect(syncs).toBeGreaterThanOrEqual(6)
    expect(progress.at(-1)).toBeGreaterThan(progress[0])
    expect(progress.every((p) => p > 0 && p <= 0.85)).toBe(true)
  })

  test('waits while a backup lease or a secondary connection is held, then swaps', async () => {
    const { store } = seeded()
    const lease = store.acquireBlobLease('backup-1', 60_000)
    const reader = store.maintenance.registerSecondary('export reader')
    let waited = 0
    const c = compaction(store, {
      idleMs: 5,
      onPhase: (phase) => {
        if (phase !== 'waiting') return
        waited++
        if (waited === 3) lease.release()
        if (waited === 6) reader.release()
      }
    })
    c.start()
    await c.idle()
    expect(waited).toBeGreaterThanOrEqual(6)
    expect(c.status().job?.phase).toBe('done')
    expect(c.status().autoVacuum).toBe('incremental')
  })
})

describe('refusals and stops', () => {
  test('refused while the image backfill still runs', () => {
    const { store } = seeded()
    const c = compaction(store, { backfillDone: () => false })
    expect(c.status().backfillDone).toBe(false)
    expect(() => c.start()).toThrow(/backfill/i)
    expect(c.status().job).toBeNull()
  })

  test('refused when the disk is short; nothing is written', () => {
    const { store } = seeded()
    const c = compaction(store, { freeBytes: () => 1 * MiB })
    expect(c.status().requiredDiskBytes).toBeGreaterThan(1 * MiB)
    expect(() => c.start()).toThrow(/disk/i)
    expect(leftovers(store)).toEqual([])
  })

  test('one job at a time', async () => {
    const { store } = seeded()
    const c = compaction(store)
    c.start()
    expect(() => c.start()).toThrow(/already/i)
    await c.idle()
  })

  test('cancel stops it, removes the copy, keeps the live store', async () => {
    const { store } = seeded()
    const before = fingerprint(store)
    const c = compaction(store, { onPhase: (p) => p === 'copied' && c.cancel() })
    c.start()
    await c.idle()
    expect(c.status().job?.phase).toBe('cancelled')
    expect(c.status().autoVacuum).toBe('none')
    expect(fingerprint(store)).toBe(before)
    expect(leftovers(store)).toEqual([])
  })

  test('abort (content erasure) stops it with its reason', async () => {
    const { store } = seeded()
    const c = compaction(store, {
      finalKeys: 0,
      onPhase: (p) => {
        if (p === 'copied') store.append(identity.id, 1, text('dirty'))
        if (p === 'round') c.abort('content erasure ran; start again')
      }
    })
    c.start()
    await c.idle()
    expect(c.status().job).toMatchObject({ phase: 'cancelled', message: /content erasure/ })
    expect(leftovers(store)).toEqual([])
  })

  test('close mid-job settles quickly and leaves the live store usable', async () => {
    const { store, root } = seeded()
    const c = compaction(store, { onPhase: (p) => p === 'copied' && void c.close() })
    c.start()
    await c.idle()
    store.close()
    const reopened = open(root).store
    expect(reopened.conversation(identity.id)?.state).toBe('active')
    expect(leftovers(reopened)).toEqual([])
  })
})

describe('incremental reclaim', () => {
  async function incremental() {
    const { store, root } = seeded()
    const c = compaction(store)
    c.start()
    await c.idle()
    // free a lot again
    store.transaction(() => {
      for (let i = 0; i < 200; i++)
        store.append(identity.id, 1, text(`again ${i} ${'c'.repeat(100_000)}`))
    })
    store.compose((db) => db.prepare("DELETE FROM events WHERE event LIKE '%again %'").run())
    checkpointHere(store)
    return { store, root }
  }

  test('on an incremental store a user start reclaims in slices, no rebuild', async () => {
    const { store } = await incremental()
    const free = store.maintenance.fileStats().freePages
    expect(free).toBeGreaterThan(1000)
    const size = statSync(store.path).size
    let slices = 0
    const c = compaction(store, {
      slicePages: 512,
      idleMs: 1,
      reclaimThresholdBytes: 4 * MiB,
      onPhase: (p) => {
        if (p === 'slice') slices++
      }
    })
    expect(c.status().worthIt).toBe(true)
    expect(c.status().requiredDiskBytes).toBe(0)
    expect(c.start().kind).toBe('reclaim')
    await c.idle()
    expect(c.status().job?.phase).toBe('done')
    expect(slices).toBeGreaterThanOrEqual(Math.floor(free / 512))
    expect(store.maintenance.fileStats().freePages).toBe(0)
    expect(statSync(store.path).size).toBeLessThan(size - 10 * MiB)
  })

  test('automatic reclaim only on incremental stores above the threshold', async () => {
    const none = seeded().store
    const c1 = compaction(none, { automaticReclaim: true })
    expect(c1.checkReclaim()).toBe(false)
    expect(c1.status().job).toBeNull()

    const { store } = await incremental()
    const c2 = compaction(store, {
      automaticReclaim: true,
      reclaimThresholdBytes: 4 * MiB,
      idleMs: 1
    })
    expect(c2.checkReclaim()).toBe(true)
    expect(c2.status().job).toMatchObject({ kind: 'reclaim', automatic: true })
    await c2.idle()
    expect(store.maintenance.fileStats().freePages).toBe(0)
    expect(c2.checkReclaim()).toBe(false)
  })

  test('nothing to reclaim is refused', async () => {
    const { store } = seeded()
    const c = compaction(store)
    c.start()
    await c.idle()
    expect(c.status().worthIt).toBe(false)
    expect(() => c.start()).toThrow(/nothing to reclaim/i)
  })

  test('the last result is kept in the store across a restart', async () => {
    const { store, root } = seeded()
    const c = compaction(store)
    c.start()
    await c.idle()
    await c.close()
    store.close()
    const reopened = open(root).store
    expect(compaction(reopened).status().last).toMatchObject({ kind: 'rebuild' })
    expect(existsSync(join(reopened.dir, 'chat.sqlite'))).toBe(true)
  })
})

describe('computer runtime', () => {
  test('a task deletion (content erasure) aborts a running rebuild', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'slz-chat-compact-rt-'))
    roots.push(stateDir)
    const r = createComputerChatRuntime({
      stateDir,
      hubScope: 'hub',
      computerId: 'pc',
      blobBackfill: { automatic: false },
      compaction: {
        automaticReclaim: false,
        onPhase: (phase) => {
          if (phase === 'copied') r.storage.applyTaskLifecycle('task', 'deleted', 2)
        }
      },
      log: () => undefined
    })
    runtimes.push(r)
    r.bootstrap({
      identity: { id: 'c', taskId: 'task', tabId: 'tab', mode: 'claude-chat', epoch: 1 },
      projectId: 'project',
      cwd: stateDir,
      revision: 1,
      providerConfig: {},
      defaultFlags: null,
      env: {}
    })
    r.storage.transaction(() => {
      for (let i = 0; i < 50; i++)
        r.storage.append('c', 1, text(`gone ${i} ${'g'.repeat(100_000)}`))
    })
    r.storage.compose((db) => db.prepare("DELETE FROM events WHERE event LIKE '%gone %'").run())
    await r.blobBackfill.runNow()
    expect(r.blobBackfill.done()).toBe(true)
    r.compaction.start()
    await r.compaction.idle()
    expect(r.compaction.status().job).toMatchObject({ phase: 'cancelled', message: /erased/ })
    expect(r.compaction.status().autoVacuum).toBe('none')
    expect(leftovers(r.storage)).toEqual([])
  })
})

describe('erasure: the rewrite leaves no stale copy secure_delete missed', () => {
  const MARK = 'SECRET-MARK'
  /**
   * Deleted index entries survive as divider keys in index interior pages even with
   * secure_delete (deterministic for this exact data: a copy of 'SECRET-MARK148…' on
   * an interior page) — what only a whole-file rewrite removes.
   */
  function residueTable(db: Database.Database) {
    db.exec('CREATE TABLE IF NOT EXISTS test_residue(c, id, v, PRIMARY KEY(c, id))')
    db.exec('CREATE INDEX IF NOT EXISTS test_residue_v ON test_residue(v)')
    const insert = db.prepare('INSERT INTO test_residue VALUES(?,?,?)')
    for (let i = 0; i < 300; i++) {
      insert.run('a', i, `${MARK}${i}${'x'.repeat(100)}`)
      insert.run('b', i, `y${i}${'y'.repeat(100)}`)
    }
    db.prepare("DELETE FROM test_residue WHERE c='a'").run()
  }
  const holds = (path: string) =>
    [path, `${path}-wal`].filter(
      (file) => existsSync(file) && readFileSync(file).includes(Buffer.from(MARK))
    )

  test('live store: rebuildForErasure rewrites the file; the mark is gone from file and WAL', async () => {
    const { store } = seeded(2, 2)
    store.compose((db) => residueTable(db))
    checkpointHere(store)
    expect(holds(store.path), 'precondition: secure_delete left a copy').not.toEqual([])
    const c = compaction(store)
    await c.rebuildForErasure()
    expect(holds(store.path)).toEqual([])
    expect(store.compose((db) => db.prepare('SELECT count(*) n FROM test_residue').get())).toEqual({
      n: 300
    })
  })

  test('a file nothing else has open (an archive): rebuildStoreFile, same check', async () => {
    const root = mkdtempSync(join(tmpdir(), 'slz-chat-compact-file-'))
    roots.push(root)
    const path = join(root, 'chat.sqlite')
    const db = new Database(path)
    db.pragma('journal_mode = WAL')
    db.pragma('secure_delete = ON')
    db.exec(
      "CREATE TABLE store_identity(id INTEGER PRIMARY KEY, store_id TEXT); INSERT INTO store_identity VALUES(1,'s')"
    )
    db.exec(
      "CREATE TRIGGER keep_identity BEFORE DELETE ON store_identity BEGIN SELECT RAISE(ABORT, 'kept'); END"
    )
    residueTable(db)
    db.pragma('wal_checkpoint(TRUNCATE)')
    db.close()
    expect(holds(path), 'precondition: secure_delete left a copy').not.toEqual([])
    await rebuildStoreFile(path, { batchBytes: 64 * 1024, syncBytes: 256 * 1024, pauseMs: 0 })
    expect(holds(path)).toEqual([])
    const after = new Database(path, { readonly: true })
    try {
      expect(after.prepare('SELECT count(*) n FROM test_residue').get()).toEqual({ n: 300 })
      expect(after.pragma('quick_check', { simple: true })).toBe('ok')
      // its triggers came along
      expect(after.prepare("SELECT name FROM sqlite_master WHERE type='trigger'").all()).toEqual([
        { name: 'keep_identity' }
      ])
    } finally {
      after.close()
    }
    expect(readdirSync(root).filter((n) => n.includes('compact'))).toEqual([])
  })
})

/** Test setup only: everything into the file now, on this thread (the store itself never does). */
function checkpointHere(store: ChatStorage) {
  store.compose((db) => db.pragma('wal_checkpoint(TRUNCATE)'))
}
