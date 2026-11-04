/**
 * The hub's two SQLite connections (data + diagnostics) live on worker threads.
 *
 * WHY: better-sqlite3 is synchronous. Run on the hub's only thread, a long query
 * (or a burst of short ones — every `await db.x()` resolved as a microtask, so a
 * loop of them never yielded) froze ALL WS/tRPC traffic: `server.event_loop_stall`
 * of 2–10s, 52s frozen out of 55s after a renderer reload, task-tab loads blowing
 * their 20s deadline. The first test pins the property that fixes it; the rest pin
 * that every `SlayzoneDb` operation still behaves as it did in-process.
 *
 * Runs the BUILT worker (`dist/db-worker.cjs`, `dist/diag-worker.cjs`) — the
 * harness globalSetup rebuilds the hub before any suite starts.
 */
import Database from 'better-sqlite3'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import type { SlayzoneDb } from '@slayzone/platform'
import { LATEST_MIGRATION_VERSION } from '@slayzone/db-migrations'
// Types the `db.namedTxn('tags:setForTask', ...)` calls below.
import type {} from '@slayzone/api/txns'
import {
  getDatabasePathFromEnv,
  getServerDiagnosticsDatabasePath,
  openServerDatabase,
  openServerDiagnosticsDatabase
} from './db.js'

const ENV_KEYS = ['SLAYZONE_ROOT', 'SLAYZONE_DEV'] as const
const prior = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]))
let root: string
const opened: SlayzoneDb[] = []

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'slayzone-hub-db-worker-'))
  process.env.SLAYZONE_ROOT = root
  process.env.SLAYZONE_DEV = '1'
})

afterEach(async () => {
  for (const db of opened.splice(0)) await db.close().catch(() => undefined)
  for (const k of ENV_KEYS) {
    if (prior[k] === undefined) delete process.env[k]
    else process.env[k] = prior[k]
  }
  rmSync(root, { recursive: true, force: true })
})

async function openData(): Promise<SlayzoneDb> {
  const db = await openServerDatabase()
  opened.push(db)
  return db
}

/** A CPU-bound statement that takes a while in SQLite and returns one row. */
const HEAVY_SQL =
  'WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c LIMIT ?) SELECT count(*) AS n FROM c'

test('a long query runs off the hub thread — timers keep firing while it executes', async () => {
  const db = await openData()
  // Size the query so it takes long enough to be unmistakable on any box: grow it
  // until one run takes >= 400ms (a blocked event loop would stall that long).
  let rows = 2_000_000
  for (;;) {
    const t0 = performance.now()
    await db.get(HEAVY_SQL, [rows])
    if (performance.now() - t0 >= 400 || rows >= 512_000_000) break
    rows *= 2
  }

  let last = performance.now()
  let maxGap = 0
  let ticks = 0
  const timer = setInterval(() => {
    const now = performance.now()
    maxGap = Math.max(maxGap, now - last)
    last = now
    ticks++
  }, 5)
  const t0 = performance.now()
  try {
    const row = await db.get<{ n: number }>(HEAVY_SQL, [rows])
    expect(row?.n).toBe(rows)
  } finally {
    clearInterval(timer)
  }
  const elapsed = performance.now() - t0

  expect(elapsed).toBeGreaterThanOrEqual(300)
  // In-process, the interval could not fire at all until the query returned
  // (maxGap ≈ elapsed, ticks ≈ 0). Generous bounds: a loaded CI box delays timers.
  expect(ticks).toBeGreaterThan(5)
  expect(maxGap).toBeLessThan(elapsed / 2)
})

test('opens + migrates the data DB in the worker before resolving', async () => {
  const db = await openData()
  const v = await db.get<{ user_version: number }>('PRAGMA user_version')
  expect(v?.user_version).toBe(LATEST_MIGRATION_VERSION)
  expect(existsSync(getDatabasePathFromEnv())).toBe(true)
  // DB_PRAGMAS applied on the worker's connection.
  expect((await db.get<{ journal_mode: string }>('PRAGMA journal_mode'))?.journal_mode).toBe('wal')
  expect((await db.get<{ foreign_keys: number }>('PRAGMA foreign_keys'))?.foreign_keys).toBe(1)
})

