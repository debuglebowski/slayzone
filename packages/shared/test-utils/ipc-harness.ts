/**
 * Test harness for IPC handler contract tests.
 * Creates in-memory SQLite DB, runs migrations, and provides a mock ipcMain.
 *
 * Usage:
 *   const h = await createTestHarness()
 *   registerSomeHandlers(h.ipcMain, h.db)
 *   const result = h.invoke('channel:name', arg1, arg2)
 */
import Database from 'better-sqlite3'
import { DB_PRAGMAS } from '@slayzone/platform'
import type { SlayzoneDb, BatchOp, RunResult, TxnName, TxnParams, TxnResult } from '@slayzone/platform'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'

type Handler = (event: unknown, ...args: unknown[]) => unknown

export interface MockIpcMain {
  handle(channel: string, handler: Handler): void
  on(channel: string, handler: Handler): void
  emit(...args: unknown[]): void
  handlers: Map<string, Handler>
}

export interface TestHarness {
  /** Raw synchronous better-sqlite3 handle — use for fixture setup (`db.prepare(...).run(...)`). */
  db: Database.Database
  /**
   * Async `SlayzoneDb` proxy over the SAME in-memory connection — pass THIS to
   * `registerXHandlers(ipcMain, db, ...)`. Main-process handlers moved to the
   * async worker-thread DB interface, so they call `db.all/get/run/namedTxn/
   * batchTxn`; the raw better-sqlite3 handle doesn't expose those. `namedTxn`
   * runs against the real production `txnRegistry` (lazy-loaded on first use).
   * Handler results are therefore Promises — `await h.invoke(...)` in tests.
   */
  slayDb: SlayzoneDb
  ipcMain: MockIpcMain
  invoke(channel: string, ...args: unknown[]): unknown
  tmpDir(): string
  cleanup(): void
}

const fakeEvent = { sender: { send: () => {} } }

// The production named-transaction registry lives in the app package; load it
// the same way the harness loads migrations (runtime dynamic import — keeps
// shared/test-utils free of a static dep on app). Memoized + lazy so tests that
// never call `namedTxn` never pay the import, and one failing domain `./db`
// module can't break every harness-based test.
let _txnRegistry: Record<string, (db: Database.Database, params: never) => unknown> | null = null
async function loadTxnRegistry(): Promise<
  Record<string, (db: Database.Database, params: never) => unknown>
> {
  if (_txnRegistry) return _txnRegistry
  const registryPath = path.resolve(
    import.meta.dirname,
    '../../apps/app/src/main/db/txn-registry.ts'
  )
  const mod = await import(registryPath)
  _txnRegistry = mod.txnRegistry
  return _txnRegistry!
}

/**
 * Wraps a synchronous in-memory better-sqlite3 `Database` in the async
 * `SlayzoneDb` surface that main-process handlers now expect. Mirrors the DB
 * worker's dispatch (`db-worker.ts`) exactly — `get/all/run` spread params,
 * `batchTxn` runs the op list in one `db.transaction`, `namedTxn` invokes the
 * registered fn directly (it owns its own transaction; no re-wrap). Every call
 * resolves immediately (the underlying better-sqlite3 work is synchronous).
 */
export function createSlayzoneDbAdapter(raw: Database.Database): SlayzoneDb {
  const toRunResult = (r: Database.RunResult): RunResult => ({
    changes: r.changes,
    lastInsertRowid: r.lastInsertRowid
  })
  return {
    async get<T = unknown>(sql: string, params: unknown[] = []): Promise<T | undefined> {
      return raw.prepare(sql).get(...params) as T | undefined
    },
    async all<T = unknown>(sql: string, params: unknown[] = []): Promise<T[]> {
      return raw.prepare(sql).all(...params) as T[]
    },
    async run(sql: string, params: unknown[] = []): Promise<RunResult> {
      return toRunResult(raw.prepare(sql).run(...params))
    },
    async exec(sql: string): Promise<void> {
      raw.exec(sql)
    },
    async batchTxn(ops: BatchOp[]): Promise<unknown[]> {
      const run = raw.transaction((list: BatchOp[]) =>
        list.map((op) => raw.prepare(op.sql)[op.type](...op.params))
      )
      return run(ops)
    },
    async namedTxn<K extends TxnName>(
      name: K,
      params: TxnParams<K>
    ): Promise<Awaited<TxnResult<K>>> {
      const registry = await loadTxnRegistry()
      const fn = registry[name]
      if (!fn) throw new Error(`Unknown named transaction: ${name}`)
      return fn(raw, params as never) as Awaited<TxnResult<K>>
    },
    async backup(): Promise<void> {
      /* no-op in tests */
    },
    prepare(sql: string) {
      const s = raw.prepare(sql)
      return {
        async get<T = unknown>(...params: unknown[]): Promise<T | undefined> {
          return s.get(...params) as T | undefined
        },
        async all<T = unknown>(...params: unknown[]): Promise<T[]> {
          return s.all(...params) as T[]
        },
        async run(...params: unknown[]): Promise<RunResult> {
          return toRunResult(s.run(...params))
        }
      }
    },
    async close(): Promise<void> {
      /* harness.cleanup() closes the raw connection */
    }
  }
}

