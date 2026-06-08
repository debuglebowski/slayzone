/**
 * Retention chunk tests
 * Run with: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron --import tsx/esm --loader ./packages/shared/test-utils/loader.ts packages/domains/diagnostics/src/main/retention.test.ts
 */
import { expect } from '../../../../shared/test-utils/ipc-harness.js'
import Database from 'better-sqlite3'
import { runRetentionChunk } from './retention.js'
import type { DiagnosticsConfig } from '../shared/index.js'

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

const CONFIG: DiagnosticsConfig = {
  enabled: true,
  verbose: false,
  includePtyOutput: false,
  retentionDays: 14
}

function makeDb(autoVacuum: boolean = false): Database.Database {
  const db = new Database(':memory:')
  if (autoVacuum) db.pragma('auto_vacuum = INCREMENTAL')
  db.exec(SCHEMA)
  return db
}

function seed(db: Database.Database, count: number, startTs: number = 0): void {
  const stmt = db.prepare(`
    INSERT INTO diagnostics_events (id, ts_ms, level, source, event)
    VALUES (?, ?, 'info', 'test', 'test.event')
  `)
  const txn = db.transaction(() => {
    for (let i = 0; i < count; i++) {
      stmt.run(`r-${startTs + i}`, startTs + i)
    }
  })
  txn()
}

function rowCount(db: Database.Database): number {
  return (db.prepare('SELECT COUNT(*) as c FROM diagnostics_events').get() as { c: number }).c
}

async function run(): Promise<void> {
  console.log('\nrunRetentionChunk — cheap row-count proxy + bigger chunks')

  // 1. Empty DB → no work
  {
    const db = makeDb()
    const result = runRetentionChunk(db, CONFIG, Date.now())
    expect(result.deleted).toBe(0)
    expect(result.moreWork).toBe(false)
    db.close()
    console.log('  ✓ empty DB → no work')
  }

  // 2. Under hard cap, all rows fresh → no delete
  {
    const db = makeDb()
    seed(db, 1000, Date.now()) // all rows ts = now → no expiry
    const result = runRetentionChunk(db, CONFIG, Date.now())
    expect(result.deleted).toBe(0)
    expect(rowCount(db)).toBe(1000)
    db.close()
    console.log('  ✓ under cap, fresh rows → no delete')
  }

  // 3. Over hard cap → delete oldest, up to CHUNK_LIMIT (10_000)
  {
    const db = makeDb()
    seed(db, 215_000, Date.now()) // 15k over cap of 200k
    const result = runRetentionChunk(db, CONFIG, Date.now())
    // Chunks at 10_000; over by 15k → first chunk deletes min(15000, 10000) = 10_000
    expect(result.deleted).toBe(10_000)
    expect(result.moreWork).toBe(true) // still over cap after one chunk
    expect(rowCount(db)).toBe(205_000)
    db.close()
    console.log('  ✓ over cap → deletes 10k chunk, signals moreWork')
  }

  // 4. Rows older than retention window → deleted
  {
    const db = makeDb()
    const now = Date.now()
    const oldCutoff = now - 30 * 24 * 60 * 60 * 1000 // 30 days ago
    seed(db, 500, oldCutoff) // these rows are all expired (older than 14d)
    seed(db, 500, now) // these are fresh

    const result = runRetentionChunk(db, CONFIG, now)
    expect(result.deleted).toBe(500) // only the old ones
    expect(rowCount(db)).toBe(500) // fresh remain
    db.close()
    console.log('  ✓ retention by date — expired rows dropped, fresh kept')
  }

  // 5. CHUNK_LIMIT respected on date-based delete
  {
    const db = makeDb()
    const now = Date.now()
    const oldCutoff = now - 30 * 24 * 60 * 60 * 1000
    seed(db, 12_000, oldCutoff) // 12k all expired

    const result = runRetentionChunk(db, CONFIG, now)
    expect(result.deleted).toBe(10_000) // chunk limit
    expect(result.moreWork).toBe(true)
    expect(rowCount(db)).toBe(2_000)
    db.close()
    console.log('  ✓ date-based delete respects 10k CHUNK_LIMIT')
  }

  // 6. approxRowCount handles non-contiguous rowids correctly
  {
    const db = makeDb()
    const now = Date.now()
    seed(db, 100, now - 100) // fresh rows (last 100 ms)
    // Delete middle rows to create gaps — rowid math overestimates but that's OK
    db.exec(`DELETE FROM diagnostics_events WHERE ts_ms BETWEEN ${now - 80} AND ${now - 20}`)
    // 39 rows remain; rowid math says ~100; still under cap, all fresh
    const result = runRetentionChunk(db, CONFIG, now)
    expect(result.deleted).toBe(0) // not over cap, not expired
    db.close()
    console.log('  ✓ tolerates rowid gaps — overestimate harmless under cap')
  }

  // 7. incremental_vacuum actually frees pages (auto_vacuum=INCREMENTAL)
  {
    const db = makeDb(true) // auto_vacuum on
    const now = Date.now()
    const oldCutoff = now - 30 * 24 * 60 * 60 * 1000
    seed(db, 5_000, oldCutoff) // expired
    const pagesBefore = db.pragma('page_count', { simple: true }) as number
    runRetentionChunk(db, CONFIG, now)
    const pagesAfter = db.pragma('page_count', { simple: true }) as number
    if (pagesAfter >= pagesBefore) {
      throw new Error(`Expected pages to shrink, got ${pagesBefore} → ${pagesAfter}`)
    }
    db.close()
    console.log(`  ✓ incremental_vacuum reclaims disk (${pagesBefore} → ${pagesAfter} pages)`)
  }
}

try {
  await run()
} catch (e) {
  console.error(`  ✗ ${e}`)
  if (e instanceof Error && e.stack) console.error(e.stack)
  process.exitCode = 1
}

console.log('\nDone')
