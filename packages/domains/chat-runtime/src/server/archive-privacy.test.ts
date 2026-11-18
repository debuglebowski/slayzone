import { createHash, randomUUID } from 'node:crypto'
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import Database from 'better-sqlite3'
import { afterEach, expect, test, vi } from 'vitest'
import { createComputerChatRuntime } from './computer-runtime'
import { startCompactionWorker, type CompactionWorkerFactory } from './compaction-worker-host'
import { openComputerChatRuntime } from './computer-online-runtime'
import { createChatStoreFaults } from './computer-store-faults'
// Fails the test on a lifecycle model / runtime disagreement.
import '../../../terminal/src/server/runtime/chat-lifecycle-strict-testkit'

const roots: string[] = []
const runtimes: ReturnType<typeof createComputerChatRuntime>[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  syncBuiltinESMExports()
  for (const r of runtimes.splice(0)) await r.close()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
function runtime(workerFactory?: CompactionWorkerFactory) {
  const stateDir = mkdtempSync(join(tmpdir(), 's8-archive-'))
  roots.push(stateDir)
  const r = createComputerChatRuntime({
    stateDir,
    hubScope: 'hub',
    computerId: 'pc',
    maintenance: true,
    compaction: { workerFactory }
  })
  runtimes.push(r)
  for (const taskId of ['alice', 'bob', 'carol']) {
    r.storage.createConversation({
      id: taskId,
      taskId,
      tabId: taskId,
      mode: 'claude-chat',
      epoch: 1
    })
    r.storage.append(taskId, 1, {
      kind: 'assistant-text',
      messageId: taskId,
      text: `${taskId} secret`
    })
  }
  return r
}
function files(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? files(join(root, e.name)) : [join(root, e.name)]
  )
}
test.each(['indexed', 'unindexed'])(
  'erasure cleans rewrite/pre/sidecar/manifest residues in every %s archive, retaining snapshots',
  async (kind) => {
    const r = runtime()
    const backup = await r.backups.create()
    const archive = await r.backups.restore(backup.id)
    await r.backups.eraseTask('alice') // populates fingerprint/index before adding residue
    await r.backups.eraseTask('bob')
    const path = join(r.backups.archiveDir, archive.id)
    if (kind === 'unindexed')
      r.storage.compose((db) => db.prepare('DELETE FROM archive_index').run())
    for (const suffix of [
      '.compact-orphan',
      '.compact-orphan-wal',
      '.pre-compact',
      '.pre-compact-journal'
    ])
      copyFileSync(
        join(r.backups.dir, backup.id, 'chat.sqlite'),
        join(path, `chat.sqlite${suffix}`)
      )
    writeFileSync(join(path, '.erasure-orphan.json'), 'bob secret')
    await r.backups.eraseTask('bob')
    expect(files(path).filter((p) => readFileSync(p).includes(Buffer.from('bob secret')))).toEqual(
      []
    )
    expect((await r.backups.read(archive.id, 'carol')).events).toHaveLength(1)
    expect(
      readFileSync(join(r.backups.dir, backup.id, 'chat.sqlite')).includes(
        Buffer.from('bob secret')
      )
    ).toBe(true)
  }
)

test('failed residue unlink preserves exact cause, refuses success, and permits cleanup retry', async () => {
  const r = runtime()
  const backup = await r.backups.create()
  const archive = await r.backups.restore(backup.id)
  const residue = join(r.backups.archiveDir, archive.id, 'chat.sqlite.compact-unlink')
  writeFileSync(residue, 'alice secret')
  const failure = Object.assign(new Error('injected archive unlink refusal'), { code: 'EACCES' })
  const remove = fs.rmSync
  const spy = vi.spyOn(fs, 'rmSync').mockImplementation((path, options) => {
    if (String(path) === residue) throw failure
    return remove(path, options)
  })
  syncBuiltinESMExports()
  try {
    const error = await r.backups.eraseTask('alice').catch((e) => e)
    expect(error).toBeInstanceOf(AggregateError)
    expect(error.cause).toBe(failure)
    expect(existsSync(residue)).toBe(true)
  } finally {
    spy.mockRestore()
    syncBuiltinESMExports()
  }
  await r.backups.eraseTask('alice')
  expect(existsSync(residue)).toBe(false)
  expect((await r.backups.read(archive.id, 'carol')).events).toHaveLength(1)
})

