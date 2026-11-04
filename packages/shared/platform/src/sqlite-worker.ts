/**
 * Owning-thread side of a SQLite worker: a {@link SlayzoneDb} whose connection
 * lives on a worker thread (`./sqlite-worker-host`), so a long query — or a long
 * run of short ones — never stalls this thread's event loop.
 *
 * Semantics kept identical to an in-process better-sqlite3 handle wherever the
 * thread boundary allows: requests execute in call order; errors keep their
 * message, `code` (and other primitive props) and a stack through the caller;
 * BLOBs come back as `Buffer`; `close()` lets queued work land, then really
 * closes the file. What cannot carry over: `prepare()` validates nothing until a
 * statement runs (a bad statement rejects at run, not throws at prepare), and an
 * error's class identity (`instanceof SqliteError`) — `name` is kept.
 *
 * An idle worker does not keep the process alive (it is `unref`'d whenever no
 * call is pending), matching a synchronous handle, which never held the loop.
 */
import { SHARE_ENV, Worker } from 'node:worker_threads'
import type { BatchOp, PreparedBridge, RunResult, SlayzoneDb } from './db'
import type { TxnName, TxnParams, TxnResult } from './txn-registry-map'
import {
  deserializeError,
  reviveBuffers,
  type SqliteWorkerRequest,
  type SqliteWorkerResponse
} from './sqlite-worker-protocol'

export type OpenSqliteWorkerOptions = {
  /** Names this DB in errors ("hub data DB worker: database closed"). */
  label: string
  /** Absolute path of the bundled worker entry (a file calling `serveSqliteWorker`). */
  workerPath: string
  /** Handed to the worker's `open`. Resolve paths/flags here; keep it cloneable. */
  workerData: unknown
  /**
   * The worker died after startup (out of memory, an uncaught throw). Every pending
   * and later call rejects with `err` either way; this is the owner's chance to
   * escalate — in-process, the same failure would have taken the whole process down.
   */
  onUnexpectedExit?: (err: Error) => void
}

// Distributive Omit: keeps each request member's own fields.
type RequestInput = SqliteWorkerRequest extends infer T
  ? T extends { id: number }
    ? Omit<T, 'id'>
    : never
  : never

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void; callSite: Error }

/**
 * Spawn the worker and resolve once its startup (`open`) finished. A startup throw
 * rejects with that error (message + code), and the worker is gone.
 */
export function openSqliteWorker(opts: OpenSqliteWorkerOptions): Promise<SlayzoneDb> {
  const callSite = new Error()
  return new Promise<SlayzoneDb>((resolve, reject) => {
    let worker: Worker
    try {
      // SHARE_ENV: the worker reads the same live `process.env` the rest of the
      // process does (a migration reads a hub switch from env), as in-process code did.
      worker = new Worker(opts.workerPath, { workerData: opts.workerData, env: SHARE_ENV })
    } catch (err) {
      reject(err)
      return
    }
    let settled = false
    let cause: Error | undefined
    const cleanup = (): void => {
      worker.off('message', onStartup)
      worker.off('error', onError)
      worker.off('exit', onExit)
    }
    const onStartup = (msg: SqliteWorkerResponse): void => {
      if (!('type' in msg) || settled) return
      settled = true
      cleanup()
      if (msg.type === 'ready') resolve(new SqliteWorkerDb(worker, opts))
      else reject(deserializeError(msg.error, callSite))
    }
    const onError = (err: Error): void => {
      cause = err
    }
    const onExit = (code: number): void => {
      if (settled) return
      settled = true
      cleanup()
      reject(
        cause ??
          new Error(`${opts.label}: worker exited with code ${String(code)} before it was ready`)
      )
    }
    worker.on('message', onStartup)
    worker.on('error', onError)
    worker.on('exit', onExit)
  })
}

class SqliteWorkerDb implements SlayzoneDb {
  private readonly pending = new Map<number, Pending>()
  private nextId = 0
  private closed = false
  private closing: Promise<void> | null = null
  private dead: Error | null = null

