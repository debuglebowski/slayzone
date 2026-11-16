/**
 * The chat store's connection is swappable (storage compaction, fu-2): `compose` hands
 * out a stable handle that always reaches the CURRENT connection, so services that keep
 * it for their lifetime survive a swap; connection state (SQL functions, pragmas) is
 * re-applied; secondary connections and a leftover WAL refuse the swap; leftovers of an
 * interrupted swap are cleaned at boot.
 */
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { agentTurnsStore } from './agent-turns'
import { createComputerChatRuntime } from './computer-runtime'
import { openChatStorage, type ChatStorage } from './storage'
import { usageCursorStore } from './usage-cursors'

const roots: string[] = []
const stores: ChatStorage[] = []
const runtimes: Array<ReturnType<typeof createComputerChatRuntime>> = []
const extra: Database.Database[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  syncBuiltinESMExports()
  for (const db of extra.splice(0)) if (db.open) db.close()
  for (const r of runtimes.splice(0)) await r.close()
  for (const s of stores.splice(0)) s.close()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
function tempRoot() {
  const root = mkdtempSync(join(tmpdir(), 'slz-chat-swap-'))
  roots.push(root)
  return root
}
function open(root = tempRoot(), scope = 'hub-a') {
  const store = openChatStorage({ stateDir: root, hubScope: scope })
  stores.push(store)
  return { store, root }
}
const identity = { id: 'conv-a', taskId: 'task-a', tabId: 'tab-a', mode: 'claude-chat', epoch: 1 }
const text = (t: string) => ({ kind: 'assistant-text', messageId: t, text: t }) as const

/** A compacted copy of the live store, as the compactor makes it (VACUUM INTO). */
function compactedCopy(store: ChatStorage): string {
  checkpointHere(store)
  const target = store.maintenance.tempPath()
  const reader = new Database(store.path, { readonly: true, fileMustExist: true })
  try {
    reader.pragma('auto_vacuum = INCREMENTAL')
    reader.prepare('VACUUM INTO ?').run(target)
  } finally {
    reader.close()
  }
  return target
}
/** A swap as compaction does it: the checkpointer paused around it. */
async function swap(store: ChatStorage, copy: string) {
  await store.maintenance.pauseCheckpointer()
  try {
    return store.maintenance.swapIn(copy)
  } finally {
    store.maintenance.resumeCheckpointer()
  }
}
const leftovers = (store: ChatStorage) =>
  readdirSync(store.dir).filter((n) => n.startsWith('chat.sqlite.'))

test('export readers register secondaries, including failed initialization and shutdown cleanup', async () => {
  const { store } = open()
  store.createConversation(identity)
  expect(() => store.openExportReader(identity.id, 1, 'not-frozen')).toThrow()
  expect(store.maintenance.secondaryConnections()).toEqual([])
  expect(store.hasBlobLeases()).toBe(false)
  store.freeze(identity.id, 1, 'move')
  const reader = store.openExportReader(identity.id, 1, 'move')
  try {
    expect(store.maintenance.secondaryConnections()).toHaveLength(1)
    await store.maintenance.pauseCheckpointer()
    expect(() => store.maintenance.swapIn(store.maintenance.tempPath())).toThrow(/secondary/i)
  } finally {
    reader.close()
  }
  expect(store.maintenance.secondaryConnections()).toEqual([])
  store.openExportReader(identity.id, 1, 'move')
  await store.shutdown()
  expect(store.hasExportReaders()).toBe(false)
  expect(store.maintenance.secondaryConnections()).toEqual([])
})

test('a failed native reader close keeps its registration until physical close can retry', async () => {
  const { store } = open()
  store.createConversation(identity)
  store.freeze(identity.id, 1, 'move')
  const reader = store.openExportReader(identity.id, 1, 'move')
  const original = Database.prototype.close
  let failed: Database.Database | undefined
  const fault = vi.spyOn(Database.prototype, 'close').mockImplementation(function (
    this: Database.Database
  ) {
    if (this.readonly) {
      failed = this
      throw new Error('native reader close failed')
    }
    return original.call(this)
  })
  try {
    expect(() => reader.close()).toThrow('native reader close failed')
    expect(store.maintenance.secondaryConnections()).toHaveLength(1)
    expect(store.hasExportReaders()).toBe(true)
  } finally {
    fault.mockRestore()
    await store.shutdown()
    if (failed?.open) original.call(failed)
  }
  expect(store.maintenance.secondaryConnections()).toEqual([])
})

describe('swappable chat store connection', () => {
  test('a handle kept from compose reaches the new file after a swap', async () => {
    const { store } = open()
    store.createConversation(identity)
    store.append(identity.id, 1, text('before'))
    const held = store.compose((db) => db)
    expect(store.maintenance.fileStats().autoVacuum).toBe(0)

    const result = await swap(store, compactedCopy(store))

    expect(result.holdMs).toBeGreaterThanOrEqual(0)
    expect(store.maintenance.fileStats().autoVacuum).toBe(2)
    expect(held.prepare('SELECT count(*) n FROM events').get()).toEqual({ n: 1 })
    store.append(identity.id, 1, text('after'))
    expect(store.read(identity.id, -1).map((e) => (e.event as { text: string }).text)).toEqual([
      'before',
      'after'
    ])
    expect(held.pragma('auto_vacuum', { simple: true })).toBe(2)
    expect(leftovers(store)).toEqual([])
  })

  test('connection pragmas hold on the new connection, journal_size_limit included', async () => {
    const { store } = open()
    const db = store.compose((d) => d)
    const pragmas = () => ({
      journal: db.pragma('journal_mode', { simple: true }),
      synchronous: db.pragma('synchronous', { simple: true }),
      foreignKeys: db.pragma('foreign_keys', { simple: true }),
      busy: db.pragma('busy_timeout', { simple: true }),
      secureDelete: db.pragma('secure_delete', { simple: true }),
      walLimit: db.pragma('journal_size_limit', { simple: true }),
      autocheckpoint: db.pragma('wal_autocheckpoint', { simple: true })
    })
    const expected = {
      journal: 'wal',
      // NORMAL, no checkpoint on this connection: the checkpointer syncs off-thread (S5).
      synchronous: 1,
      foreignKeys: 1,
      busy: 5000,
      secureDelete: 1,
      walLimit: 64 * 1024 * 1024,
      autocheckpoint: 0
    }
    expect(pragmas()).toEqual(expected)
    await swap(store, compactedCopy(store))
    expect(pragmas()).toEqual(expected)
  })

  test('connection state set through the handle is re-applied: SQL functions and pragmas', async () => {
    const { store } = open()
    const db = store.compose((d) => d)
    db.function('swap_probe', () => 42)
    db.pragma('cache_size = -4096')
    await swap(store, compactedCopy(store))
    expect(db.prepare('SELECT swap_probe() v').get()).toEqual({ v: 42 })
    expect(db.pragma('cache_size', { simple: true })).toBe(-4096)
  })

  test('a statement prepared before the swap fails loudly after it', async () => {
    const { store } = open()
    store.createConversation(identity)
    const stale = store.compose((db) => db.prepare('SELECT count(*) n FROM events'))
    await swap(store, compactedCopy(store))
    expect(() => stale.get()).toThrow(/not open/)
  })

  test('the handle cannot close the store connection', () => {
    const { store } = open()
    expect(() => store.compose((db) => db.close())).toThrow(/owns its connection/)
    expect(store.compose((db) => db.open)).toBe(true)
  })

  test('a registered secondary connection makes the swap wait; the live store is unchanged', async () => {
    const { store } = open()
    store.createConversation(identity)
    store.append(identity.id, 1, text('kept'))
    const copy = compactedCopy(store)
    const reader = store.maintenance.registerSecondary('export reader')
    expect(store.maintenance.secondaryConnections()).toEqual(['export reader'])
    await expect(swap(store, copy)).rejects.toThrow(/secondary connection/)
    expect(store.maintenance.fileStats().autoVacuum).toBe(0)
    expect(store.read(identity.id, -1)).toHaveLength(1)
    reader.release()
    reader.release()
    expect(store.maintenance.secondaryConnections()).toEqual([])
    await swap(store, copy)
    expect(store.maintenance.fileStats().autoVacuum).toBe(2)
    expect(store.read(identity.id, -1)).toHaveLength(1)
  })

  test('backstop: an unregistered connection keeps the WAL alive → swap refused, nothing lost', async () => {
    const { store } = open()
    store.createConversation(identity)
    const copy = compactedCopy(store)
    // An unregistered reader that has read once holds the WAL index open (a connection
    // that never read holds nothing; registration is the rule, this is the backstop).
    const epoch = store.maintenance.connectionEpoch()
    const rogue = new Database(store.path, { readonly: true })
    extra.push(rogue)
    rogue.prepare('SELECT count(*) FROM events').get()
    store.append(identity.id, 1, text('in the wal'))
    await expect(swap(store, copy)).rejects.toThrow(/WAL/)
    expect(store.maintenance.connectionEpoch()).toBe(epoch + 1)
    expect(store.maintenance.fileStats().autoVacuum).toBe(0)
    expect(store.read(identity.id, -1).map((e) => (e.event as { text: string }).text)).toEqual([
      'in the wal'
    ])
    store.append(identity.id, 1, text('still writable'))
    expect(store.read(identity.id, -1)).toHaveLength(2)
    expect(existsSync(copy)).toBe(false)
    expect(leftovers(store)).toEqual([])
  })

  test('a file from another store is refused and the live file restored', async () => {
    const { store } = open()
    store.createConversation(identity)
    store.append(identity.id, 1, text('mine'))
    const other = open().store
    const foreign = compactedCopy(other)
    renameSync(foreign, join(store.dir, 'chat.sqlite.compact-foreign'))
    await expect(swap(store, join(store.dir, 'chat.sqlite.compact-foreign'))).rejects.toThrow(
      /store identity/
    )
    expect(store.read(identity.id, -1)).toHaveLength(1)
    store.append(identity.id, 1, text('writable'))
    expect(store.read(identity.id, -1)).toHaveLength(2)
    expect(leftovers(store)).toEqual([])
  })
})

describe('boot cleanup', () => {
  test('every leftover cleanup is attempted before boot refuses unfinished cleanup', () => {
    const { store, root } = open()
    store.createConversation(identity)
    const dir = store.dir
    store.close()
    const blocked = ['chat.sqlite.compact-a', 'chat.sqlite.compact-b']
    for (const name of blocked) mkdirSync(join(dir, name))
    const removable = join(dir, 'chat.sqlite.compact-z')
    writeFileSync(removable, 'stale content')

    let failure: unknown
    try {
      open(root)
    } catch (error) {
      failure = error
    }
    expect(failure).toBeInstanceOf(AggregateError)
    expect((failure as AggregateError).errors).toHaveLength(2)
    expect(existsSync(removable)).toBe(false)

    for (const name of blocked) rmSync(join(dir, name), { recursive: true })
    expect(open(root).store.conversation(identity.id)).not.toBeNull()
  })

  test('leftovers of an interrupted compaction are removed before opening', () => {
    const { store, root } = open()
    store.createConversation(identity)
    const dir = store.dir
    store.close()
    for (const name of [
      'chat.sqlite.compact-1-x',
      'chat.sqlite.compact-1-x-journal',
      'chat.sqlite.compact-2-y-wal',
      'chat.sqlite.pre-compact'
    ])
      writeFileSync(join(dir, name), 'junk')
    const reopened = open(root).store
    expect(leftovers(reopened)).toEqual([])
    expect(reopened.conversation(identity.id)?.state).toBe('active')
  })

  test('a store found only as pre-compact (killed between link and rename) is restored', () => {
    const { store, root } = open()
    store.createConversation(identity)
    const dir = store.dir
    store.close()
    renameSync(join(dir, 'chat.sqlite'), join(dir, 'chat.sqlite.pre-compact'))
    const reopened = open(root).store
    expect(reopened.conversation(identity.id)?.state).toBe('active')
    expect(leftovers(reopened)).toEqual([])
  })
})

describe('computer runtime services across a swap', () => {
  test('services that keep the handle for their lifetime keep working', async () => {
    const stateDir = tempRoot()
    const r = createComputerChatRuntime({ stateDir, hubScope: 'hub', computerId: 'pc' })
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
    const cursors = usageCursorStore(r.storage)
    const turns = agentTurnsStore(r.storage)

    await swap(r.storage, compactedCopy(r.storage))

    // retention keeps its handle from construction
    r.retention.configure(3)
    expect(r.retention.days).toBe(3)
    // task paths keep theirs
    r.taskPaths.handle({ op: 'set', taskId: 'task', projectId: 'project', baseDir: '/b', at: 1 })
    expect(r.taskPaths.get('task')?.baseDir).toBe('/b')
    // usage cursors
    cursors.commit([{ sourceFile: '/log', offset: 7, modifiedMs: 1 }])
    expect(cursors.all()).toEqual({ '/log': { offset: 7, modifiedMs: 1 } })
    // agent turns
    turns.insert({
      id: 'turn',
      worktree_path: '/w',
      task_id: 'task',
      terminal_tab_id: 'tab',
      snapshot_sha: 'a'.repeat(40),
      head_sha_at_snap: 'b'.repeat(40),
      prompt_preview: 'p',
      created_at: 1
    })
    expect(turns.get('turn')?.task_id).toBe('task')
    // artifacts: their triggers call a SQL function registered on the connection
    const artifact = (await r.artifacts.invoke({
      route: { id: 'c', epoch: 1 },
      method: 'uploadArtifactBlob',
      operationId: randomUUID(),
      args: [{ taskId: 'task', title: 'a.txt', data: Buffer.from('x').toString('base64') }]
    })) as { id: string }
    expect(
      r.storage.compose((db) =>
        db.prepare('SELECT conversation_id FROM artifact_owners WHERE id=?').get(artifact.id)
      )
    ).toEqual({ conversation_id: 'c' })
  })
})

/** Test setup only: everything into the file now, on this thread (the store itself never does). */
function checkpointHere(store: ChatStorage) {
  store.compose((db) => db.pragma('wal_checkpoint(TRUNCATE)'))
}

/** Native SQLite with one injected boundary failure; no fake VFS or durability mode. */
describe('post-close recovery', () => {
  const boundaries = [
    'closed',
    'linked',
    'renamed',
    'wal-stat',
    'shm-remove',
    'pre-remove',
    'link',
    'rename',
    'directory-sync',
    'directory-open',
    'directory-close',
    'open',
    'identity',
    'pragma-replay',
    'function-replay',
    'aggregate-replay',
    'table-replay',
    'pre-unlink'
  ] as const
  test.each(boundaries)(
    '%s failure preserves history, connection state and later writes',
    async (boundary) => {
      const { store } = open()
      store.createConversation(identity)
      store.append(identity.id, 1, text('before'))
      const held = store.compose((db) => db)
      const prepare = held.prepare
      held.function('swap_probe', () => 42)
      held.aggregate('swap_sum', { start: 0, step: (sum: number, value: number) => sum + value })
      held.table('swap_rows', {
        columns: ['value'],
        rows: function* () {
          yield [17]
        }
      })
      held.pragma('cache_size = -4096')
      const copy = compactedCopy(store)
      const epoch = store.maintenance.connectionEpoch()
      const primary = new Error(`injected ${boundary}`)
      let armed = true
      const fail = () => {
        if (armed) {
          armed = false
          throw primary
        }
      }
      const injectFs = (
        method:
          | 'existsSync'
          | 'rmSync'
          | 'linkSync'
          | 'renameSync'
          | 'fsyncSync'
          | 'openSync'
          | 'chmodSync'
          | 'unlinkSync',
        matches: (args: unknown[]) => boolean
      ) => {
        const original = fs[method]
        vi.spyOn(fs, method).mockImplementation(((...args: unknown[]) => {
          if (matches(args)) fail()
          return Reflect.apply(original, fs, args)
        }) as never)
        syncBuiltinESMExports()
      }
      if (boundary === 'wal-stat') injectFs('existsSync', (args) => args[0] === `${store.path}-wal`)
      if (boundary === 'shm-remove') injectFs('rmSync', (args) => args[0] === `${store.path}-shm`)
      if (boundary === 'pre-remove')
        injectFs('rmSync', (args) => args[0] === `${store.path}.pre-compact`)
      if (boundary === 'link') injectFs('linkSync', () => true)
      if (boundary === 'rename') injectFs('renameSync', (args) => args[0] === copy)
      if (boundary === 'directory-sync') injectFs('fsyncSync', () => true)
      if (boundary === 'directory-open') injectFs('openSync', (args) => args[0] === store.dir)
      if (boundary === 'directory-close') {
        const original = fs.closeSync
        vi.spyOn(fs, 'closeSync').mockImplementation((fd) => {
          original(fd)
          fail()
        })
        syncBuiltinESMExports()
      }
      if (boundary === 'open') injectFs('chmodSync', (args) => args[0] === store.path)
      if (boundary === 'pre-unlink')
        injectFs('unlinkSync', (args) => args[0] === `${store.path}.pre-compact`)
      if (boundary === 'identity') {
        const original = Database.prototype.prepare
        vi.spyOn(Database.prototype, 'prepare').mockImplementation(function (
          this: Database.Database,
          sql: string
        ) {
          if (this.name === store.path && sql.includes('SELECT store_id')) fail()
          return original.call(this, sql)
        })
      }
      if (boundary === 'pragma-replay') {
        const original = Database.prototype.pragma
        vi.spyOn(Database.prototype, 'pragma').mockImplementation(function (
          this: Database.Database,
          source: string,
          options?: Database.PragmaOptions
        ) {
          if (source === 'cache_size = -4096') fail()
          return original.call(this, source, options)
        })
      }
      for (const method of ['function', 'aggregate', 'table'] as const) {
        if (boundary !== `${method}-replay`) continue
        const original = Database.prototype[method]
        vi.spyOn(Database.prototype, method).mockImplementation(function (
          this: Database.Database,
          ...args: unknown[]
        ) {
          fail()
          return Reflect.apply(original, this, args)
        } as never)
      }
      let failure: unknown
      await store.maintenance.pauseCheckpointer()
      try {
        store.maintenance.swapIn(copy, {
          phase: (step) => {
            if (step === boundary) fail()
          }
        })
      } catch (error) {
        failure = error
      } finally {
        store.maintenance.resumeCheckpointer()
      }
      if (process.platform === 'win32' && boundary.startsWith('directory-')) {
        // Windows has no directory-fsync boundary in syncDirSync: verify that
        // platform contract, without skipping the state/history assertions below.
        expect(failure).toBeUndefined()
        expect(armed).toBe(true)
      } else {
        expect(failure).toMatchObject({ cause: primary, usable: true, selectedFile: store.path })
        expect((failure as AggregateError).errors).toContain(primary)
      }
      expect(store.maintenance.connectionEpoch()).toBeGreaterThan(epoch)
      expect(held.open).toBe(true)
      expect(prepare('SELECT swap_probe() n').get()).toEqual({ n: 42 })
      expect(held.prepare('SELECT swap_sum(seq) n FROM events').get()).toEqual({ n: 0 })
      expect(held.prepare('SELECT value FROM swap_rows').get()).toEqual({ value: 17 })
      expect(held.pragma('cache_size', { simple: true })).toBe(-4096)
      store.append(identity.id, 1, text('after'))
      expect(store.read(identity.id, -1).map((e) => e.event)).toEqual([
        text('before'),
        text('after')
      ])
      expect(leftovers(store)).toEqual([])
    }
  )

  test('native busy close keeps the same live facade and connection epoch', async () => {
    const { store } = open()
    store.createConversation(identity)
    store.append(identity.id, 1, text('before'))
    const copy = compactedCopy(store)
    await store.maintenance.pauseCheckpointer()
    const epoch = store.maintenance.connectionEpoch()
    const iterator = store.compose((db) => db.prepare('SELECT * FROM events').iterate())
    iterator.next()
    try {
      expect(() => store.maintenance.swapIn(copy)).toThrow(/busy/)
      expect(store.compose((db) => db.open)).toBe(true)
      expect(store.maintenance.connectionEpoch()).toBe(epoch)
    } finally {
      iterator.return?.()
      store.maintenance.resumeCheckpointer()
    }
    store.append(identity.id, 1, text('after'))
    expect(store.read(identity.id, -1)).toHaveLength(2)
  })

  test('close that physically closes then throws reopens old and invalidates its epoch', async () => {
    const { store } = open()
    store.createConversation(identity)
    const copy = compactedCopy(store)
    const original = Database.prototype.close
    const primary = new Error('closed before reporting failure')
    let armed = true
    vi.spyOn(Database.prototype, 'close').mockImplementation(function (this: Database.Database) {
      const result = original.call(this)
      if (this.name === store.path && armed) {
        armed = false
        throw primary
      }
      return result
    })
    const epoch = store.maintenance.connectionEpoch()
    await expect(swap(store, copy)).rejects.toMatchObject({ cause: primary, usable: true })
    expect(store.maintenance.connectionEpoch()).toBe(epoch + 1)
    store.append(identity.id, 1, text('after'))
  })

  test('persistent reopen failure fences only this facade and preserves recovery causes', async () => {
    const { store } = open()
    const other = open().store
    store.createConversation(identity)
    const held = store.compose((db) => db)
    const copy = compactedCopy(store)
    const primary = new Error('phase failed')
    const recovery = new Error('cannot reopen live path')
    const original = fs.chmodSync
    vi.spyOn(fs, 'chmodSync').mockImplementation((file, mode) => {
      if (file === store.path) throw recovery
      return original(file, mode)
    })
    syncBuiltinESMExports()
    let failure: unknown
    await store.maintenance.pauseCheckpointer()
    try {
      store.maintenance.swapIn(copy, {
        phase: (step) => {
          if (step === 'closed') throw primary
        }
      })
    } catch (error) {
      failure = error
    } finally {
      store.maintenance.resumeCheckpointer()
    }
    expect(failure).toMatchObject({
      cause: primary,
      usable: false,
      selectedFile: null,
      retainedConnections: 0
    })
    expect((failure as AggregateError).errors).toContain(recovery)
    expect(held.open).toBe(false)
    expect(() => held.prepare('SELECT 1')).toThrow(failure as Error)
    await expect(store.flush()).rejects.toBe(failure)
    other.createConversation(identity)
    other.append(identity.id, 1, text('unrelated healthy store'))
  })

  test('failed candidate close retains ownership, refuses another writer, then closes on retry', async () => {
    const { store } = open()
    const copy = compactedCopy(store)
    const primary = new Error('replay failed')
    const cleanup = new Error('candidate close refused')
    const originalPragma = Database.prototype.pragma
    store.compose((db) => db.pragma('cache_size = -4096'))
    const candidates: Database.Database[] = []
    vi.spyOn(Database.prototype, 'pragma').mockImplementation(function (
      this: Database.Database,
      source: string,
      options?: Database.PragmaOptions
    ) {
      if (this.name === store.path && source === 'cache_size = -4096') {
        candidates.push(this)
        throw primary
      }
      return originalPragma.call(this, source, options)
    })
    const originalClose = Database.prototype.close
    vi.spyOn(Database.prototype, 'close').mockImplementation(function (this: Database.Database) {
      if (candidates.includes(this)) throw cleanup
      return originalClose.call(this)
    })
    let failure: unknown
    try {
      await swap(store, copy)
    } catch (error) {
      failure = error
    }
    expect(failure).toMatchObject({ cause: primary, usable: false, retainedConnections: 1 })
    expect((failure as AggregateError).errors).toContain(cleanup)
    expect(candidates).toHaveLength(1)
    expect(candidates[0].open).toBe(true)
    expect(() => store.close()).toThrow(cleanup)
    vi.restoreAllMocks()
    store.close()
    expect(candidates[0].open).toBe(false)
  })
})

test.each(['rollback-rename', 'rollback-sync', 'copy-cleanup', 'pre-cleanup'] as const)(
  '%s errors stay structured while a verified live file remains usable',
  async (boundary) => {
    const { store } = open()
    store.createConversation(identity)
    store.append(identity.id, 1, text('kept'))
    const copy = compactedCopy(store)
    const primary = new Error('renamed hook failed')
    const cleanup = new Error(`injected ${boundary}`)
    let recovering = false
    const method =
      boundary === 'rollback-rename'
        ? 'renameSync'
        : boundary === 'rollback-sync'
          ? 'fsyncSync'
          : 'rmSync'
    const original = fs[method]
    vi.spyOn(fs, method).mockImplementation(((...args: unknown[]) => {
      if (
        recovering &&
        (method !== 'rmSync' ||
          args[0] === (boundary === 'copy-cleanup' ? copy : `${store.path}.pre-compact`))
      )
        throw cleanup
      return Reflect.apply(original, fs, args)
    }) as never)
    syncBuiltinESMExports()
    let failure: unknown
    await store.maintenance.pauseCheckpointer()
    try {
      store.maintenance.swapIn(copy, {
        phase: (step) => {
          if (step === 'renamed') {
            recovering = true
            throw primary
          }
        }
      })
    } catch (error) {
      failure = error
    } finally {
      store.maintenance.resumeCheckpointer()
    }
    expect(failure).toMatchObject({ cause: primary, usable: true, selectedFile: store.path })
    expect((failure as AggregateError).errors).toContain(primary)
    if (process.platform === 'win32' && boundary === 'rollback-sync')
      expect((failure as AggregateError).errors).toEqual([primary])
    else expect((failure as AggregateError).errors).toContain(cleanup)
    store.append(identity.id, 1, text('after'))
    expect(store.read(identity.id, -1).map((row) => row.event)).toEqual([
      text('kept'),
      text('after')
    ])
  }
)

test('persistent state replay failure closes every attempted replacement before fencing', async () => {
  const { store } = open()
  const copy = compactedCopy(store)
  store.compose((db) => db.function('unreplayable', () => 1))
  const attempted: Database.Database[] = []
  const epoch = store.maintenance.connectionEpoch()
  const primary = new Error('registration unavailable')
  vi.spyOn(Database.prototype, 'function').mockImplementation(function (this: Database.Database) {
    attempted.push(this)
    throw primary
  } as never)
  let failure: unknown
  try {
    await swap(store, copy)
  } catch (error) {
    failure = error
  }
  expect(failure).toMatchObject({ cause: primary, usable: false, retainedConnections: 0 })
  expect(store.maintenance.connectionEpoch()).toBeGreaterThan(epoch)
  expect(() => store.storeId()).toThrow(failure as Error)
  expect(attempted).toHaveLength(2)
  expect(attempted.every((native) => !native.open)).toBe(true)
})

test('real undeletable pre-compact directory reopens old without losing the original EISDIR', async () => {
  const { store } = open()
  store.createConversation(identity)
  store.append(identity.id, 1, text('before'))
  const copy = compactedCopy(store)
  mkdirSync(`${store.path}.pre-compact`)
  let failure: unknown
  try {
    await swap(store, copy)
  } catch (error) {
    failure = error
  }
  expect(failure).toMatchObject({
    usable: true,
    cause: { code: expect.stringMatching(/EISDIR|ERR_FS_EISDIR|EPERM/) }
  })
  store.append(identity.id, 1, text('after'))
  expect(store.read(identity.id, -1)).toHaveLength(2)
})

test('preflight native close failure keeps the live facade, retains candidate ownership, and blocks another swap', async () => {
  const { store } = open()
  store.createConversation(identity)
  const copy = compactedCopy(store)
  const primary = new Error('preflight candidate close failed')
  const original = Database.prototype.close
  let candidate: Database.Database | undefined
  vi.spyOn(Database.prototype, 'close').mockImplementation(function (this: Database.Database) {
    if (this.name === copy) {
      candidate = this
      throw primary
    }
    return original.call(this)
  })
  await expect(swap(store, copy)).rejects.toMatchObject({
    cause: primary,
    usable: true,
    retainedConnections: 1
  })
  expect(candidate!.open).toBe(true)
  await expect(swap(store, copy)).rejects.toThrow(/retained.*connection/)
  store.append(identity.id, 1, text('live facade available'))
  vi.restoreAllMocks()
  store.close()
  expect(candidate!.open).toBe(false)
})

test('captured prepare wrappers keep existing facade override behavior before and after replacement', async () => {
  const { store } = open()
  const copy = compactedCopy(store)
  const held = store.compose((db) => db)
  const prepare = held.prepare.bind(held)
  let wrapped = 0
  held.prepare = ((sql: string) => {
    wrapped++
    return prepare(sql)
  }) as typeof held.prepare
  expect(held.prepare('SELECT 1 n').get()).toEqual({ n: 1 })
  expect(wrapped).toBe(1)
  await swap(store, copy)
  const before = wrapped
  expect(prepare('SELECT 2 n').get()).toEqual({ n: 2 })
  expect(wrapped).toBe(before) // old connection overrides do not survive replacement
})

test('directory sync and descriptor cleanup failures both survive recovery', async () => {
  const { store } = open()
  store.createConversation(identity)
  const copy = compactedCopy(store)
  const primary = new Error('directory fsync failed')
  const cleanup = new Error('directory close failed after releasing fd')
  let syncArmed = true,
    closeArmed = true
  const originalSync = fs.fsyncSync,
    originalClose = fs.closeSync
  vi.spyOn(fs, 'fsyncSync').mockImplementation((fd) => {
    if (syncArmed) {
      syncArmed = false
      throw primary
    }
    originalSync(fd)
  })
  vi.spyOn(fs, 'closeSync').mockImplementation((fd) => {
    originalClose(fd)
    if (closeArmed) {
      closeArmed = false
      throw cleanup
    }
  })
  syncBuiltinESMExports()
  let failure: unknown
  try {
    await swap(store, copy)
  } catch (error) {
    failure = error
  }
  if (process.platform === 'win32') {
    expect(failure).toBeUndefined()
    expect(syncArmed).toBe(true)
    expect(closeArmed).toBe(true)
  } else {
    expect(failure).toMatchObject({
      usable: true,
      cause: { cause: primary, errors: [primary, cleanup] }
    })
  }
  store.append(identity.id, 1, text('after'))
})