test.each([false, true])(
  'archive native close failure retains physical ownership truthfully (already closed: %s)',
  async (closed) => {
    const r = runtime()
    const backup = await r.backups.create()
    const archive = await r.backups.restore(backup.id)
    const path = join(r.backups.archiveDir, archive.id, 'chat.sqlite')
    const failure = new Error('injected archive native close')
    const close = Database.prototype.close
    let connection: Database.Database | undefined
    let refuseClose = true
    const spy = vi.spyOn(Database.prototype, 'close').mockImplementation(function (
      this: Database.Database
    ) {
      if (this.name === path && refuseClose) {
        connection = this
        if (closed) close.call(this)
        throw failure
      }
      return close.call(this)
    })
    try {
      const error = await r.backups.eraseTask('alice').catch((e) => e)
      expect(error.cause).toBe(failure)
      expect(connection?.open).toBe(!closed)
      expect(
        r.storage.maintenance.secondaryConnections().includes(`chat archive ${archive.id}`)
      ).toBe(!closed)
      if (!closed) {
        r.storage.faults.record(
          {
            pass: 'chat-archive-index',
            itemKey: archive.id,
            kind: 'transient',
            error: failure
          },
          Date.now()
        )
        const faults = createChatStoreFaults(r)
        const discard = await faults
          .discard({ source: 'ledger', pass: 'chat-archive-index', key: archive.id })
          .catch((error) => error)
        expect(discard.cause).toBe(failure)
        expect(connection?.open).toBe(true)
        expect(existsSync(path)).toBe(true)
        expect(faults.list().faults).toContainEqual(
          expect.objectContaining({ pass: 'chat-archive-index', key: archive.id })
        )
      }
      refuseClose = false
      await r.backups.eraseTask('alice')
      expect(connection?.open).toBe(false)
      expect(r.storage.maintenance.secondaryConnections()).toEqual([])
      expect((await r.backups.read(archive.id, 'carol')).events).toHaveLength(1)
    } finally {
      spy.mockRestore()
    }
  }
)

test('archive erasure retains native ownership through async upload cleanup and post-await DB checks', async () => {
  let rewrites = 0
  let connection: Database.Database | undefined
  const r = runtime((spec) => {
    if (spec.mode === 'file') {
      expect(connection?.open).toBe(false)
      rewrites++
    }
    return startCompactionWorker(spec)
  })
  const backup = await r.backups.create()
  const archive = await r.backups.restore(backup.id)
  const path = join(r.backups.archiveDir, archive.id)
  const label = `chat archive ${archive.id}`
  const uploads = join(
    path,
    'uploads',
    'owned',
    createHash('sha256').update(JSON.stringify('alice')).digest('hex')
  )
  const before = readFileSync(join(path, 'manifest.json'))
  let release!: () => void
  const hold = new Promise<void>((resolve) => {
    release = resolve
  })
  let entered = false,
    resumed = false,
    checked = 0
  const prepare = Database.prototype.prepare
  vi.spyOn(Database.prototype, 'prepare').mockImplementation(function (
    this: Database.Database,
    sql: string
  ) {
    if (this.name === join(path, 'chat.sqlite')) {
      if (!resumed) connection = this
      if (resumed && /^SELECT 1 FROM (events|records|receipts) WHERE/.test(sql)) {
        expect(this.open).toBe(true)
        expect(r.storage.maintenance.secondaryConnections()).toContain(label)
        checked++
      }
    }
    return prepare.call(this, sql)
  })
  const remove = fs.promises.rm.bind(fs.promises)
  vi.spyOn(fs.promises, 'rm').mockImplementation(async (target, options) => {
    if (String(target) === uploads) {
      entered = true
      await hold
      resumed = true
    }
    return remove(target, options)
  })
  syncBuiltinESMExports()
  let erased = false,
    read = false,
    closed = false,
    erasureError: unknown
  const erasing = r.backups.eraseTask('alice').then(() => {
    erased = true
  })
  void erasing.catch((error) => {
    erasureError = error
  })
  const work: Promise<unknown>[] = [erasing]
  try {
    await vi.waitFor(
      () => {
        expect(erasureError).toBeUndefined()
        expect(entered).toBe(true)
      },
      { timeout: 2000 }
    )
    expect(connection?.open).toBe(true)
    expect(r.storage.maintenance.secondaryConnections()).toContain(label)
    let closeFailure: unknown
    try {
      r.storage.maintenance.closeSecondaries(label)
    } catch (error) {
      closeFailure = error
    }
    expect(closeFailure).toBeInstanceOf(AggregateError)
    expect((closeFailure as AggregateError).errors).toEqual([
      expect.objectContaining({ message: 'Archive connection is still in use' })
    ])
    expect(connection?.open).toBe(true)
    expect(checked).toBe(0)
    expect(rewrites).toBe(0)
    expect(readFileSync(join(path, 'manifest.json'))).toEqual(before)
    const reading = r.backups.read(archive.id, 'alice').then((value) => {
      read = true
      return value
    })
    const retained = r.backups.read(archive.id, 'carol')
    const closing = r.backups.close().then(() => {
      closed = true
    })
    work.push(reading, retained, closing)
    await new Promise((resolve) => setImmediate(resolve))
    expect({ erased, read, closed }).toEqual({ erased: false, read: false, closed: false })
    release()
    await Promise.all(work)
    expect((await reading).events).toEqual([])
    expect((await retained).events).toHaveLength(1)
    expect(checked).toBe(3)
    expect(rewrites).toBe(1)
    expect(connection?.open).toBe(false)
    expect(r.storage.maintenance.secondaryConnections()).toEqual([])
    expect(readFileSync(join(path, 'manifest.json'))).not.toEqual(before)
    expect(
      files(path).some((file) => readFileSync(file).includes(Buffer.from('alice secret')))
    ).toBe(false)
    expect(
      readFileSync(join(r.backups.dir, backup.id, 'chat.sqlite')).includes(
        Buffer.from('alice secret')
      )
    ).toBe(true)
  } finally {
    release()
    await Promise.allSettled(work)
  }
})

