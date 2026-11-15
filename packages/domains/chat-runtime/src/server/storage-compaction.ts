/**
 * Chat storage compaction (fu-2): returns the free pages of `chat.sqlite` to the disk
 * without ever blocking the computer's event loop for long. Opt-in: a user starts it;
 * the only automatic part is the cheap reclaim of a store the user already switched.
 *
 * `auto_vacuum` was NONE, so freed pages (the event-blob backfill frees ~97 % of a
 * screenshot-heavy store) stay in the file — and in every `db.backup()` copy. Turning
 * on incremental auto-vacuum needs a full rebuild, and an in-place VACUUM holds the
 * write lock for its whole run (measured: 5.2 s frozen, a write failed). So:
 *
 * REBUILD (once, store at auto_vacuum NONE):
 *   1. capture — TEMP triggers on every main table record each changed primary key
 *      (`temp.compaction_dirty`); connection-local, so a crash or the swap drops them.
 *      Installed BEFORE the copy's snapshot: every later change is captured.
 *   2. copy    — a worker builds a fresh copy (incremental auto-vacuum, the live schema
 *      without its triggers) from its own read-only connection, table by table in
 *      key order, in throttled batches (fsync + pause every few MiB): the disk never
 *      queues much of our data ahead of a live commit. (`VACUUM INTO` was one
 *      unthrottleable burst: a live commit waited 4.7 s behind it.)
 *   3. rounds  — drained keys go to the worker, which copies each key's current row;
 *      until what is left fits the window budget (keys, bytes), else "busy" (failed,
 *      live untouched). The hold is never stretched to make it fit.
 *   4. window  — ONE synchronous block: drain the rest, replay it into the copy,
 *      restore the copy's triggers verbatim, require identical schemas, commit with
 *      fsync; then `storage.maintenance.swapIn` (refused while a backup lease or a
 *      secondary connection is held: then it waits). Writes arriving meanwhile wait
 *      on the event loop and land in the new file. The store's handle follows.
 * RECLAIM (store already incremental): `incremental_vacuum` slices with pauses.
 *
 * Refused: while the event-blob backfill still runs (it frees more), with too little
 * disk (the copy needs the live data size), with nothing to reclaim. Stopped (copy
 * deleted, live untouched) by cancel, close, or `abort` — content erasure aborts it:
 * the copy was taken from a snapshot that still held the erased content.
 */
import { closeSync, existsSync, fsyncSync, openSync, renameSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { Worker } from 'node:worker_threads'
import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import type {
  ComputerChatStorageJob,
  ComputerChatStorageResult,
  ComputerChatStorageState
} from '@slayzone/terminal-contracts'
import { COMPACTION_WORKER_SOURCE } from './compaction-worker'
import { freeDiskBytes } from './disk-space'
import { ChatStorageSwapRefused, type ChatStorage, type ChatSwapPhase } from './storage'

const MiB = 1024 * 1024
const GiB = 1024 * MiB
/** The last successful job (`maintenance_cursors`). */
const LAST = 'storage-compaction-v1:last'
const READER = 'storage compaction reader'
/** Primary-key columns a captured key can hold. */
const MAX_PK = 4

export type StorageCompactionHook =
  | 'worker-started'
  | 'copy-synced'
  | 'copied'
  | 'budget'
  | 'round'
  | 'waiting'
  | 'window'
  | 'slice'
  | ChatSwapPhase

export interface StorageCompactionOptions {
  storage: ChatStorage
  /** The event-blob backfill finished (a rebuild waits for it). */
  backfillDone(): boolean
  /** Free bytes on the store's disk. Default: statfs of the store dir. */
  freeBytes?(): number
  /** Computer log line (sizes and durations, never content). Default: console. */
  log?(line: string): void
  /** Reclaim on its own, only on stores already incremental. Default true. */
  automaticReclaim?: boolean
  /** How often the automatic reclaim looks (ms). Default 10 min. */
  reclaimCheckMs?: number
  /** Free space an incremental store must hold before it is offered / auto-reclaimed. Default 64 MiB. */
  reclaimThresholdBytes?: number
  /** Free space a rebuild must return to be offered. Default 256 MiB. */
  rebuildOfferBytes?: number
  /** Pages per reclaim slice (≈25 µs each). Default 1024. */
  slicePages?: number
  /** Pause between slices / while waiting (ms). Default 80. */
  idleMs?: number
  /** Window budget: captured keys left. Default 256. */
  finalKeys?: number
  /** Window budget: bytes of the rows left. Default 4 MiB. */
  finalBytes?: number
  /** Catch-up rounds before giving up ("busy"). Default 20. */
  maxRounds?: number
  /**
   * The copy's write throttle: rows go in transactions of `copyBatchBytes`; every
   * `copySyncBytes` the copy is fsynced and the worker pauses `copyPauseMs`, so the
   * disk never holds more than that of our unwritten data ahead of a live commit.
   * Defaults 4 MiB / 16 MiB / 25 ms.
   */
  copyBatchBytes?: number
  copySyncBytes?: number
  copyPauseMs?: number
  sleep?(ms: number): Promise<void>
  now?(): number
  /** Test hook at each step (fault and crash injection). */
  onPhase?(phase: StorageCompactionHook): void
}

/** A start the user gets a reason for (shown as is). */
export class ChatCompactionRefused extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ChatCompactionRefused'
  }
}
class Stopped extends Error {}