test('get / all / run / exec / prepare round-trip with better-sqlite3 value types', async () => {
  const db = await openData()
  await db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT UNIQUE, data BLOB, n INTEGER)')

  const r = await db.run('INSERT INTO t (name, data, n) VALUES (?, ?, ?)', [
    'a',
    Buffer.from('hello'),
    2n
  ])
  expect(r).toEqual({ changes: 1, lastInsertRowid: 1 })

  const row = await db.get<{ id: number; name: string; data: Buffer; n: number }>(
    'SELECT * FROM t WHERE name = ?',
    ['a']
  )
  expect(row?.n).toBe(2)
  // BLOBs come back as Buffer, as they did in-process (structured clone alone
  // would hand back a plain Uint8Array, whose toString() is "104,101,…").
  expect(Buffer.isBuffer(row?.data)).toBe(true)
  expect(row?.data.toString('utf8')).toBe('hello')
  expect(await db.get('SELECT * FROM t WHERE name = ?', ['missing'])).toBeUndefined()

  // Named params object, as better-sqlite3 accepts.
  await db.run('INSERT INTO t (name, n) VALUES (@name, @n)', [{ name: 'b', n: 3 }])
  expect(await db.all<{ name: string }>('SELECT name FROM t ORDER BY id')).toEqual([
    { name: 'a' },
    { name: 'b' }
  ])

  const stmt = db.prepare('SELECT name FROM t WHERE n >= ? ORDER BY id')
  expect(await stmt.all(3)).toEqual([{ name: 'b' }])
  expect(await stmt.get(0)).toEqual({ name: 'a' })
  const ins = db.prepare('INSERT INTO t (name) VALUES (?)')
  expect((await ins.run('c')).changes).toBe(1)
  expect((await ins.run('d')).lastInsertRowid).toBe(4)
})

test('errors keep message and SQLite code', async () => {
  const db = await openData()
  await db.exec('CREATE TABLE u (name TEXT UNIQUE)')
  await db.run('INSERT INTO u VALUES (?)', ['x'])

  const err = await db.run('INSERT INTO u VALUES (?)', ['x']).catch((e: unknown) => e)
  expect(err).toBeInstanceOf(Error)
  expect((err as Error & { code?: string }).code).toBe('SQLITE_CONSTRAINT_UNIQUE')
  expect((err as Error).message).toMatch(/UNIQUE constraint failed: u\.name/)
  // The stack leads back to this call site, not only into the worker.
  expect((err as Error).stack).toContain('db.test.ts')

  await expect(db.get('SELECT * FROM no_such_table')).rejects.toThrow(/no such table/)
  await expect(db.prepare('SELEC nonsense').all()).rejects.toMatchObject({ code: 'SQLITE_ERROR' })
})

test('batchTxn is atomic: a failing op rolls back the whole batch', async () => {
  const db = await openData()
  await db.exec('CREATE TABLE b (k TEXT PRIMARY KEY)')
  const ok = await db.batchTxn([
    { type: 'run', sql: 'INSERT INTO b VALUES (?)', params: ['1'] },
    { type: 'get', sql: 'SELECT count(*) AS n FROM b', params: [] },
    { type: 'all', sql: 'SELECT k FROM b', params: [] }
  ])
  expect(ok).toEqual([{ changes: 1, lastInsertRowid: 1 }, { n: 1 }, [{ k: '1' }]])

  await expect(
    db.batchTxn([
      { type: 'run', sql: 'INSERT INTO b VALUES (?)', params: ['2'] },
      { type: 'run', sql: 'INSERT INTO b VALUES (?)', params: ['1'] }
    ])
  ).rejects.toMatchObject({ code: 'SQLITE_CONSTRAINT_PRIMARYKEY' })
  expect(await db.all('SELECT k FROM b')).toEqual([{ k: '1' }])
})

