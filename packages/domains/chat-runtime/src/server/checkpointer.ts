/**
 * The chat stores' WAL syncs and checkpoints, off the computer's main thread (fu-2 S5).
 *
 * A store's own connection commits with `synchronous = NORMAL` and never checkpoints
 * (`wal_autocheckpoint = 0`). WAL restart still syncs a header on that writer; the
 * new storage owner moves the writer off main and uses FULL marker commits for acks.
 * Under
 * disk contention one FULL commit held the main thread 32 s (FU4) — longer than the
 * hub's heartbeat timeout. This worker, one per process for every store, holds a second
 * connection per store and:
 *   - every `intervalMs` (1 s) fsyncs the store's WAL and runs a PASSIVE checkpoint
 *     (never blocks a writer; the main connection resets the WAL on a later write, and
 *     `journal_size_limit` caps it) — commits are durable within about a second;
 *   - on `sync` fsyncs the WAL now (legacy storage.flush only; owner fences never
 *     depend on the checkpointer's raw file descriptor);
 *   - on `close` (final) runs a TRUNCATE checkpoint and closes: a normal quit loses nothing.
 * A process crash loses nothing either way (the WAL is in the OS cache); only an OS
 * crash or power loss can lose the commits of the last second.
 *
 * Plain JavaScript run with `eval: true`, like the compaction worker.
 */
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'

export const CHECKPOINTER_SOURCE = `
'use strict'
const { parentPort, workerData } = require('node:worker_threads')
const Database = require(workerData.modulePath)
const fs = require('node:fs')
const stores = new Map()
const reply = (req, body) => parentPort.postMessage({ t: 'reply', req, ...body })
const describe = (error) => String((error && error.message) || error)
function syncWal(s) {
  if (s.walFd === null) {
    try {
      s.walFd = fs.openSync(s.path + '-wal', 'r+')
    } catch (error) {
      if (error && error.code === 'ENOENT') return // no WAL yet: nothing committed since open
      throw error
    }
  }
  fs.fsyncSync(s.walFd)
}
function checkpoint(s, mode) {
  const [row] = s.db.pragma('wal_checkpoint(' + mode + ')')
  return { busy: row.busy, log: row.log, checkpointed: row.checkpointed }
}
function tick(s) {
  try {
    syncWal(s)
    checkpoint(s, 'PASSIVE')
  } catch (error) {
    // Retire this registration before main can retry or swap the file. A cleanup
    // failure instead kills the helper; its exit releases every native handle.
    close(s, false)
    parentPort.postMessage({ t: 'failed', id: s.id, message: describe(error) })
  }
}
function close(s, final) {
  clearInterval(s.timer)
  let failure
  try {
    if (final) {
      s.db.pragma('busy_timeout = 5000')
      checkpoint(s, 'TRUNCATE')
    }
  } catch (error) {
    failure = error
  }
  const cleanup = []
  try { if (s.walFd !== null) fs.closeSync(s.walFd) } catch (error) { cleanup.push(error) }
  try { s.db.close() } catch (error) { cleanup.push(error) }
  if (cleanup.length) throw Object.assign(
    new AggregateError([...(failure ? [failure] : []), ...cleanup], 'checkpointer cleanup failed'),
    { retire: true }
  )
  stores.delete(s.id)
  if (failure) throw failure
}
parentPort.on('message', (m) => {
  const s = stores.get(m.id)
  try {
    if (m.t === 'open') {
      if (s) throw new Error('checkpointer already open')
      const db = new Database(m.path, { fileMustExist: true })
      // Checkpoints sync the WAL before copying it and the database after: here, not
      // on the store's own thread. PASSIVE never waits for (or blocks) a writer.
      try {
        db.pragma('synchronous = NORMAL')
        db.pragma('busy_timeout = 0')
      } catch (error) {
        try { db.close() } catch (cleanup) {
          throw Object.assign(new AggregateError([error, cleanup], 'checkpointer cleanup failed'), { retire: true })
        }
        throw error
      }
      const entry = { id: m.id, path: m.path, db, walFd: null, timer: null }
      entry.timer = setInterval(() => tick(entry), m.intervalMs)
      stores.set(m.id, entry)
      reply(m.req, { ok: true })
    } else if (!s) reply(m.req, { ok: false, message: 'checkpointer not open' })
    else if (m.t === 'sync') {
      syncWal(s)
      reply(m.req, { ok: true })
    } else if (m.t === 'checkpoint') {
      syncWal(s)
      reply(m.req, { ok: true, result: checkpoint(s, 'PASSIVE') })
    } else if (m.t === 'close') {
      close(s, m.final)
      reply(m.req, { ok: true })
    }
  } catch (error) {
    // No failure acknowledgement before native resources are physically released.
    if (error && error.retire) throw error
    reply(m.req, { ok: false, message: describe(error) })
  } finally {
    // A synchronous close waits on this flag (the store's own close).
    if (m.flag) {
      const done = new Int32Array(m.flag)
      Atomics.store(done, 0, 1)
      Atomics.notify(done, 0)
    }
  }
})
`

export interface CheckpointResult {
  /** 1 when the checkpoint could not run at all (another checkpoint, or a lock). */
  busy: number
  /** WAL frames. */
  log: number
  /** Frames copied into the database so far (all of them = `log`). */
  checkpointed: number
}