export async function createTestHarness(): Promise<TestHarness> {
  const db = new Database(':memory:')
  for (const pragma of DB_PRAGMAS) {
    db.pragma(pragma)
  }

  // Dynamic import to avoid Node 24 native TS static analysis issues
  const migrationsPath = path.resolve(
    import.meta.dirname,
    '../../apps/app/src/main/db/migrations.ts'
  )
  const mod = await import(migrationsPath)
  mod.runMigrations(db)

  const handlers = new Map<string, Handler>()
  const tmpDirs: string[] = []

  const ipcMain: MockIpcMain = {
    handle(channel: string, handler: Handler) {
      handlers.set(channel, handler)
    },
    on(channel: string, handler: Handler) {
      handlers.set(channel, handler)
    },
    emit() {
      /* no-op for tests */
    },
    handlers
  }

  return {
    db,
    slayDb: createSlayzoneDbAdapter(db),
    ipcMain,
    invoke(channel: string, ...args: unknown[]) {
      const handler = handlers.get(channel)
      if (!handler) throw new Error(`No handler for channel: ${channel}`)
      return handler(fakeEvent, ...args)
    },
    tmpDir() {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slayzone-test-'))
      tmpDirs.push(dir)
      return dir
    },
    cleanup() {
      for (const dir of tmpDirs) {
        fs.rmSync(dir, { recursive: true, force: true })
      }
      tmpDirs.length = 0
      db.close()
    }
  }
}

// Minimal test runner — chains async tests sequentially, runs sync tests immediately
let _testQueue: Promise<void> = Promise.resolve()
let _hasAsync = false

export function test(name: string, fn: () => void | Promise<void>) {
  if (_hasAsync) {
    // Once async mode is entered, queue everything to preserve ordering
    _testQueue = _testQueue.then(async () => {
      try {
        await fn()
        console.log(`  \u2713 ${name}`)
      } catch (e) {
        console.log(`  \u2717 ${name}`)
        console.error(`    ${e}`)
        process.exitCode = 1
      }
    })
  } else {
    try {
      const result = fn()
      if (result instanceof Promise) {
        _hasAsync = true
        _testQueue = result.then(
          () => console.log(`  \u2713 ${name}`),
          (e) => {
            console.log(`  \u2717 ${name}`)
            console.error(`    ${e}`)
            process.exitCode = 1
          }
        )
      } else {
        console.log(`  \u2713 ${name}`)
      }
    } catch (e) {
      console.log(`  \u2717 ${name}`)
      console.error(`    ${e}`)
      process.exitCode = 1
    }
  }
}

export function expect(actual: unknown) {
  return {
    toBe(expected: unknown) {
      if (actual !== expected)
        throw new Error(`Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
    },
    toEqual(expected: unknown) {
      if (JSON.stringify(actual) !== JSON.stringify(expected))
        throw new Error(`Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
    },
    toBeTruthy() {
      if (!actual) throw new Error(`Expected truthy, got ${JSON.stringify(actual)}`)
    },
    toBeFalsy() {
      if (actual) throw new Error(`Expected falsy, got ${JSON.stringify(actual)}`)
    },
    toBeNull() {
      if (actual !== null) throw new Error(`Expected null, got ${JSON.stringify(actual)}`)
    },
    toBeUndefined() {
      if (actual !== undefined) throw new Error(`Expected undefined, got ${JSON.stringify(actual)}`)
    },
    toBeGreaterThan(n: number) {
      if (typeof actual !== 'number' || actual <= n)
        throw new Error(`Expected > ${n}, got ${actual}`)
    },
    toBeGreaterThanOrEqual(n: number) {
      if (typeof actual !== 'number' || actual < n)
        throw new Error(`Expected >= ${n}, got ${actual}`)
    },
    toHaveLength(n: number) {
      if (!Array.isArray(actual) || actual.length !== n)
        throw new Error(
          `Expected length ${n}, got ${Array.isArray(actual) ? actual.length : 'not array'}`
        )
    },
    toContain(item: unknown) {
      if (!Array.isArray(actual) || !actual.includes(item))
        throw new Error(`Expected array to contain ${JSON.stringify(item)}`)
    },
    toThrow() {
      if (typeof actual !== 'function') throw new Error('Expected a function')
      try {
        ;(actual as () => void)()
        throw new Error('Expected function to throw')
      } catch (e: unknown) {
        if (e instanceof Error && e.message === 'Expected function to throw') throw e
      }
    },
    // Negated matchers. Additive — existing matchers above are unchanged.
    not: {
      toBe(expected: unknown) {
        if (actual === expected)
          throw new Error(`Expected not ${JSON.stringify(expected)}, but got it`)
      },
      toEqual(expected: unknown) {
        if (JSON.stringify(actual) === JSON.stringify(expected))
          throw new Error(`Expected not ${JSON.stringify(expected)}, but got it`)
      },
      toContain(item: unknown) {
        if (Array.isArray(actual) && actual.includes(item))
          throw new Error(`Expected array not to contain ${JSON.stringify(item)}`)
      },
      toBeNull() {
        if (actual === null) throw new Error('Expected not null')
      },
      toBeUndefined() {
        if (actual === undefined) throw new Error('Expected not undefined')
      }
    }
  }
}

export async function describe(name: string, fn: () => void) {
  console.log(`\n${name}`)
  _hasAsync = false
  fn()
  if (_hasAsync) await _testQueue
}