  constructor(
    private readonly worker: Worker,
    private readonly opts: OpenSqliteWorkerOptions
  ) {
    worker.on('message', (msg: SqliteWorkerResponse) => this.onMessage(msg))
    let cause: Error | undefined
    worker.on('error', (err) => {
      cause = err
    })
    // A response that could not be deserialized names no id: fail everything
    // pending rather than leave a caller hanging forever.
    worker.on('messageerror', (err) => this.failAll(err))
    worker.on('exit', (code) => {
      if (this.closed && this.pending.size === 0) return
      const err = new Error(
        `${opts.label}: worker exited unexpectedly (code ${String(code)})${cause ? `: ${cause.message}` : ''}`,
        { cause }
      )
      this.dead = err
      this.failAll(err)
      if (!this.closed) opts.onUnexpectedExit?.(err)
    })
    worker.unref()
  }

  private onMessage(msg: SqliteWorkerResponse): void {
    if (!('id' in msg)) return
    const entry = this.pending.get(msg.id)
    if (!entry) return
    this.settle(msg.id)
    if (msg.ok) entry.resolve(reviveBuffers(msg.result))
    else entry.reject(deserializeError(msg.error, entry.callSite))
  }

  private settle(id: number): void {
    this.pending.delete(id)
    if (this.pending.size === 0) this.worker.unref()
  }

  private failAll(err: Error): void {
    const entries = [...this.pending.values()]
    this.pending.clear()
    this.worker.unref()
    for (const e of entries) e.reject(err)
  }

  private send<T>(req: RequestInput): Promise<T> {
    if (this.dead) return Promise.reject(this.dead)
    if (this.closed) {
      return Promise.reject(new Error(`${this.opts.label}: database closed`))
    }
    const id = this.nextId++
    // Captured now, so a rejection's stack names the code that issued the query.
    const callSite = new Error()
    return new Promise<T>((resolve, reject) => {
      if (this.pending.size === 0) this.worker.ref()
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, callSite })
      try {
        this.worker.postMessage({ ...req, id } as SqliteWorkerRequest)
      } catch (err) {
        // Params structured clone cannot carry (a function, a class instance).
        this.settle(id)
        reject(err instanceof Error ? err : new Error(String(err)))
      }
    })
  }

  get<T = unknown>(sql: string, params: unknown[] = []): Promise<T | undefined> {
    return this.send<T | undefined>({ type: 'get', sql, params })
  }

  all<T = unknown>(sql: string, params: unknown[] = []): Promise<T[]> {
    return this.send<T[]>({ type: 'all', sql, params })
  }

  run(sql: string, params: unknown[] = []): Promise<RunResult> {
    return this.send<RunResult>({ type: 'run', sql, params })
  }

  exec(sql: string): Promise<void> {
    return this.send<void>({ type: 'exec', sql })
  }

  batchTxn(ops: BatchOp[]): Promise<unknown[]> {
    return this.send<unknown[]>({ type: 'batch-txn', ops })
  }

  namedTxn<K extends TxnName>(name: K, params: TxnParams<K>): Promise<Awaited<TxnResult<K>>> {
    return this.send<Awaited<TxnResult<K>>>({ type: 'named-txn', name: String(name), params })
  }

  backup(destPath: string): Promise<void> {
    return this.send<void>({ type: 'backup', destPath })
  }

  /** The worker caches the compiled statement by SQL text, so reuse stays cheap. */
  prepare(sql: string): PreparedBridge {
    return {
      get: <T = unknown>(...params: unknown[]) =>
        this.send<T | undefined>({ type: 'get', sql, params }),
      all: <T = unknown>(...params: unknown[]) => this.send<T[]>({ type: 'all', sql, params }),
      run: (...params: unknown[]) => this.send<RunResult>({ type: 'run', sql, params })
    }
  }

  /**
   * Resolves once the worker has closed the connection (WAL checkpointed, file
   * released — a restore overwrites it next). Calls made before `close()` still
   * run first; calls made after reject. Idempotent.
   */
  close(): Promise<void> {
    if (this.closing) return this.closing
    if (this.dead) return Promise.resolve()
    const closing = this.send<void>({ type: 'close' })
    this.closed = true
    this.closing = closing
    return closing
  }
}