/** better-sqlite3's entry, loaded by path in the eval worker. */
function sqliteModulePath(): string {
  if (typeof require === 'function') return require.resolve('better-sqlite3')
  let lastError: unknown
  for (const from of [process.argv[1], join(process.cwd(), 'index.js')])
    if (from)
      try {
        return createRequire(from).resolve('better-sqlite3')
      } catch (error) {
        lastError = error
      }
  throw lastError
}

type Reply = { ok: boolean; message?: string; result?: CheckpointResult }
let shared: {
  worker: Worker
  next: number
  pending: Map<number, { resolve(r: Reply): void }>
  failed: Map<string, (message: string) => void>
} | null = null

/** The process's one checkpointer thread (started on first use; never holds the process open). */
function thread() {
  if (shared) return shared
  const worker = new Worker(CHECKPOINTER_SOURCE, {
    eval: true,
    workerData: { modulePath: sqliteModulePath() }
  })
  worker.unref()
  const state = {
    worker,
    next: 1,
    pending: new Map<number, { resolve(r: Reply): void }>(),
    failed: new Map<string, (message: string) => void>()
  }
  worker.on(
    'message',
    (m: ({ t: 'reply'; req: number } & Reply) | { t: 'failed'; id: string; message: string }) => {
      if (m.t === 'failed') state.failed.get(m.id)?.(m.message)
      else {
        state.pending.get(m.req)?.resolve(m)
        state.pending.delete(m.req)
      }
    }
  )
  const lost = (message: string) => {
    if (shared === state) shared = null
    for (const p of state.pending.values()) p.resolve({ ok: false, message })
    state.pending.clear()
    for (const fail of state.failed.values()) fail(message)
  }
  let failure: string | undefined
  worker.on('error', (error) => {
    failure = `checkpointer failed: ${error.message}`
  })
  // An error notification precedes exit. Keep ownership/pending calls until all
  // native file handles have actually gone, then permit a replacement generation.
  worker.on('exit', () => lost(failure ?? 'checkpointer stopped'))
  shared = state
  return state
}
function call(body: Record<string, unknown>): Promise<Reply> {
  const t = thread()
  const req = t.next++
  return new Promise((resolve) => {
    t.pending.set(req, { resolve })
    // Keep the process up only while a caller waits on the thread.
    t.worker.ref()
    t.worker.postMessage({ ...body, req })
  }).then((reply) => {
    if (t.pending.size === 0) t.worker.unref()
    return reply as Reply
  })
}

export interface StoreCheckpointer {
  /** Committed data is on disk once this resolves (the WAL fsynced off-thread). */
  flush(): Promise<void>
  /** A PASSIVE checkpoint now (and a WAL sync); not complete while a reader holds old frames. */
  checkpoint(): Promise<CheckpointResult>
  /** Close its connection (after a sync); `final` first truncates the WAL. Resolves when closed. */
  close(final: boolean): Promise<void>
  /**
   * Close its connection and wait for that on this thread (at most `timeoutMs`): the
   * store's own close, so its files are free when that returns. Rare; never in a
   * request.
   */
  closeSync(timeoutMs?: number): void
  /** Open again on the store's current file (after a swap). */
  open(): Promise<void>
  /** Whether its connection is open (or opening). */
  readonly active: boolean
}

let ids = 0
/**
 * A store's checkpointer. `onFailure`: the thread cannot sync this store (it died, or a
 * sync failed): the store must make its own commits durable again.
 */
export function attachCheckpointer(
  path: string,
  opts: { intervalMs?: number; onFailure(message: string): void }
): StoreCheckpointer {
  const id = `store-${process.pid}-${++ids}`
  const intervalMs = opts.intervalMs ?? 1000
  let active = false
  let opening: Promise<void> | null = null
  const expect = async (body: Record<string, unknown>) => {
    const reply = await call({ ...body, id })
    if (!reply.ok) throw new Error(reply.message ?? 'checkpointer failed')
    return reply
  }
  const open = () => {
    if (active) return opening ?? Promise.resolve()
    active = true
    thread().failed.set(id, (message) => {
      active = false
      opts.onFailure(message)
    })
    opening = expect({ t: 'open', path, intervalMs })
      .then(() => undefined)
      .catch((error: unknown) => {
        active = false
        opts.onFailure(error instanceof Error ? error.message : String(error))
      })
    return opening
  }
  return {
    get active() {
      return active
    },
    open,
    async flush() {
      if (!active) throw new Error('The chat store checkpointer is not running')
      await opening
      await expect({ t: 'sync' })
    },
    async checkpoint() {
      await opening
      return (await expect({ t: 'checkpoint' })).result!
    },
    async close(final) {
      if (!active) return
      await opening
      if (!active) return
      active = false
      shared?.failed.delete(id)
      await expect({ t: 'close', final })
    },
    closeSync(timeoutMs = 5000) {
      if (!active || !shared) return
      active = false
      shared.failed.delete(id)
      const flag = new SharedArrayBuffer(4)
      // Messages run in order: an open still in flight is handled first.
      shared.worker.postMessage({ t: 'close', id, final: false, req: 0, flag })
      Atomics.wait(new Int32Array(flag), 0, 0, timeoutMs)
    }
  }
}

/** Tests: the thread dies (as on a crash of its own); stores fall back to FULL commits. */
export async function killCheckpointerThreadForTests(): Promise<void> {
  const current = shared
  if (current) await current.worker.terminate()
}