test('namedTxn dispatches against the domain registry inside the worker', async () => {
  const db = await openData()
  expect(await db.namedTxn('tags:setForTask', { taskId: 'nope', tagIds: [] })).toBeNull()
  // The txn's own FK failure surfaces with its code.
  await expect(
    db.namedTxn('tags:setForTask', { taskId: 'nope', tagIds: ['also-nope'] })
  ).rejects.toMatchObject({ code: 'SQLITE_CONSTRAINT_FOREIGNKEY' })
  await expect(
    // biome-ignore lint/suspicious/noExplicitAny: deliberately unregistered name
    db.namedTxn('no:such-txn' as any, {} as never)
  ).rejects.toThrow(/Unknown named transaction "no:such-txn"/)
  // Prototype keys are not transactions.
  // biome-ignore lint/suspicious/noExplicitAny: deliberately unregistered name
  await expect(db.namedTxn('toString' as any, {} as never)).rejects.toThrow(/Unknown named/)
})

test('backup snapshots the live connection to a file', async () => {
  const db = await openData()
  await db.exec('CREATE TABLE k (v TEXT)')
  await db.run('INSERT INTO k VALUES (?)', ['kept'])
  const dest = join(root, 'snap.sqlite')
  await expect(db.backup(dest)).resolves.toBeUndefined()
  const snap = new Database(dest, { readonly: true })
  try {
    expect(snap.prepare('SELECT v FROM k').get()).toEqual({ v: 'kept' })
  } finally {
    snap.close()
  }
})

test('close drains queued work, really closes the file, and later calls reject', async () => {
  const db = await openServerDatabase()
  await db.exec('CREATE TABLE q (v INTEGER)')
  // Not awaited: close() must still let these land first (FIFO), as in-process.
  const writes = [1, 2, 3].map((v) => db.run('INSERT INTO q VALUES (?)', [v]))
  await db.close()
  await Promise.all(writes)
  await expect(db.get('SELECT 1')).rejects.toThrow(/closed/)
  await expect(db.close()).resolves.toBeUndefined()
  // A clean close checkpoints the WAL and removes it (restore depends on this).
  expect(existsSync(`${getDatabasePathFromEnv()}-wal`)).toBe(false)
  const raw = new Database(getDatabasePathFromEnv(), { readonly: true })
  try {
    expect(raw.prepare('SELECT count(*) AS n FROM q').get()).toEqual({ n: 3 })
  } finally {
    raw.close()
  }
})

test('a startup failure in the worker rejects openServerDatabase with its code', async () => {
  // A directory where the DB file should be: SQLite cannot open it.
  mkdirSync(getDatabasePathFromEnv(), { recursive: true })
  await expect(openServerDatabase()).rejects.toMatchObject({
    code: 'SQLITE_CANTOPEN',
    message: expect.stringMatching(/unable to open database/)
  })
})

test('the diagnostics DB opens in its own worker with its schema', async () => {
  const diag = await openServerDiagnosticsDatabase()
  opened.push(diag)
  expect(existsSync(getServerDiagnosticsDatabasePath())).toBe(true)
  const tables = await diag.all<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type = 'table'"
  )
  expect(tables.map((t) => t.name)).toContain('diagnostics_events')
  // It never sees domain transactions.
  await expect(diag.namedTxn('tags:setForTask', { taskId: 'x', tagIds: [] })).rejects.toThrow(
    /Unknown named transaction/
  )

  // Its own thread: a heavy diagnostics query does not hold up the data DB.
  const data = await openData()
  const heavy = diag.get(HEAVY_SQL, [20_000_000])
  const t0 = performance.now()
  await data.get('SELECT 1')
  expect(performance.now() - t0).toBeLessThan(250)
  await heavy
})

test('diagnostics startup failure rejects', async () => {
  mkdirSync(getServerDiagnosticsDatabasePath(), { recursive: true })
  await expect(openServerDiagnosticsDatabase()).rejects.toMatchObject({ code: 'SQLITE_CANTOPEN' })
})