test('failed unpublished restore remains owned through native close failure; erasure cannot skip its staging copy', async () => {
  const r = runtime()
  const backup = await r.backups.create()
  const close = Database.prototype.close
  let refuse = true
  const spy = vi.spyOn(Database.prototype, 'close').mockImplementation(function (
    this: Database.Database
  ) {
    if (refuse && this.name.includes('/archives/.pending-'))
      throw new Error('unpublished native close refused')
    return close.call(this)
  })
  try {
    await expect(r.backups.restore(backup.id)).rejects.toThrow(/cleanup/)
    expect(readdirSync(r.backups.archiveDir).some((name) => name.startsWith('.pending-'))).toBe(
      true
    )
    await expect(r.backups.eraseTask('alice')).rejects.toThrow(/archive/i)
    expect(r.storage.maintenance.secondaryConnections()).not.toEqual([])
    refuse = false
    await r.backups.eraseTask('alice')
    expect(readdirSync(r.backups.archiveDir)).toEqual([])
    expect(r.storage.maintenance.secondaryConnections()).toEqual([])
  } finally {
    refuse = false
    spy.mockRestore()
  }
})

test('erase admitted during restore waits durable publication, then erases before queued reads', async () => {
  const r = runtime()
  const backup = await r.backups.create()
  let release!: () => void, entered!: () => void
  const hold = new Promise<void>((resolve) => {
    release = resolve
  })
  const started = new Promise<void>((resolve) => {
    entered = resolve
  })
  const original = fs.promises.copyFile.bind(fs.promises)
  const copy = vi.spyOn(fs.promises, 'copyFile').mockImplementation(async (source, dest, mode) => {
    await original(source, dest, mode)
    if (String(dest).includes('/archives/.pending-')) {
      entered()
      await hold
    }
  })
  const id = randomUUID()
  const restoring = r.backups.restore(backup.id, id)
  let work: Promise<unknown>[] = [restoring]
  try {
    await started
    let erased = false
    const erasing = r.backups.eraseTask('alice').then(() => {
      erased = true
    })
    const reading = r.backups.read(id, 'alice')
    work = [restoring, erasing, reading]
    await new Promise((resolve) => setImmediate(resolve))
    expect(erased).toBe(false)
    release()
    await Promise.all(work)
    expect((await reading).events).toEqual([])
    expect((await r.backups.read(id, 'carol')).events).toHaveLength(1)
    expect(
      readFileSync(join(r.backups.dir, backup.id, 'chat.sqlite')).includes(
        Buffer.from('alice secret')
      )
    ).toBe(true)
  } finally {
    release()
    await Promise.allSettled(work)
    copy.mockRestore()
  }
})

