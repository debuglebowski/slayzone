/**
 * Batched async write tests
 * Run with: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron --import tsx/esm --loader ./packages/shared/test-utils/loader.ts packages/domains/diagnostics/src/main/batching.test.ts
 */
import { expect } from '../../../../shared/test-utils/ipc-harness.js'
import Database from 'better-sqlite3'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import {
  registerDiagnosticsHandlers,
  recordDiagnosticEvent,
  flushWriteQueue,
  stopDiagnostics
} from './service.js'

const DIAG_SCHEMA = `
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

const SETTINGS_SCHEMA = `
  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
  INSERT INTO settings (key, value) VALUES ('diagnostics_enabled', '1');
`

function makeHarness(): {
  settingsDb: Database.Database
  eventsDb: Database.Database
  ipcMain: {
    handle: (c: string, h: (...a: unknown[]) => unknown) => void
    handlers: Map<string, (...a: unknown[]) => unknown>
  }
  reset: () => void
} {
  const settingsDb = new Database(':memory:')
  settingsDb.exec(SETTINGS_SCHEMA)
  const eventsDb = new Database(':memory:')
  eventsDb.exec(DIAG_SCHEMA)
  const handlers = new Map<string, (...a: unknown[]) => unknown>()
  const ipcMain = {
    handle(c: string, h: (...a: unknown[]) => unknown) {
      handlers.set(c, h)
    },
    handlers
  }
  return {
    settingsDb,
    eventsDb,
    ipcMain,
    reset() {
      eventsDb.exec('DELETE FROM diagnostics_events')
    }
  }
}

function countRows(db: Database.Database): number {
  return (db.prepare('SELECT COUNT(*) as c FROM diagnostics_events').get() as { c: number }).c
}

async function run(): Promise<void> {
  console.log('\nbatched writes')

  const h = makeHarness()
  registerDiagnosticsHandlers(h.ipcMain as never, h.settingsDb, h.eventsDb)

  // 1. enqueue does not write immediately
  {
    h.reset()
    recordDiagnosticEvent({
      level: 'info',
      source: 'test',
      event: 'test.batch',
      message: 'one'
    })
    expect(countRows(h.eventsDb)).toBe(0)
    console.log('  ✓ recordDiagnosticEvent does not write synchronously')
  }

  // 2. flushWriteQueue drains
  {
    flushWriteQueue()
    expect(countRows(h.eventsDb)).toBe(1)
    console.log('  ✓ flushWriteQueue drains queue into single transaction')
  }

  // 3. error events flush immediately
  {
    h.reset()
    recordDiagnosticEvent({
      level: 'error',
      source: 'test',
      event: 'test.err',
      message: 'boom'
    })
    expect(countRows(h.eventsDb)).toBe(1)
    console.log('  ✓ error-level events flush synchronously')
  }

  // 4. batch size triggers flush
  {
    h.reset()
    // Enqueue 999 — below batch threshold (1000)
    for (let i = 0; i < 999; i++) {
      recordDiagnosticEvent({
        level: 'info',
        source: 'test',
        event: 'test.batch',
        message: `n-${i}`
      })
    }
    expect(countRows(h.eventsDb)).toBe(0)

    // 1000th triggers flush
    recordDiagnosticEvent({
      level: 'info',
      source: 'test',
      event: 'test.batch',
      message: 'n-999'
    })
    expect(countRows(h.eventsDb)).toBe(1000)
    console.log('  ✓ flushes on reaching WRITE_BATCH_SIZE (1000)')
  }

  // 5. queue cap drops events under runaway load
  {
    h.reset()
    flushWriteQueue() // clear any residue

    // Push WAY past the cap without flushing. We achieve this by using
    // info-level events and never flushing manually — each enqueue without
    // a sync trigger accumulates. But the 1000-cap will auto-flush at 1000.
    // So to test the 5000 cap, we'd need a path where flush is blocked.
    // Instead: verify the cap exists by checking writeQueue is bounded.
    // Disable flushing by closing eventsDb between enqueues? Tricky.
    // Pragmatic: just verify normal operation under heavy load doesn't lose
    // events when batches are draining properly.
    const TOTAL = 3500
    for (let i = 0; i < TOTAL; i++) {
      recordDiagnosticEvent({
        level: 'info',
        source: 'test',
        event: 'test.bulk',
        message: `b-${i}`
      })
    }
    flushWriteQueue()
    expect(countRows(h.eventsDb)).toBe(TOTAL)
    console.log('  ✓ 3500 events under load all preserved when flush keeps up')
  }

  // 6. debug events dropped when !verbose
  {
    h.reset()
    recordDiagnosticEvent({
      level: 'debug',
      source: 'test',
      event: 'test.debug',
      message: 'should-drop'
    })
    flushWriteQueue()
    expect(countRows(h.eventsDb)).toBe(0)
    console.log('  ✓ debug events dropped when verbose=false (default)')
  }

  // 7. debug events kept when verbose
  {
    h.reset()
    h.settingsDb
      .prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')
      .run('diagnostics_verbose', '1')
    // bust cache by calling setConfig path: easiest = directly poke via the public API
    // The cachedConfig invalidates only via saveDiagnosticsConfig. Without that, the
    // cache returns the old verbose=false value. Use the IPC handler to invalidate.
    const setConfig = h.ipcMain.handlers.get('diagnostics:setConfig')!
    await setConfig({}, { verbose: true })

    recordDiagnosticEvent({
      level: 'debug',
      source: 'test',
      event: 'test.debug',
      message: 'should-keep'
    })
    flushWriteQueue()
    expect(countRows(h.eventsDb)).toBe(2) // setConfig records db.mutation too
    console.log('  ✓ debug events kept when verbose=true')
  }

  // 8. queue cap drops are surfaced via diag.dropped event
  {
    // Drain any residue from prior tests, then reset verbose=false and drain
    // the setConfig noise so test 8 starts with a clean queue.
    flushWriteQueue()
    const setConfig = h.ipcMain.handlers.get('diagnostics:setConfig')!
    await setConfig({}, { verbose: false })
    flushWriteQueue()
    h.reset() // wipe eventsDb rows

    // Close the events DB so flushes no-op and the queue accumulates.
    h.eventsDb.close()

    const OVERFLOW = 6_000 // 1000 over the 5000 cap
    for (let i = 0; i < OVERFLOW; i++) {
      recordDiagnosticEvent({
        level: 'info',
        source: 'test',
        event: 'test.overflow',
        message: `o-${i}`
      })
    }

    // Re-open eventsDb and rewire so flush has somewhere to write.
    const fresh = new Database(':memory:')
    fresh.exec(DIAG_SCHEMA)
    registerDiagnosticsHandlers(h.ipcMain as never, h.settingsDb, fresh)

    flushWriteQueue()

    // 5000 buffered + 1 synthetic diag.dropped event = 5001
    expect(countRows(fresh)).toBe(5001)

    const dropEvent = fresh
      .prepare(
        `SELECT level, source, event, payload_json FROM diagnostics_events WHERE event = 'diag.dropped'`
      )
      .get() as { level: string; source: string; event: string; payload_json: string } | undefined

    expect(dropEvent).toBeTruthy()
    expect(dropEvent!.level).toBe('warn')
    expect(dropEvent!.source).toBe('diagnostics')
    const payload = JSON.parse(dropEvent!.payload_json) as {
      droppedCount: number
      queueCap: number
    }
    expect(payload.droppedCount).toBe(1000)
    expect(payload.queueCap).toBe(5000)

    fresh.close()
    console.log('  ✓ queue cap drops surfaced as diag.dropped event (count=1000)')
  }

  stopDiagnostics()
  h.settingsDb.close()
}

try {
  await run()
} catch (e) {
  console.error(`  ✗ ${e}`)
  if (e instanceof Error && e.stack) console.error(e.stack)
  process.exitCode = 1
}

console.log('\nDone')
