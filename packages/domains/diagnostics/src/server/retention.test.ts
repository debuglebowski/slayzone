/**
 * Retention chunk tests
 */
import { describe, expect, test } from 'vitest'
import { createSlayzoneDbAdapter } from '../../../../shared/test-utils/ipc-harness.js'
import Database from 'better-sqlite3'
import {
  runBlobRetention,
  runRetentionChunk,
  runScheduledRetentionNow,
  startRetentionScheduler,
  stopRetentionScheduler
} from './retention.js'
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

describe('runRetentionChunk — cheap row-count proxy + bigger chunks', () => {
  // 1. Empty DB → no work
  test('empty DB → no work', async () => {
    const db = makeDb()
    const result = await runRetentionChunk(createSlayzoneDbAdapter(db), CONFIG, Date.now())
    expect(result.deleted).toBe(0)
    expect(result.moreWork).toBe(false)
    db.close()
  })

  // 2. Under hard cap, all rows fresh → no delete
  test('under cap, fresh rows → no delete', async () => {
    const db = makeDb()
    seed(db, 1000, Date.now()) // all rows ts = now → no expiry
    const result = await runRetentionChunk(createSlayzoneDbAdapter(db), CONFIG, Date.now())
    expect(result.deleted).toBe(0)
    expect(rowCount(db)).toBe(1000)
    db.close()
  })

  // 3. Over hard cap → delete oldest, up to CHUNK_LIMIT (10_000)
  test('over cap → deletes 10k chunk, signals moreWork', async () => {
    const db = makeDb()
    seed(db, 215_000, Date.now()) // 15k over cap of 200k
    const result = await runRetentionChunk(createSlayzoneDbAdapter(db), CONFIG, Date.now())
    // Chunks at 10_000; over by 15k → first chunk deletes min(15000, 10000) = 10_000
    expect(result.deleted).toBe(10_000)
    expect(result.moreWork).toBe(true) // still over cap after one chunk
    expect(rowCount(db)).toBe(205_000)
    db.close()
  })

  // 4. Rows older than retention window → deleted
  test('retention by date — expired rows dropped, fresh kept', async () => {
    const db = makeDb()
    const now = Date.now()
    const oldCutoff = now - 30 * 24 * 60 * 60 * 1000 // 30 days ago
    seed(db, 500, oldCutoff) // these rows are all expired (older than 14d)
    seed(db, 500, now) // these are fresh

    const result = await runRetentionChunk(createSlayzoneDbAdapter(db), CONFIG, now)
    expect(result.deleted).toBe(500) // only the old ones
    expect(rowCount(db)).toBe(500) // fresh remain
    db.close()
  })

  // 5. CHUNK_LIMIT respected on date-based delete
  test('date-based delete respects 10k CHUNK_LIMIT', async () => {
    const db = makeDb()
    const now = Date.now()
    const oldCutoff = now - 30 * 24 * 60 * 60 * 1000
    seed(db, 12_000, oldCutoff) // 12k all expired

    const result = await runRetentionChunk(createSlayzoneDbAdapter(db), CONFIG, now)
    expect(result.deleted).toBe(10_000) // chunk limit
    expect(result.moreWork).toBe(true)
    expect(rowCount(db)).toBe(2_000)
    db.close()
  })

  // 6. approxRowCount handles non-contiguous rowids correctly
  test('tolerates rowid gaps — overestimate harmless under cap', async () => {
    const db = makeDb()
    const now = Date.now()
    seed(db, 100, now - 100) // fresh rows (last 100 ms)
    // Delete middle rows to create gaps — rowid math overestimates but that's OK
    db.exec(`DELETE FROM diagnostics_events WHERE ts_ms BETWEEN ${now - 80} AND ${now - 20}`)
    // 39 rows remain; rowid math says ~100; still under cap, all fresh
    const result = await runRetentionChunk(createSlayzoneDbAdapter(db), CONFIG, now)
    expect(result.deleted).toBe(0) // not over cap, not expired
    db.close()
  })

  // 7. incremental_vacuum actually frees pages (auto_vacuum=INCREMENTAL)
  test('incremental_vacuum reclaims disk', async () => {
    const db = makeDb(true) // auto_vacuum on
    const now = Date.now()
    const oldCutoff = now - 30 * 24 * 60 * 60 * 1000
    seed(db, 5_000, oldCutoff) // expired
    const pagesBefore = db.pragma('page_count', { simple: true }) as number
    await runRetentionChunk(createSlayzoneDbAdapter(db), CONFIG, now)
    const pagesAfter = db.pragma('page_count', { simple: true }) as number
    expect(pagesAfter, `pages should shrink from ${pagesBefore}`).toBeLessThan(pagesBefore)
    db.close()
  })
})