test('concurrent different-task archive erasures, queued reads and close own the entire native rewrite', async () => {
  let entered!: () => void, release!: () => void
  const started = new Promise<void>((r) => {
    entered = r
  })
  const hold = new Promise<void>((r) => {
    release = r
  })
  let copies = 0
  const r = runtime((spec) => {
    const worker = startCompactionWorker(spec)
    if (spec.mode !== 'file' || copies++ !== 0) return worker
    return {
      ...worker,
      ready: worker.ready.then(async (value) => {
        entered()
        await hold
        return value
      })
    }
  })
  try {
    const backup = await r.backups.create()
    const archive = await r.backups.restore(backup.id)
    const a = r.backups.eraseTask('alice')
    await started
    await expect(r.backups.restore(backup.id)).rejects.toThrow(/erasure/i)
    const b = r.backups.eraseTask('bob')
    let readDone = false,
      closeDone = false
    const reading = Promise.resolve(r.backups.read(archive.id, 'bob')).then((value) => {
      readDone = true
      return value
    })
    const closing = r.backups.close().then(() => {
      closeDone = true
    })
    await new Promise((r) => setImmediate(r))
    expect(closeDone).toBe(false)
    expect(readDone).toBe(false)
    release()
    await Promise.all([a, b, closing])
    expect((await reading).events).toEqual([])
    expect(copies).toBe(2)
    const path = join(r.backups.archiveDir, archive.id)
    expect(
      files(path).filter((p) => /alice secret|bob secret/.test(readFileSync(p).toString()))
    ).toEqual([])
  } finally {
    release()
  }
})

test.each(['chat-archive-index', 'chat-archive-erasure'])(
  '%s fault discard waits for accepted archive work and physical native exit',
  async (pass) => {
    let entered!: () => void, release!: () => void
    const started = new Promise<void>((resolve) => {
      entered = resolve
    })
    const hold = new Promise<void>((resolve) => {
      release = resolve
    })
    let workerExited = false
    const r = runtime((spec) => {
      const worker = startCompactionWorker({
        ...spec,
        exit: () => {
          workerExited = true
          spec.exit()
        }
      })
      if (spec.mode !== 'file') return worker
      return {
        ...worker,
        ready: worker.ready.then(async (value) => {
          entered()
          await hold
          return value
        })
      }
    })
    const work: Promise<unknown>[] = []
    try {
      const backup = await r.backups.create()
      const archive = await r.backups.restore(backup.id)
      const path = join(r.backups.archiveDir, archive.id)
      const faults = createChatStoreFaults(r)
      for (const faultPass of [pass, 'computer.task-file-cleanup'])
        r.storage.faults.record(
          {
            pass: faultPass,
            itemKey: archive.id,
            kind: 'transient',
            error: new Error('retained archive retry fault')
          },
          Date.now()
        )
      const erasing = r.backups.eraseTask('alice')
      work.push(erasing)
      void erasing.catch(() => undefined)
      await started
      const reading = r.backups.read(archive.id, 'bob')
      work.push(reading)
      void reading.catch(() => undefined)
      let acknowledged = false
      const discarding = Promise.resolve(
        faults.discard({ source: 'ledger', pass, key: archive.id })
      ).then(() => {
        acknowledged = true
        expect(workerExited).toBe(true)
        expect(r.storage.maintenance.secondaryConnections()).toEqual([])
        expect(existsSync(path)).toBe(false)
        expect(faults.list().faults.some((f) => f.pass === pass && f.key === archive.id)).toBe(
          false
        )
      })
      work.push(discarding)
      void discarding.catch(() => undefined)
      const closing = r.backups.close()
      work.push(closing)
      void closing.catch(() => undefined)
      await new Promise((resolve) => setImmediate(resolve))
      expect(acknowledged).toBe(false)
      expect(workerExited).toBe(false)
      expect(existsSync(path)).toBe(true)
      expect(r.storage.maintenance.secondaryConnections()).toContain(`chat archive ${archive.id}`)
      expect(faults.list().faults.some((f) => f.pass === pass && f.key === archive.id)).toBe(true)
      release()
      await erasing
      expect((await reading).events).toMatchObject([{ event: { text: 'bob secret' } }])
      await discarding
      await closing
      expect(acknowledged).toBe(true)
      expect(faults.list().faults).toMatchObject([
        { pass: 'computer.task-file-cleanup', key: archive.id }
      ])
      expect(
        readFileSync(join(r.backups.dir, backup.id, 'chat.sqlite')).includes(
          Buffer.from('alice secret')
        )
      ).toBe(true)
      expect(r.storage.read('bob', -1, 10)).toMatchObject([{ event: { text: 'bob secret' } }])
    } finally {
      release()
      await Promise.allSettled(work)
    }
  }
)

