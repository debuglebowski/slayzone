/**
 * Self-heal unit tests
 * Run with: ELECTRON_RUN_AS_NODE=1 npx electron --import tsx/esm --loader ./packages/shared/test-utils/loader.ts packages/domains/diagnostics/src/main/self-heal.test.ts
 */
import { expect } from '../../../../shared/test-utils/ipc-harness.js'
import Database from 'better-sqlite3'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { selfHealDiagnosticsDb, mergeSalvage } from './self-heal.js'

const SCHEMA = `
  CREATE TABLE diagnostics_events (
    id TEXT PRIMARY KEY,
    ts_ms INTEGER NOT NULL,
    level TEXT NOT NULL,
    source TEXT NOT NULL,
    event TEXT NOT NULL,
    trace_id TEXT,
    task_id TEXT,
    project_id TEXT,
    session_id TEXT,
    channel TEXT,
    message TEXT,
    payload_json TEXT,
    redaction_version INTEGER NOT NULL DEFAULT 1
  );
  CREATE INDEX idx_diag_ts ON diagnostics_events(ts_ms);
`

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'slayzone-self-heal-'))
}

function seedDb(dbPath: string, rowCount: number, startTs = 0): void {
  const db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  db.exec(SCHEMA)
  const stmt = db.prepare(`
    INSERT INTO diagnostics_events (id, ts_ms, level, source, event)
    VALUES (?, ?, 'info', 'test', 'test.event')
  `)
  const txn = db.transaction(() => {
    for (let i = 0; i < rowCount; i++) {
      stmt.run(`row-${startTs + i}`, startTs + i)
    }
  })
  txn()
  db.close()
}

function padToSize(dbPath: string, targetBytes: number): void {
  const current = fs.statSync(dbPath).size
  if (current >= targetBytes) return
  const fd = fs.openSync(dbPath, 'r+')
  try {
    fs.ftruncateSync(fd, targetBytes)
  } finally {
    fs.closeSync(fd)
  }
}

async function run(): Promise<void> {
  console.log('\nselfHealDiagnosticsDb')

  // 1. Missing file → no-op
  {
    const dir = makeTempDir()
    const dbPath = path.join(dir, 'diag.sqlite')
    const result = selfHealDiagnosticsDb(dbPath)
    expect(result.rotated).toBe(false)
    expect(fs.existsSync(dbPath)).toBe(false)
    fs.rmSync(dir, { recursive: true })
    console.log('  ✓ missing file → no-op')
  }

  // 2. Small file → no rotation
  {
    const dir = makeTempDir()
    const dbPath = path.join(dir, 'diag.sqlite')
    seedDb(dbPath, 10)
    const result = selfHealDiagnosticsDb(dbPath)
    expect(result.rotated).toBe(false)
    expect(fs.existsSync(dbPath)).toBe(true)
    fs.rmSync(dir, { recursive: true })
    console.log('  ✓ small file → no rotation')
  }

  // 3. Oversize → rotated to .salvage.<ts>.sqlite, original gone
  {
    const dir = makeTempDir()
    const dbPath = path.join(dir, 'diag.sqlite')
    seedDb(dbPath, 10)
    padToSize(dbPath, 600 * 1024 * 1024)
    const result = selfHealDiagnosticsDb(dbPath)
    expect(result.rotated).toBe(true)
    expect(result.salvagePath).toBeTruthy()
    expect(fs.existsSync(dbPath)).toBe(false)
    expect(fs.existsSync(result.salvagePath!)).toBe(true)
    fs.rmSync(dir, { recursive: true })
    console.log('  ✓ oversize → rotated, original removed')
  }

  // 4. WAL/SHM sidecars rotate too
  {
    const dir = makeTempDir()
    const dbPath = path.join(dir, 'diag.sqlite')
    seedDb(dbPath, 10)
    fs.writeFileSync(`${dbPath}-wal`, Buffer.alloc(1024))
    fs.writeFileSync(`${dbPath}-shm`, Buffer.alloc(32))
    padToSize(dbPath, 600 * 1024 * 1024)
    const result = selfHealDiagnosticsDb(dbPath)
    expect(result.rotated).toBe(true)
    expect(fs.existsSync(`${dbPath}-wal`)).toBe(false)
    expect(fs.existsSync(`${dbPath}-shm`)).toBe(false)
    expect(fs.existsSync(`${result.salvagePath}-wal`)).toBe(true)
    fs.rmSync(dir, { recursive: true })
    console.log('  ✓ WAL+SHM rotated alongside main file')
  }

  console.log('\nmergeSalvage')

  // 5. Copies newest 100k rows by ts_ms DESC; older rows excluded
  {
    const dir = makeTempDir()
    const salvagePath = path.join(dir, 'old.sqlite')
    seedDb(salvagePath, 100_500) // 500 rows above limit

    const freshPath = path.join(dir, 'new.sqlite')
    const fresh = new Database(freshPath)
    fresh.exec(SCHEMA)

    const { inserted } = mergeSalvage(fresh, salvagePath)
    expect(inserted).toBe(100_000)

    const { min, max } = fresh
      .prepare('SELECT MIN(ts_ms) as min, MAX(ts_ms) as max FROM diagnostics_events')
      .get() as { min: number; max: number }
    expect(max).toBe(100_499) // newest preserved
    expect(min).toBe(500) // 500 oldest dropped
    fresh.close()
    fs.rmSync(dir, { recursive: true })
    console.log('  ✓ newest 100k by ts_ms DESC, older rows dropped')
  }

  // 6. INSERT OR IGNORE — id collisions skipped, no error
  {
    const dir = makeTempDir()
    const salvagePath = path.join(dir, 'old.sqlite')
    seedDb(salvagePath, 100) // ids "row-0".."row-99"

    const freshPath = path.join(dir, 'new.sqlite')
    const fresh = new Database(freshPath)
    fresh.exec(SCHEMA)
    const insertStmt = fresh.prepare(`
      INSERT INTO diagnostics_events (id, ts_ms, level, source, event)
      VALUES (?, ?, 'info', 'test', 'test.event')
    `)
    for (let i = 0; i < 50; i++) insertStmt.run(`row-${i}`, i)

    const { inserted } = mergeSalvage(fresh, salvagePath)
    expect(inserted).toBe(50) // only "row-50".."row-99" new

    const count = (
      fresh.prepare('SELECT COUNT(*) as c FROM diagnostics_events').get() as { c: number }
    ).c
    expect(count).toBe(100)
    fresh.close()
    fs.rmSync(dir, { recursive: true })
    console.log('  ✓ INSERT OR IGNORE — collisions skipped, no error')
  }

  // 7. Missing salvage file → no-op
  {
    const dir = makeTempDir()
    const freshPath = path.join(dir, 'new.sqlite')
    const fresh = new Database(freshPath)
    fresh.exec(SCHEMA)
    const result = mergeSalvage(fresh, path.join(dir, 'missing.sqlite'))
    expect(result.inserted).toBe(0)
    fresh.close()
    fs.rmSync(dir, { recursive: true })
    console.log('  ✓ missing salvage file → no-op')
  }
}

try {
  await run()
} catch (e) {
  console.error(`  ✗ ${e}`)
  process.exitCode = 1
}

console.log('\nDone')
