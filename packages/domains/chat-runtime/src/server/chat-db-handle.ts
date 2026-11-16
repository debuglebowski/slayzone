/**
 * The chat store's ONE handle on its SQLite connection, stable across a connection
 * swap (storage compaction replaces the file and reopens it).
 *
 * Every chat-runtime module reaches the store through `storage.compose(f)`, and
 * several keep the handle for their lifetime (retention, task paths, agent turns,
 * usage cursors). They are given this handle, never the connection: each property
 * read forwards to the CURRENT connection, so a swap is invisible to them.
 *
 * Connection state is not in the file, so the handle records what it must carry
 * over and re-applies it to the next connection: SQL functions, aggregates and
 * virtual tables registered through it (an artifact trigger calls one), and
 * connection-scoped pragmas set through it.
 *
 * What cannot carry over fails loudly instead of reaching the old file: a prepared
 * statement or `transaction()` wrapper made before a swap is bound to the closed
 * connection and throws "not open". So none may be kept across an await that could
 * span a swap (none is today: statements are prepared per call).
 *
 * The handle cannot close the connection: the store owns it.
 */
import type Database from 'better-sqlite3'

/** Connection-scoped pragmas (not stored in the file): re-applied after a swap. */
const CONNECTION_PRAGMAS = new Set([
  'busy_timeout',
  'cache_size',
  'cache_spill',
  'cell_size_check',
  'foreign_keys',
  'journal_size_limit',
  'mmap_size',
  'recursive_triggers',
  'secure_delete',
  'synchronous',
  'temp_store',
  'threads',
  'trusted_schema',
  'wal_autocheckpoint'
])
/** Methods that change connection state: recorded, then replayed on the next connection. */
const REGISTRATIONS = new Set(['function', 'aggregate', 'table', 'loadExtension'])

export interface SwappableDb {
  /** The stable handle `compose` hands out. */
  readonly db: Database.Database
  /** The connection the handle reaches right now (the store's own use only). */
  current(): Database.Database
  /** Refuse all SQL until a verified replacement is selected. */
  invalidate(error: Error): void
  /** Point the handle at `next`, after re-applying recorded connection state. Returns the previous one. */
  replace(next: Database.Database): Database.Database
}

export function createSwappableDb(initial: Database.Database): SwappableDb {
  let conn = initial
  let failure: Error | undefined
  const available = () => {
    if (failure) throw failure
  }
  const registrations: Array<{ method: string; args: unknown[] }> = []
  const pragmas = new Map<string, string>()
  // Forwarding methods of the current connection, made once per connection.
  let bound = new Map<PropertyKey, unknown>()

  const call = (method: string, args: unknown[]) => {
    available()
    return (conn as unknown as Record<string, (...a: unknown[]) => unknown>)[method](...args)
  }

  function special(key: PropertyKey): unknown {
    if (key === 'close')
      return () => {
        throw new Error('Chat storage owns its connection: close the store instead')
      }
    if (typeof key === 'string' && REGISTRATIONS.has(key))
      return (...args: unknown[]) => {
        call(key, args)
        registrations.push({ method: key, args })
        return handle
      }
    if (key === 'pragma')
      return (source: string, options?: unknown) => {
        available()
        const result = conn.pragma(source, options as Database.PragmaOptions)
        const set = /^\s*(\w+)\s*=\s*(.+?)\s*;?\s*$/.exec(source)
        if (set && CONNECTION_PRAGMAS.has(set[1].toLowerCase()))
          pragmas.set(set[1].toLowerCase(), set[2])
        return result
      }
    return undefined
  }

  const handle = new Proxy(Object.create(null) as Database.Database, {
    get(_target, key) {
      if (failure && key === 'open') return false
      available()
      const own = special(key)
      if (own) return own
      const value = Reflect.get(conn, key, conn)
      if (typeof value !== 'function') return value
      let fn = bound.get(key)
      if (!fn) {
        // Captured methods keep following the facade; returned statements remain
        // pinned to the physical connection that prepared them.
        const captured = conn
        fn = (...args: unknown[]) => {
          available()
          // Preserve a captured method when tests/services wrap it on this same
          // connection; looking it up again would recurse into their override.
          const method = conn === captured ? value : Reflect.get(handle, key)
          return Reflect.apply(method, conn, args)
        }
        bound.set(key, fn)
      }
      return fn
    },
    has: (_target, key) => key in conn,
    // A property set on the handle lands on the current connection (tests wrap
    // `prepare` this way to inject faults); it does not outlive a swap.
    set(_target, key, value) {
      available()
      bound.delete(key)
      return Reflect.set(conn, key, value, conn)
    },
    defineProperty: () => false,
    deleteProperty: () => false,
    getPrototypeOf: () => Object.getPrototypeOf(conn)
  })

  return {
    db: handle,
    current: () => conn,
    invalidate: (error) => {
      failure = error
    },
    replace(next) {
      for (const [name, value] of pragmas) next.pragma(`${name} = ${value}`)
      for (const r of registrations)
        (next as unknown as Record<string, (...a: unknown[]) => unknown>)[r.method](...r.args)
      const previous = conn
      conn = next
      failure = undefined
      bound = new Map()
      return previous
    }
  }
}
