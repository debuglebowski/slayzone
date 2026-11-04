/**
 * Worker-thread side of a SQLite worker: owns the ONE better-sqlite3 connection
 * and answers the requests the owning thread's proxy (`./sqlite-worker`) sends.
 *
 * A worker entry calls {@link serveSqliteWorker} with its own startup (`open`: run
 * renames, pragmas, backup, migrations — whatever must happen before the first
 * query) and its named-transaction registry. Startup runs here, on the worker, so
 * a slow migration never blocks the owning thread either; `ready` is posted only
 * once it finished, and a startup throw is reported as `init-error` (the proxy
 * rejects its open with it) and the worker exits.
 *
 * Takes the connection from `open` rather than importing better-sqlite3 itself, so
 * this module (and `@slayzone/platform`) stays free of the native dependency.
 */
import { parentPort, workerData } from 'node:worker_threads'
import type Database from 'better-sqlite3'
import {
  reviveBuffers,
  serializeError,
  type SqliteWorkerRequest,
  type SqliteWorkerResponse
} from './sqlite-worker-protocol'

/** A registered named transaction. It owns its own `db.transaction(...)`; never re-wrapped. */
// biome-ignore lint/suspicious/noExplicitAny: registries type their params precisely; dispatch is by name
export type SqliteNamedTxn = (db: Database.Database, params: any) => unknown

export type SqliteWorkerHostOptions<Data> = {
  /** Shown in errors ("<label> has no named transaction …"). */
  label: string
  /** Startup: open + prepare the connection. Receives the spawner's `workerData`. */
  open: (data: Data) => Database.Database | Promise<Database.Database>
  /** Named transactions this DB serves. Absent = it serves none. */
  txns?: Readonly<Record<string, SqliteNamedTxn>>
}

/**
 * Prepared statements, reused by SQL text: re-preparing per call would cost more
 * than the query itself for the hub's many small reads. Bounded (LRU) because SQL
 * text is not a closed set — `/api/dev/sql` and any interpolated IN-list mint new
 * strings — and an unbounded cache is a leak.
 */
const STATEMENT_CACHE_MAX = 500

export function serveSqliteWorker<Data>(opts: SqliteWorkerHostOptions<Data>): void {
  const port = parentPort
  if (!port) throw new Error(`${opts.label}: must run as a worker thread`)
  const post = (msg: SqliteWorkerResponse): void => port.postMessage(msg)

  let db: Database.Database
  const cache = new Map<string, Database.Statement>()
  const stmt = (sql: string): Database.Statement => {
    let s = cache.get(sql)
    if (s) {
      cache.delete(sql)
    } else {
      s = db.prepare(sql)
      if (cache.size >= STATEMENT_CACHE_MAX) {
        const oldest = cache.keys().next().value
        if (oldest !== undefined) cache.delete(oldest)
      }
    }
    cache.set(sql, s)
    return s
  }

  // Async ops still running; `close` waits for them (closing under a running
  // backup would abort it).
  const inflight = new Set<Promise<unknown>>()
  let closing = false

  const reply = (id: number, result: unknown): void => {
    try {
      post({ id, ok: true, result })
    } catch (err) {
      // A result structured clone cannot carry (a function, a class with private
      // state) — the caller gets the clone error instead of a hang.
      post({ id, ok: false, error: serializeError(err) })
    }
  }
  const fail = (id: number, err: unknown): void =>
    post({ id, ok: false, error: serializeError(err) })

  const handle = (req: SqliteWorkerRequest): unknown => {
    switch (req.type) {
      case 'get':
        return stmt(req.sql).get(...reviveBuffers(req.params))
      case 'all':
        return stmt(req.sql).all(...reviveBuffers(req.params))
      case 'run': {
        const r = stmt(req.sql).run(...reviveBuffers(req.params))
        return { changes: r.changes, lastInsertRowid: r.lastInsertRowid }
      }
      case 'exec':
        db.exec(req.sql)
        return undefined
      case 'batch-txn':
        return db.transaction(() =>
          req.ops.map((op) => stmt(op.sql)[op.type](...reviveBuffers(op.params)))
        )()
      case 'named-txn': {
        // Own properties only: `txns.toString` is not a transaction.
        const fn = opts.txns && Object.hasOwn(opts.txns, req.name) ? opts.txns[req.name] : undefined
        if (!fn) {
          throw new Error(
            `Unknown named transaction "${req.name}" — not registered in ${opts.label}`
          )
        }
        return fn(db, reviveBuffers(req.params))
      }
      case 'backup':
        // better-sqlite3 resolves with page counts; the contract is `Promise<void>`.
        return db.backup(req.destPath).then(() => undefined)
      case 'close':
        throw new Error('unreachable')
    }
  }

  const onMessage = (req: SqliteWorkerRequest): void => {
    if (req.type === 'close') {
      closing = true
      void Promise.allSettled([...inflight]).then(() => {
        try {
          cache.clear()
          db.close()
          reply(req.id, undefined)
        } catch (err) {
          fail(req.id, err)
        }
        // Nothing else keeps this thread alive: it exits with code 0.
        port.close()
      })
      return
    }
    if (closing) {
      fail(req.id, new Error(`${opts.label}: database closed`))
      return
    }
    let result: unknown
    try {
      result = handle(req)
    } catch (err) {
      fail(req.id, err)
      return
    }
    if (result instanceof Promise) {
      const p = result.then(
        (r) => reply(req.id, r),
        (err) => fail(req.id, err)
      )
      inflight.add(p)
      void p.finally(() => inflight.delete(p))
    } else {
      reply(req.id, result)
    }
  }

  void (async () => {
    try {
      db = await opts.open(workerData as Data)
    } catch (err) {
      post({ type: 'init-error', error: serializeError(err) })
      port.close()
      return
    }
    port.on('message', onMessage)
    post({ type: 'ready' })
  })()
}