test('erasure fault discard unlinks a symlinked archive entry without following it', async () => {
  const r = runtime()
  const id = randomUUID()
  const target = mkdtempSync(join(tmpdir(), 's8-archive-link-target-'))
  roots.push(target)
  writeFileSync(join(target, 'keep.txt'), 'outside')
  const link = join(r.backups.archiveDir, id)
  symlinkSync(target, link, 'dir')
  r.storage.faults.record(
    { pass: 'chat-archive-erasure', itemKey: id, kind: 'transient', error: new Error('link') },
    Date.now()
  )
  const faults = createChatStoreFaults(r)
  await faults.discard({ source: 'ledger', pass: 'chat-archive-erasure', key: id })
  expect(lstatSync(link, { throwIfNoEntry: false })).toBeUndefined()
  expect(readFileSync(join(target, 'keep.txt'), 'utf8')).toBe('outside')
  expect(faults.list().faults.some((f) => f.key === id)).toBe(false)
})

test('unknown/corrupt archive attribution fails erasure closed while other archives and live task remain usable', async () => {
  const r = runtime()
  const backup = await r.backups.create()
  const good = await r.backups.restore(backup.id)
  const corrupt = join(r.backups.archiveDir, randomUUID())
  mkdirSync(corrupt)
  writeFileSync(join(corrupt, 'chat.sqlite'), 'unattributed secret bytes')
  await expect(r.backups.eraseTask('alice')).rejects.toThrow(/archive|attribut/i)
  expect((await r.backups.read(good.id, 'carol')).events).toHaveLength(1)
  r.storage.append('carol', 1, { kind: 'assistant-text', messageId: 'live', text: 'still usable' })
  expect(r.storage.read('carol', -1)).toHaveLength(2)
})

test('undeletable residue cannot acknowledge erasure; retry removes it without deleting readable archive', async () => {
  const r = runtime()
  const backup = await r.backups.create()
  const archive = await r.backups.restore(backup.id)
  const residue = join(r.backups.archiveDir, archive.id, 'chat.sqlite.compact-obstruction')
  mkdirSync(residue)
  writeFileSync(join(residue, 'secret'), 'alice secret')
  // A compact candidate must be a file: unexpected directories are unknown damage,
  // never silently traversed or ignored as an ordinary rewrite file.
  await expect(r.backups.eraseTask('alice')).rejects.toThrow(/archive|residue|file/i)
  expect(existsSync(residue)).toBe(true)
  rmSync(residue, { recursive: true })
  await r.backups.eraseTask('alice')
  expect((await r.backups.read(archive.id, 'carol')).events).toHaveLength(1)
})

test('actual packaged owner archive SIGKILL → restart → different-task erase removes native partial copy', async () => {
  const root = mkdtempSync(join(tmpdir(), 's8-archive-crash-'))
  roots.push(root)
  const workerPath = fileURLToPath(
    new URL('../../../../apps/computer/dist/bin.cjs', import.meta.url)
  )
  const child = spawnSync(
    process.execPath,
    [
      fileURLToPath(new URL('./archive-privacy.crash.fixture.cjs', import.meta.url)),
      root,
      workerPath
    ],
    {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      encoding: 'utf8',
      timeout: 60_000
    }
  )
  expect(child.stderr).toBe('')
  expect(child.signal).toBe('SIGKILL')
  const evidence = JSON.parse(child.stdout.trim().split('\n').at(-1)!) as {
    archive: string
    backup: string
    copy: string
  }
  const r = await openComputerChatRuntime({
    stateDir: root,
    hubScope: 'hub',
    computerId: 'pc',
    workerPath,
    blobBackfill: { automatic: false },
    markerBackfill: { automatic: false }
  })
  try {
    const path = join(r.backups.archiveDir, evidence.archive)
    expect(readFileSync(join(path, evidence.copy)).includes(Buffer.from('bob crash secret'))).toBe(
      true
    )
    // Read admission performs recovery before serving the affected archive.
    expect((await r.backups.read(evidence.archive, 'carol')).events).toHaveLength(1)
    expect(existsSync(join(path, evidence.copy))).toBe(false)
    await expect(r.eraseTask('bob', 2)).resolves.toMatchObject({ erased: true })
    expect(
      files(r.storage.dir).filter(
        (p) => !p.includes('/backups/') && readFileSync(p).includes(Buffer.from('bob crash secret'))
      )
    ).toEqual([])
    expect((await r.backups.read(evidence.archive, 'carol')).events).toHaveLength(1)
    expect((await r.backups.read(evidence.archive, 'alice')).events).toEqual([])
    expect(
      readFileSync(join(r.backups.dir, evidence.backup, 'chat.sqlite')).includes(
        Buffer.from('bob crash secret')
      )
    ).toBe(true)
  } finally {
    await r.close()
  }
})
