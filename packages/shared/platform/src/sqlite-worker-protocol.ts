/**
 * Wire protocol between a {@link SlayzoneDb} proxy (`./sqlite-worker`, the owning
 * thread) and the worker thread that holds the one better-sqlite3 connection
 * (`./sqlite-worker-host`). Shared by every SQLite worker: the hub's data and
 * diagnostics DBs and the desktop app's diagnostics DB.
 *
 * Transactions never cross the boundary: `batch-txn` ships a static op list run
 * atomically in the worker, `named-txn` invokes a function registered IN the
 * worker. Each request carries an `id` the response echoes; the worker answers
 * requests in the order it receives them, except that an async op (`backup`, an
 * async named txn) answers when it settles.
 */
import type { BatchOp } from './db'

export type SqliteWorkerRequest =
  | { id: number; type: 'get' | 'all' | 'run'; sql: string; params: unknown[] }
  | { id: number; type: 'exec'; sql: string }
  | { id: number; type: 'batch-txn'; ops: BatchOp[] }
  | { id: number; type: 'named-txn'; name: string; params: unknown }
  | { id: number; type: 'backup'; destPath: string }
  // Waits for in-flight async ops, closes the connection, then the worker exits.
  | { id: number; type: 'close' }

/**
 * An `Error` as it crosses the thread boundary. Structured clone keeps only
 * `name`/`message`/`stack`, so own primitive properties (better-sqlite3's
 * `SqliteError.code` = `SQLITE_CONSTRAINT_UNIQUE`, a domain error's `code`) travel
 * in `props` and are restored, because callers match on them. Recovery causes and
 * AggregateError members travel explicitly; circular references become labeled errors.
 */
export type SerializedError = {
  name: string
  message: string
  stack?: string
  props?: Record<string, string | number | boolean | bigint | null>
  cause?: SerializedError
  errors?: SerializedError[]
}

export type SqliteWorkerResponse =
  | { type: 'ready' }
  | { type: 'init-error'; error: SerializedError }
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: SerializedError }

export function serializeError(err: unknown): SerializedError {
  return serializeErrorGraph(err, new Set())
}

function serializeErrorGraph(err: unknown, ancestors: Set<Error>): SerializedError {
  if (!(err instanceof Error)) return { name: 'Error', message: String(err) }
  if (ancestors.has(err)) return { name: 'Error', message: 'Circular error reference' }
  ancestors.add(err)
  const props: NonNullable<SerializedError['props']> = {}
  for (const [key, value] of Object.entries(err)) {
    if (
      value === null ||
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean' ||
      typeof value === 'bigint'
    ) {
      props[key] = value
    }
  }
  const result: SerializedError = { name: err.name, message: err.message, stack: err.stack, props }
  if (err.cause !== undefined) result.cause = serializeErrorGraph(err.cause, ancestors)
  if (err instanceof AggregateError)
    result.errors = err.errors.map((error: unknown) => serializeErrorGraph(error, ancestors))
  ancestors.delete(err)
  return result
}

/**
 * Rebuild a worker error on the calling thread. `callSite` (captured when the call
 * was made) supplies the stack frames that matter to a reader — which code ran the
 * query — exactly as an in-process throw did; the worker's own frames follow.
 */
export function deserializeError(e: SerializedError, callSite?: Error): Error {
  const options = e.cause ? { cause: deserializeError(e.cause) } : undefined
  const err = e.errors
    ? new AggregateError(
        e.errors.map((error) => deserializeError(error)),
        e.message,
        options
      )
    : new Error(e.message, options)
  err.name = e.name
  if (e.props) Object.assign(err, e.props)
  const head = `${e.name}: ${e.message}`
  const frames = (stack: string | undefined): string =>
    stack
      ? stack
          .split('\n')
          .filter((l) => /^\s+at /.test(l))
          .join('\n')
      : ''
  const caller = frames(callSite?.stack)
  const worker = frames(e.stack)
  err.stack = [head, caller, worker && `    --- in sqlite worker ---\n${worker}`]
    .filter(Boolean)
    .join('\n')
  return err
}

/**
 * Structured clone turns a `Buffer` into a plain `Uint8Array` (whose `toString()` is
 * `"104,101,…"`). better-sqlite3 returns BLOBs as `Buffer` and callers pass `Buffer`
 * params, so both ends re-wrap every `Uint8Array` as a `Buffer` view — zero-copy —
 * keeping values identical to an in-process call. Walks arrays and plain objects
 * only; returns `value` itself when nothing needed re-wrapping.
 */
export function reviveBuffers<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value
  if (value instanceof Uint8Array) {
    return (
      Buffer.isBuffer(value) ? value : Buffer.from(value.buffer, value.byteOffset, value.byteLength)
    ) as T
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const v = value[i]
      if (v !== null && typeof v === 'object') value[i] = reviveBuffers(v)
    }
    return value
  }
  const proto = Object.getPrototypeOf(value)
  if (proto !== Object.prototype && proto !== null) return value
  const rec = value as Record<string, unknown>
  for (const key in rec) {
    const v = rec[key]
    if (v !== null && typeof v === 'object') rec[key] = reviveBuffers(v)
  }
  return value
}
