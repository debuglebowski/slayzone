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
  db: Database.Database
  ipcMain: MockIpcMain
  invoke(channel: string, ...args: unknown[]): unknown
  tmpDir(): string
  cleanup(): void
}

const fakeEvent = { sender: { send: () => {} } }

export async function createTestHarness(): Promise<TestHarness> {
  const db = new Database(':memory:')
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')

  // Dynamic import to avoid Node 24 native TS static analysis issues
  const migrationsPath = path.resolve(
    import.meta.dirname, '../../apps/app/src/main/db/migrations.ts'
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
    emit() { /* no-op for tests */ },
    handlers
  }

  return {
    db,
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

// Minimal test runner (matches existing project convention)
export function test(name: string, fn: () => void | Promise<void>) {
  try {
    const result = fn()
    if (result instanceof Promise) {
      result.then(
        () => console.log(`  \u2713 ${name}`),
        (e) => { console.log(`  \u2717 ${name}`); console.error(`    ${e}`); process.exitCode = 1 }
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

export function expect(actual: unknown) {
  return {
    toBe(expected: unknown) {
      if (actual !== expected) throw new Error(`Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
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
      if (typeof actual !== 'number' || actual <= n) throw new Error(`Expected > ${n}, got ${actual}`)
    },
    toBeGreaterThanOrEqual(n: number) {
      if (typeof actual !== 'number' || actual < n) throw new Error(`Expected >= ${n}, got ${actual}`)
    },
    toHaveLength(n: number) {
      if (!Array.isArray(actual) || actual.length !== n) throw new Error(`Expected length ${n}, got ${Array.isArray(actual) ? actual.length : 'not array'}`)
    },
    toContain(item: unknown) {
      if (!Array.isArray(actual) || !actual.includes(item)) throw new Error(`Expected array to contain ${JSON.stringify(item)}`)
    },
    toThrow() {
      if (typeof actual !== 'function') throw new Error('Expected a function')
      try { (actual as () => void)(); throw new Error('Expected function to throw') } catch (e: unknown) {
        if (e instanceof Error && e.message === 'Expected function to throw') throw e
      }
    }
  }
}

export function describe(name: string, fn: () => void) {
  console.log(`\n${name}`)
  fn()
}