describe('runBlobRetention — payload blobs pruned with the rows', () => {
  // 8. Blobs past the retention window are deleted, using the SAME retentionDays
  //    as the event rows. Row deletion reclaims no disk on its own, so without
  //    this step the offloaded screenshots leaked forever.
  test('blobs older than retentionDays are deleted', async () => {
    const now = Date.now()
    const dayMs = 24 * 60 * 60 * 1000
    const removed: string[] = []
    const files = [
      { name: 'old.png', sizeBytes: 1024, mtimeMs: now - 20 * dayMs }, // > 14d
      { name: 'fresh.png', sizeBytes: 1024, mtimeMs: now - 1 * dayMs }
    ]
    const result = runBlobRetention(CONFIG, now, {
      list: () => files.filter((f) => !removed.includes(f.name)),
      remove: (name) => {
        removed.push(name)
      }
    })
    expect(result.deleted).toBe(1)
    expect(removed.join(',')).toBe('old.png')
  })

  // 9. A failing filesystem must not throw into the retention tick.
  test('an unreadable blob dir is survivable', async () => {
    const result = runBlobRetention(CONFIG, Date.now(), {
      list: () => {
        throw new Error('ENOENT')
      },
      remove: () => {}
    })
    expect(result.deleted).toBe(0)
  })
})

describe('scheduler — retention is independent of recording', () => {
  // 10. Turning recording OFF must not freeze what was already recorded: `enabled`
  //     gates new events, retention bounds the disk. Skipping the pass while
  //     disabled kept every row and blob of someone who opted out, forever.
  test('prunes expired rows and blobs while recording is off', async () => {
    const now = Date.now()
    const dayMs = 24 * 60 * 60 * 1000
    const db = makeDb()
    seed(db, 3, now - 20 * dayMs) // past the 14-day window
    seed(db, 2, now) // fresh
    const removed: string[] = []
    startRetentionScheduler({
      getDb: () => createSlayzoneDbAdapter(db),
      getConfig: () => ({ ...CONFIG, enabled: false }),
      now: () => now,
      blobFs: {
        list: () =>
          [{ name: 'old.png', sizeBytes: 1, mtimeMs: now - 20 * dayMs }].filter(
            (f) => !removed.includes(f.name)
          ),
        remove: (name) => {
          removed.push(name)
        }
      }
    })
    try {
      expect(await runScheduledRetentionNow()).toBe(true)
      expect(rowCount(db)).toBe(2)
      expect(removed.join(',')).toBe('old.png')
    } finally {
      stopRetentionScheduler()
      db.close()
    }
  })

  // 11. No DB bound yet → nothing to prune, and no throw.
  test('an unbound DB is a no-op; a stopped scheduler runs nothing', async () => {
    startRetentionScheduler({ getDb: () => null, getConfig: () => CONFIG })
    try {
      expect(await runScheduledRetentionNow()).toBe(true)
    } finally {
      stopRetentionScheduler()
    }
    expect(await runScheduledRetentionNow()).toBe(false)
  })
})