interface TableInfo {
  name: string
  cols: string[]
  pk: string[]
  /** Copied in primary-key order (no rowid to page by). */
  withoutRowid: boolean
}
type Key = [string, ...unknown[]]

const ident = (name: string) => `"${name.replace(/"/g, '""')}"`
const formatBytes = (bytes: number) =>
  bytes >= GiB ? `${(bytes / GiB).toFixed(2)} GiB` : `${(bytes / MiB).toFixed(1)} MiB`

/** better-sqlite3's entry, for the worker (loaded by path in an eval worker). */
function sqliteModulePath(): string {
  // The computer's CJS bundle: better-sqlite3 is external, resolved like the store's.
  if (typeof require === 'function') return require.resolve('better-sqlite3')
  // Unbundled ESM (tests, tsx): from the entry script, else the working directory.
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

export function createStorageCompaction(opts: StorageCompactionOptions) {
  const store = opts.storage
  const log = opts.log ?? ((line: string) => console.log(line))
  const now = opts.now ?? Date.now
  const idleMs = opts.idleMs ?? 80
  const slicePages = opts.slicePages ?? 1024
  const finalKeys = opts.finalKeys ?? 256
  const finalBytes = opts.finalBytes ?? 4 * MiB
  const maxRounds = opts.maxRounds ?? 20
  const copyBatchBytes = opts.copyBatchBytes ?? 4 * MiB
  const copySyncBytes = opts.copySyncBytes ?? 16 * MiB
  const copyPauseMs = opts.copyPauseMs ?? 25
  const reclaimThreshold = opts.reclaimThresholdBytes ?? 64 * MiB
  const rebuildOffer = opts.rebuildOfferBytes ?? 256 * MiB
  const freeBytes = opts.freeBytes ?? (() => freeDiskBytes(store.dir))
  const hook = (phase: StorageCompactionHook) => opts.onPhase?.(phase)
  const db = store.compose((raw) => raw)

  const sleepers = new Set<() => void>()
  const sleep =
    opts.sleep ??
    ((ms: number) =>
      new Promise<void>((resolve) => {
        const wake = () => {
          clearTimeout(timer)
          sleepers.delete(wake)
          resolve()
        }
        const timer = setTimeout(wake, ms)
        sleepers.add(wake)
      }))

  let closed = false
  let job: ComputerChatStorageJob | null = null
  let running: Promise<void> | null = null
  let stop: { reason: string; phase: 'cancelled' } | null = null
  // Settles when the current job is told to stop: awaits on the worker race it, so a
  // stop never waits for the worker's current step.
  let stopSignal = deferred()
  let reclaimTimer: ReturnType<typeof setInterval> | null = null
  let firstCheck: ReturnType<typeof setTimeout> | null = null

  function stats() {
    const s = store.maintenance.fileStats()
    const liveBytes = (s.pageCount - s.freePages) * s.pageSize
    const reclaimableBytes = s.freePages * s.pageSize
    const incremental = s.autoVacuum === 2
    return {
      ...s,
      liveBytes,
      reclaimableBytes,
      incremental,
      requiredDiskBytes: incremental ? 0 : Math.ceil(liveBytes * 1.1) + GiB
    }
  }
  const last = () => store.maintenanceCursor<ComputerChatStorageResult>(LAST)

  function status(): ComputerChatStorageState {
    const s = stats()
    return {
      supported: true,
      fileBytes: s.fileBytes,
      walBytes: s.walBytes,
      liveBytes: s.liveBytes,
      reclaimableBytes: s.reclaimableBytes,
      autoVacuum: s.autoVacuum === 2 ? 'incremental' : s.autoVacuum === 1 ? 'full' : 'none',
      worthIt: s.incremental
        ? s.reclaimableBytes >= reclaimThreshold
        : s.reclaimableBytes >= rebuildOffer && s.reclaimableBytes >= 0.2 * s.fileBytes,
      backfillDone: opts.backfillDone(),
      freeDiskBytes: freeBytes(),
      requiredDiskBytes: s.requiredDiskBytes,
      job: job ? { ...job } : null,
      last: last()
    }
  }

  /**
   * `forced` (content erasure): a rebuild whatever the store's mode, backfill or free
   * space — only the whole-file rewrite removes stale copies of erased content.
   */
  function start(automatic = false, forced = false): ComputerChatStorageJob {
    if (closed) throw new ChatCompactionRefused('Chat storage is closing')
    if (!forced && erasurePending())
      throw new ChatCompactionRefused(
        'A content erasure is rewriting the chat store; try again when it finishes'
      )
    if (running) throw new ChatCompactionRefused('A chat storage compaction is already running')
    const s = stats()
    const kind = forced || !s.incremental ? 'rebuild' : 'reclaim'
    if (!forced && s.incremental && s.freePages === 0)
      throw new ChatCompactionRefused('Nothing to reclaim')
    if (kind === 'rebuild') {
      if (!forced && !opts.backfillDone())
        throw new ChatCompactionRefused(
          'The image backfill is still moving screenshots out of chat history; try again when it finishes'
        )
      const required = Math.ceil(s.liveBytes * 1.1) + GiB
      const free = freeBytes()
      if (free < required)
        throw new ChatCompactionRefused(
          `Not enough free disk space: needs ${formatBytes(required)}, ${formatBytes(free)} available`
        )
    }
    stop = null
    stopSignal = deferred()
    job = {
      id: randomUUID(),
      kind,
      automatic,
      phase: kind === 'rebuild' ? 'copying' : 'reclaiming',
      startedAt: now(),
      progress: 0,
      message: null,
      result: null
    }
    const current = job
    log(
      `[chat-compaction] ${current.kind} ${automatic ? '(automatic) ' : ''}starting: file ${formatBytes(s.fileBytes)}, reclaimable ${formatBytes(s.reclaimableBytes)}`
    )
    const started = performance.now()
    running = (current.kind === 'rebuild' ? rebuild(current, s.liveBytes) : reclaim(current))
      .then((holdMs) => {
        const after = stats()
        const result: ComputerChatStorageResult = {
          at: now(),
          kind: current.kind,
          beforeBytes: s.fileBytes,
          afterBytes: after.fileBytes,
          reclaimedBytes: Math.max(0, s.fileBytes - after.fileBytes),
          durationMs: Math.round(performance.now() - started),
          holdMs
        }
        store.setMaintenanceCursor(LAST, result)
        Object.assign(current, { phase: 'done', progress: 1, result, message: null })
        log(
          `[chat-compaction] ${current.kind} done: ${formatBytes(result.beforeBytes)} → ${formatBytes(result.afterBytes)} in ${result.durationMs} ms${holdMs === null ? '' : `, writes held ${holdMs.toFixed(0)} ms`}`
        )
      })
      .catch((error: unknown) => {
        if (error instanceof Stopped || stop) {
          Object.assign(current, { phase: 'cancelled', message: stop?.reason ?? 'Cancelled' })
          log(`[chat-compaction] ${current.kind} stopped: ${current.message}`)
        } else {
          const message = error instanceof Error ? error.message : String(error)
          Object.assign(current, { phase: 'failed', message })
          log(`[chat-compaction] ${current.kind} failed: ${message}`)
        }
      })
      .finally(() => {
        running = null
      })
    return { ...current }
  }

  const checkStop = () => {
    if (stop || closed) throw new Stopped()
  }
  /** `work`, unless the job is stopped first. */
  function until<T>(work: Promise<T>): Promise<T> {
    work.catch(() => undefined)
    return Promise.race([
      work,
      stopSignal.promise.then(() => {
        throw new Stopped()
      })
    ])
  }

  /** Incremental store: return the free pages in short slices. */
  async function reclaim(current: ComputerChatStorageJob): Promise<null> {
    const total = Math.max(1, stats().freePages)
    for (;;) {
      checkStop()
      hook('slice')
      db.pragma(`incremental_vacuum(${slicePages})`)
      const free = store.maintenance.fileStats().freePages
      current.progress = Math.min(0.99, 1 - free / total)
      if (free === 0) break
      await sleep(idleMs)
    }
    // The file shrinks when a checkpoint copies the moved pages back: off this thread.
    await store.maintenance.checkpointNow()
    return null
  }

  // ── rebuild ────────────────────────────────────────────────────────────────
  function installCapture(tables: TableInfo[]): string[] {
    const triggers: string[] = []
    db.exec(
      'CREATE TEMP TABLE IF NOT EXISTS compaction_dirty(tbl TEXT NOT NULL, kq TEXT NOT NULL, k1, k2, k3, k4, PRIMARY KEY(tbl, kq)) WITHOUT ROWID'
    )
    tables.forEach((t, i) => {
      const row = (ref: 'NEW' | 'OLD') => {
        if (!t.pk.length) return `(${sqlString(t.name)}, '*', NULL, NULL, NULL, NULL)`
        const cols = t.pk.map((c) => `${ref}.${ident(c)}`)
        const filler = Array.from({ length: MAX_PK - cols.length }, () => 'NULL')
        return `(${sqlString(t.name)}, ${cols.map((c) => `quote(${c})`).join(" || ',' || ")}, ${[...cols, ...filler].join(', ')})`
      }
      // Guarded, not OR IGNORE: an outer statement's conflict policy (an UPSERT's)
      // overrides the one written in a trigger body.
      const insert = (rows: string[]) =>
        rows
          .map(
            (r) =>
              `INSERT INTO temp.compaction_dirty SELECT * FROM (VALUES ${r}) AS k WHERE NOT EXISTS (SELECT 1 FROM temp.compaction_dirty d WHERE d.tbl = k.column1 AND d.kq = k.column2);`
          )
          .join(' ')
      for (const [event, rows] of [
        ['INSERT', [row('NEW')]],
        ['UPDATE', [row('OLD'), row('NEW')]],
        ['DELETE', [row('OLD')]]
      ] as const) {
        const name = `compaction_capture_${i}_${event.toLowerCase()}`
        db.exec(
          `CREATE TEMP TRIGGER ${name} AFTER ${event} ON main.${ident(t.name)} BEGIN ${insert([...rows])} END`
        )
        triggers.push(name)
      }
    })
    return triggers
  }
  function dropCapture(triggers: string[]) {
    for (const name of triggers) db.exec(`DROP TRIGGER IF EXISTS temp.${name}`)
    db.exec('DROP TABLE IF EXISTS temp.compaction_dirty')
  }
  function pendingKeys(): Key[] {
    return (
      db
        .prepare('SELECT tbl, k1, k2, k3, k4 FROM temp.compaction_dirty')
        .raw(true)
        .safeIntegers(true)
        .all() as Key[]
    ).map((k) => k)
  }
  function drain(): Key[] {
    const keys = pendingKeys()
    db.prepare('DELETE FROM temp.compaction_dirty').run()
    return keys
  }
  /** Within the window budget? (count first, then the rows' bytes, read cheaply.) */
  function fits(tables: Map<string, TableInfo>): boolean {
    const count = (
      db.prepare('SELECT count(*) n FROM temp.compaction_dirty').get() as { n: number }
    ).n
    if (count > finalKeys) return false
    let bytes = 0
    for (const key of pendingKeys()) {
      const t = tables.get(key[0] as string)
      if (!t) return false
      bytes += rowBytes(t, key)
      if (bytes > finalBytes) return false
    }
    return true
  }
  function rowBytes(t: TableInfo, key: Key): number {
    const size = t.cols.map((c) => `coalesce(octet_length(${ident(c)}), 0)`).join(' + ')
    if (!t.pk.length)
      return (
        (
          db.prepare(`SELECT sum(${size}) n FROM main.${ident(t.name)}`).get() as {
            n: number | null
          }
        ).n ?? 0
      )
    const where = t.pk.map((c) => `${ident(c)} IS ?`).join(' AND ')
    return (
      (
        db
          .prepare(`SELECT ${size} n FROM main.${ident(t.name)} WHERE ${where}`)
          .get(...key.slice(1, 1 + t.pk.length)) as { n: number } | undefined
      )?.n ?? 0
    )
  }
  /** The window's replay: the rest of the delta, the copy's triggers, schema equality. */
  function applyFinal(
    out: string,
    tables: Map<string, TableInfo>,
    keys: Key[],
    triggers: Array<{ name: string; sql: string }>
  ) {
    // ATTACH creates a missing file: never attach anything but the finished copy.
    if (!existsSync(out)) throw new Error('The compacted copy is missing')
    db.prepare('ATTACH ? AS compaction').run(out)
    try {
      // Load the attached schema now: before that, SQLite does not resolve
      // `compaction.sqlite_sequence` (an empty delta touches it first).
      db.prepare('SELECT count(*) FROM compaction.sqlite_master').get()
      db.pragma('compaction.synchronous = FULL')
      db.pragma('foreign_keys = OFF')
      try {
        db.transaction(() => {
          const whole = new Set<string>()
          for (const key of keys) {
            const t = tables.get(key[0] as string)
            if (!t) throw new Error('Unknown table in compaction delta')
            if (!t.pk.length) {
              whole.add(t.name)
              continue
            }
            const values = key.slice(1, 1 + t.pk.length)
            const where = t.pk.map((c) => `${ident(c)} IS ?`).join(' AND ')
            const cols = t.cols.map(ident).join(', ')
            db.prepare(`DELETE FROM compaction.${ident(t.name)} WHERE ${where}`).run(...values)
            db.prepare(
              `INSERT OR REPLACE INTO compaction.${ident(t.name)}(${cols}) SELECT ${cols} FROM main.${ident(t.name)} WHERE ${where}`
            ).run(...values)
          }
          const sequence = db
            .prepare("SELECT 1 FROM main.sqlite_master WHERE name='sqlite_sequence'")
            .get()
          if (sequence) whole.add('sqlite_sequence')
          for (const name of whole) {
            db.prepare(`DELETE FROM compaction.${ident(name)}`).run()
            db.prepare(
              `INSERT INTO compaction.${ident(name)} SELECT * FROM main.${ident(name)}`
            ).run()
          }
          for (const t of triggers)
            db.exec(t.sql.replace(/^CREATE TRIGGER /, 'CREATE TRIGGER compaction.'))
          const schema = (s: string) =>
            JSON.stringify(
              db
                .prepare(
                  `SELECT type, name, tbl_name, sql FROM ${s}.sqlite_master ORDER BY type, name`
                )
                .all()
            )
          if (schema('main') !== schema('compaction'))
            throw new Error('The compacted copy does not match the live schema')
        })()
      } finally {
        db.pragma('foreign_keys = ON')
      }
    } finally {
      db.exec('DETACH compaction')
    }
  }

  /** The worker on the live store; `on.exit` runs when its thread really ended. */
  function spawnWorker(
    mode: 'build' | 'resume',
    out: string,
    tables: TableInfo[],
    on: { exit(): void; progress(bytes: number): void }
  ): WorkerHandle {
    return startCompactionWorker({
      mode,
      live: store.path,
      out,
      tables,
      throttle: { batchBytes: copyBatchBytes, syncBytes: copySyncBytes, pauseMs: copyPauseMs },
      registration: store.maintenance.registerSecondary(READER),
      ...on
    })
  }

  /** A backup streams from, or another connection reads, the live file: no swap now. */
  const blocked = () => store.hasBlobLeases() || store.maintenance.secondaryConnections().length > 0

  async function rebuild(current: ComputerChatStorageJob, liveBytes: number): Promise<number> {
    const out = store.maintenance.tempPath()
    const list = describeTables(db)
    const tables = new Map(list.map((t) => [t.name, t]))
    const schemaVersion = db.pragma('schema_version', { simple: true })
    let capture: string[] = installCapture(list)
    let worker: WorkerHandle | null = null
    let triggers: Array<{ name: string; sql: string }> = []
    let swapped = false
    /** The checkpointer is paused for the window: resumed on every way out. */
    let paused = false
    const resume = () => {
      if (!paused) return
      paused = false
      store.maintenance.resumeCheckpointer()
    }
    // Set when the job ends without a swap: only then is the copy garbage.
    let abandoned = false
    let workerAlive = false
    const discard = () => {
      for (const suffix of ['', '-journal', '-wal', '-shm'])
        try {
          rmSync(`${out}${suffix}`, { force: true })
        } catch {
          // Still open (Windows): removed when the worker exits, or at the next boot.
        }
    }
    const spawn = (mode: 'build' | 'resume') => {
      workerAlive = true
      return spawnWorker(mode, out, list, {
        exit() {
          workerAlive = false
          if (abandoned) discard()
        },
        progress(bytes) {
          if (current.phase === 'copying')
            current.progress = Math.max(
              0.01,
              Math.min(0.85, (0.85 * bytes) / Math.max(1, liveBytes))
            )
          hook('copy-synced')
        }
      })
    }
    try {
      worker = spawn('build')
      hook('worker-started')
      triggers = await until(worker.ready)
      hook('copied')
      checkStop()
      Object.assign(current, { phase: 'catching-up', progress: 0.85 })
      let rounds = 0
      let checked = false
      const round = async (w: WorkerHandle) => {
        if (++rounds > maxRounds)
          throw new Error('The computer is too busy writing chat history; try again later')
        await until(w.copy(list, drain()))
        hook('round')
        current.progress = Math.min(0.95, 0.85 + rounds * 0.01)
        checkStop()
      }
      for (;;) {
        checkStop()
        if (worker) {
          hook('budget')
          if (!fits(tables)) {
            await round(worker)
            continue
          }
          const check = await until(worker.finish(!checked))
          worker = null
          if (check !== 'ok') throw new Error(`The compacted copy failed its check (${check})`)
          checked = true
          checkStop()
        }
        if (blocked()) {
          current.message = 'Waiting for a backup or export to finish'
          hook('waiting')
          await sleep(idleMs)
          continue
        }
        current.message = null
        // The checkpointer empties the live WAL and closes its connection (it must not
        // hold the file across the swap): closing the live connection in the window then
        // has nothing to checkpoint on this thread.
        paused = true
        await until(store.maintenance.pauseCheckpointer())
        if (blocked()) {
          resume()
          continue
        }
        if (!fits(tables)) {
          resume()
          worker = spawn('resume')
          await until(worker.ready)
          continue
        }
        // ── the window: synchronous from here to the swap ──
        hook('window')
        Object.assign(current, { phase: 'swapping', progress: 0.97 })
        const held = performance.now()
        const keys = drain()
        if (db.pragma('schema_version', { simple: true }) !== schemaVersion)
          throw new Error('The chat store schema changed during compaction; start again')
        applyFinal(out, tables, keys, triggers)
        const replayed = performance.now()
        try {
          store.maintenance.swapIn(out, { phase: hook })
        } catch (error) {
          // A transient refusal (the live connection busy): the copy holds the replayed
          // delta and capture still runs — try again shortly.
          if (!(error instanceof ChatStorageSwapRefused) || !error.transient) throw error
          resume()
          current.message = 'Waiting for the chat store to be idle'
          hook('waiting')
          await sleep(idleMs)
          continue
        }
        swapped = true
        capture = []
        const holdMs = performance.now() - held
        resume()
        log(
          `[chat-compaction] window: ${keys.length} changed rows replayed in ${(replayed - held).toFixed(0)} ms, swap ${(performance.now() - replayed).toFixed(0)} ms`
        )
        store.checkpoint()
        return holdMs
      }
    } finally {
      resume()
      if (worker) {
        const exit = worker.terminate()
        // Between messages it exits at once: wait, so the copy is gone when the job
        // settles. Inside quick_check it cannot: its exit removes it.
        if (!worker.busyNative()) await exit
      }
      if (!swapped) {
        abandoned = true
        dropCapture(capture)
        // A worker still inside quick_check holds the copy: its exit
        // removes it then (and boot removes any `compact-*` left by a kill).
        if (!workerAlive) discard()
      }
    }
  }

  // ── content erasure ──────────────────────────────────────────────────────
  // An erasure is done only after a rebuild that STARTED after its deletions finished.
  // Requests coalesce: a newer one stops a rebuild in flight (its copy predates the
  // newer deletions) and one restarted rebuild satisfies every request before it.
  let erasureWanted = 0
  let erasureDone = 0
  let erasureChain: Promise<void> = Promise.resolve()
  function erasurePending() {
    return erasureDone < erasureWanted
  }
  function rebuildForErasure(): Promise<void> {
    const need = ++erasureWanted
    halt('Content was erased during compaction; start again')
    const step = erasureChain.then(async () => {
      while (erasureDone < need) {
        if (closed) throw new Error('Chat storage is closing')
        await running?.catch(() => undefined)
        const gen = erasureWanted
        const started = start(true, true)
        await running?.catch(() => undefined)
        const ended = job?.id === started.id ? job : null
        if (ended?.phase === 'done') erasureDone = Math.max(erasureDone, gen)
        else if (ended?.phase === 'failed') throw new Error(ended.message ?? 'Compaction failed')
        // Cancelled: a newer erasure (run again) or closing (throws above).
      }
    })
    erasureChain = step.catch(() => undefined)
    return step
  }

  function checkReclaim(): boolean {
    if (closed || running || erasurePending() || opts.automaticReclaim === false) return false
    const s = stats()
    if (!s.incremental || s.reclaimableBytes < reclaimThreshold) return false
    if (s.reclaimableBytes < 0.1 * s.fileBytes) return false
    start(true)
    return true
  }
  if (opts.automaticReclaim !== false) {
    const every = opts.reclaimCheckMs ?? 600_000
    firstCheck = setTimeout(() => checkReclaim(), Math.min(every, 60_000))
    firstCheck.unref?.()
    reclaimTimer = setInterval(() => checkReclaim(), every)
    reclaimTimer.unref?.()
  }

  function halt(reason: string) {
    if (!running) return
    stop = { reason, phase: 'cancelled' }
    stopSignal.resolve()
    for (const wake of [...sleepers]) wake()
  }

  return {
    status,
    /** User start: a rebuild, or a reclaim on an incremental store. Throws {@link ChatCompactionRefused}. */
    start: () => start(false),
    cancel: () => halt('Cancelled'),
    /** Stop with a reason (content erasure: the copy holds what was erased). */
    abort: (reason: string) => halt(reason),
    /** Automatic reclaim check (incremental stores only); true when it started one. */
    checkReclaim,
    /**
     * Content erasure: resolves once a whole-file rewrite that started after this call
     * completed (stale copies of what the caller deleted are gone). Throws when it
     * cannot run (disk too full) or failed; the erasure then is not done.
     */
    rebuildForErasure,
    /** Resolves when the current job ended. */
    idle: () => running ?? Promise.resolve(),
    async close() {
      if (closed) return
      halt('The computer is shutting down')
      closed = true
      if (reclaimTimer) clearInterval(reclaimTimer)
      if (firstCheck) clearTimeout(firstCheck)
      for (const wake of [...sleepers]) wake()
      await running?.catch(() => undefined)
    }
  }
}
export type StorageCompaction = ReturnType<typeof createStorageCompaction>

interface WorkerHandle {
  ready: Promise<Array<{ name: string; sql: string }>>
  copy(tables: TableInfo[], keys: Key[]): Promise<void>
  finish(check: boolean): Promise<string>
  /** Inside a long native call (quick_check): it cannot stop before returning. */
  busyNative(): boolean
  /** Ends the thread; settles when it has exited. */
  terminate(): Promise<void>
}
/**
 * A compaction worker (`compaction-worker.ts`). `exit` runs when its thread really
 * ended (its copy is free then); `registration` (a live store's secondary-connection
 * entry) is released as soon as its connections are closed.
 */
function startCompactionWorker(spec: {
  mode: 'build' | 'resume' | 'file'
  live: string
  out: string
  tables: TableInfo[]
  throttle: { batchBytes: number; syncBytes: number; pauseMs: number }
  registration?: { release(): void }
  exit(): void
  progress(bytes: number): void
}): WorkerHandle {
  const { mode, registration } = spec
  const on = spec
  const worker = new Worker(COMPACTION_WORKER_SOURCE, {
    eval: true,
    workerData: {
      modulePath: sqliteModulePath(),
      live: spec.live,
      out: spec.out,
      mode,
      tables: spec.tables,
      throttle: spec.throttle
    }
  })
  let waiting: { resolve(m: WorkerMessage): void; reject(e: Error): void } | null = null
  let failure: Error | null = null
  let ended = false
  let state: 'building' | 'idle' | 'copying' | 'finishing' = mode === 'resume' ? 'idle' : 'building'
  let markExited: () => void = () => undefined
  const exited = new Promise<void>((resolve) => {
    markExited = resolve
  })
  const end = () => {
    if (ended) return
    ended = true
    registration?.release()
  }
  const settle = (m: WorkerMessage | Error) => {
    const w = waiting
    waiting = null
    if (m instanceof Error) {
      failure = m
      w?.reject(m)
    } else w?.resolve(m)
  }
  worker.on('message', (m: WorkerMessage) => {
    if (m.t === 'progress') {
      on.progress(m.bytes)
      return
    }
    if (m.t === 'error') {
      end()
      settle(new Error(m.message))
    } else {
      if (m.t === 'finished') end()
      settle(m)
    }
  })
  worker.on('error', (error) => {
    end()
    settle(error)
  })
  worker.on('exit', () => {
    end()
    if (waiting) settle(new Error('The compaction worker stopped'))
    on.exit()
    markExited()
  })
  const next = () =>
    failure
      ? Promise.reject(failure)
      : new Promise<WorkerMessage>((resolve, reject) => {
          waiting = { resolve, reject }
        })
  const ready = next().then((m) => {
    state = 'idle'
    return m.t === 'ready' ? m.triggers : []
  })
  return {
    ready,
    async copy(tables, keys) {
      const reply = next()
      state = 'copying'
      worker.postMessage({ t: 'copy', tables, keys })
      await reply
      state = 'idle'
    },
    async finish(check) {
      const reply = next()
      state = 'finishing'
      worker.postMessage({ t: 'finish', check })
      const m = await reply
      return m.t === 'finished' ? m.check : 'no reply'
    },
    busyNative: () => state === 'finishing',
    terminate() {
      // Ends at the next JS boundary (between copy batches; quick_check runs to its
      // end). Only its read-only connection and its own copy are involved.
      void worker.terminate().catch(() => undefined)
      return exited
    }
  }
}

/** The tables of `db`'s main schema, with the columns and keys a copy needs. */
function describeTables(db: Database.Database): TableInfo[] {
  return (
    db
      .prepare(
        "SELECT name, sql FROM main.sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY name"
      )
      .all() as Array<{ name: string; sql: string }>
  ).map(({ name, sql }) => {
    const info = db.pragma(`main.table_info(${ident(name)})`) as Array<{
      name: string
      pk: number
    }>
    const pk = info
      .filter((c) => c.pk > 0)
      .sort((a, b) => a.pk - b.pk)
      .map((c) => c.name)
    if (pk.length > MAX_PK) throw new Error(`Table ${name} has too wide a primary key to compact`)
    const withoutRowid = /\bWITHOUT\s+ROWID\b/i.test(sql)
    if (withoutRowid && !pk.length) throw new Error(`Table ${name} has no key to copy by`)
    return { name, cols: info.map((c) => c.name), pk, withoutRowid }
  })
}

/**
 * Rewrite a store file nothing else has open (a restored archive) the way a rebuild
 * does — a fresh copy built off the main thread in throttled batches, checked, then
 * renamed over it. Leaves no stale copies of deleted content in the file. The caller
 * has closed its own connection; the file's WAL must be gone by then.
 */
export async function rebuildStoreFile(
  path: string,
  throttle: { batchBytes: number; syncBytes: number; pauseMs: number } = {
    batchBytes: 4 * MiB,
    syncBytes: 16 * MiB,
    pauseMs: 25
  }
): Promise<void> {
  // Settle the WAL first (an archive opened in WAL mode): the last close removes it.
  const probe = new Database(path, { fileMustExist: true })
  let tables: TableInfo[]
  try {
    probe.pragma('wal_checkpoint(TRUNCATE)')
    tables = describeTables(probe)
  } finally {
    probe.close()
  }
  if (existsSync(`${path}-wal`)) throw new Error('The store file is still open elsewhere')
  const out = `${path}.compact-${randomUUID()}`
  const discard = () => {
    for (const suffix of ['', '-journal', '-wal', '-shm'])
      rmSync(`${out}${suffix}`, { force: true })
  }
  const worker = startCompactionWorker({
    mode: 'file',
    live: path,
    out,
    tables,
    throttle,
    exit: () => undefined,
    progress: () => undefined
  })
  try {
    await worker.ready
    const check = await worker.finish(true)
    if (check !== 'ok') throw new Error(`The rewritten copy failed its check (${check})`)
  } catch (error) {
    // Closed by its own exit (finish) or ended now; the copy is free once it exited.
    await worker.terminate()
    discard()
    throw error
  }
  await worker.terminate()
  // Same name, same directory: the rename replaces it atomically.
  rmSync(`${path}-shm`, { force: true })
  renameSync(out, path)
  syncDirSync(dirname(path))
}
function syncDirSync(dir: string) {
  if (process.platform === 'win32') return
  const fd = openSync(dir, 'r')
  try {
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

type WorkerMessage =
  | { t: 'ready'; triggers: Array<{ name: string; sql: string }> }
  | { t: 'copied' }
  | { t: 'progress'; bytes: number }
  | { t: 'finished'; check: string }
  | { t: 'error'; message: string }

/** A promise settled from outside (Node 20 has no `Promise.withResolvers`). */
function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve: () => void = () => undefined
  const promise = new Promise<void>((r) => {
    resolve = r
  })
  return { promise, resolve }
}
function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}
