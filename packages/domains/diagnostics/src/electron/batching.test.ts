/**
 * Batched async write tests
 */
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { createSlayzoneDbAdapter } from '../../../../shared/test-utils/ipc-harness.js'
import Database from 'better-sqlite3'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { registerDiagnosticsHandlers, stopDiagnostics } from './service.js'
// The write queue lives in the electron-free data core. `service.ts` imports
// these but never re-exported them, so importing them from there threw at module
// load — the whole file failed before a single assertion ran, and it is not in
// run-all.sh, so nothing reported it.
//
// Import via `../server` — the SAME specifier service.ts uses. Reaching for
// `../server/diagnostics-store.js` instead resolves to a second ESM module
// instance, giving this file its own write queue: `recordDiagnosticEvent` fills
// one and `flushWriteQueue` drains the other, so every row count reads 0.
import { recordDiagnosticEvent, flushWriteQueue } from '../server/index.js'

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

// The store writes through the async `SlayzoneDb` surface (`batchTxn`). Handing
// it the raw better-sqlite3 handle made every flush throw inside the store's
// swallow-all catch, so every row count read 0. `eventsDb` is the raw handle for
// assertions; `slayDb` is the adapter over the SAME connection, given to the store.
function makeHarness(): {
  eventsDb: Database.Database
  slayDb: ReturnType<typeof createSlayzoneDbAdapter>
  ipcMain: {
    handle: (c: string, h: (...a: unknown[]) => unknown) => void
    handlers: Map<string, (...a: unknown[]) => unknown>
  }
  reset: () => void
} {
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
    eventsDb,
    slayDb: createSlayzoneDbAdapter(eventsDb),
    ipcMain,
    reset() {
      eventsDb.exec('DELETE FROM diagnostics_events')
    }
  }
}

function countRows(db: Database.Database): number {
  return (db.prepare('SELECT COUNT(*) as c FROM diagnostics_events').get() as { c: number }).c
}

// Flushes are async (worker-thread DB in production). A flush the store kicks
// off on its own (error level, batch size) lands within a macrotask; the 2s
// interval timer does not — so this separates "flushed now" from "flushed later".
function settle(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

describe('batched writes', () => {
  const clientRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'slay-diag-batching-'))
  const h = makeHarness()
  // `clientRoot` is MANDATORY here, not tidiness: diagnostics config now comes
  // from the client store, and without an injected root this resolves
  // `getClientRoot()` — the developer's real ~/.slayzone — and case 7 below
  // writes to it. Signature is (ipcMain, eventsDb, options); it used to take the
  // shared settings DB as its second argument, and this call was left behind when
  // that parameter went away.
  beforeAll(() => {
    registerDiagnosticsHandlers(h.ipcMain as never, h.slayDb, {
      clientRoot,
      blobDir: path.join(clientRoot, 'diagnostics')
    })
  })

  afterAll(async () => {
    // Always stop: a failed case left the 2s flush timer pending, which kept the
    // process alive forever. Idempotent after the in-test stop.
    await stopDiagnostics()
    fs.rmSync(clientRoot, { recursive: true, force: true })
  })

  // 1. enqueue does not write immediately
  test('recordDiagnosticEvent does not write immediately', async () => {
    h.reset()
    recordDiagnosticEvent({
      level: 'info',
      source: 'diagnostics',
      event: 'test.batch',
      message: 'one'
    })
    expect(countRows(h.eventsDb)).toBe(0)
    await settle()
    expect(countRows(h.eventsDb)).toBe(0)
  })

  // 2. flushWriteQueue drains
  test('flushWriteQueue drains queue into single transaction', async () => {
    await flushWriteQueue()
    expect(countRows(h.eventsDb)).toBe(1)
  })

  // 3. error events flush immediately
  test('error-level events flush immediately', async () => {
    h.reset()
    recordDiagnosticEvent({
      level: 'error',
      source: 'diagnostics',
      event: 'test.err',
      message: 'boom'
    })
    await settle()
    expect(countRows(h.eventsDb)).toBe(1)
  })

  // 4. batch size triggers flush
  test('flushes on reaching WRITE_BATCH_SIZE (1000)', async () => {
    h.reset()
    // Enqueue 999 — below batch threshold (1000)
    for (let i = 0; i < 999; i++) {
      recordDiagnosticEvent({
        level: 'info',
        source: 'diagnostics',
        event: 'test.batch',
        message: `n-${i}`
      })
    }
    await settle()
    expect(countRows(h.eventsDb)).toBe(0)

    // 1000th triggers flush
    recordDiagnosticEvent({
      level: 'info',
      source: 'diagnostics',
      event: 'test.batch',
      message: 'n-999'
    })
    await settle()
    expect(countRows(h.eventsDb)).toBe(1000)
  })

  // 5. queue cap drops events under runaway load
  test('3500 events under load all preserved when flush keeps up', async () => {
    h.reset()
    await flushWriteQueue() // clear any residue

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
        source: 'diagnostics',
        event: 'test.bulk',
        message: `b-${i}`
      })
    }
    await flushWriteQueue()
    expect(countRows(h.eventsDb)).toBe(TOTAL)
  })

  // 6. debug events dropped when !verbose
  test('debug events dropped when verbose=false (default)', async () => {
    h.reset()
    recordDiagnosticEvent({
      level: 'debug',
      source: 'diagnostics',
      event: 'test.debug',
      message: 'should-drop'
    })
    await flushWriteQueue()
    expect(countRows(h.eventsDb)).toBe(0)
  })

  // 7. debug events kept when verbose
  test('debug events kept when verbose=true', async () => {
    h.reset()
    // Config lives in the client store under `clientRoot`; the setConfig IPC
    // handler persists it there and refreshes the store's cache.
    const setConfig = h.ipcMain.handlers.get('diagnostics:setConfig')!
    await setConfig({}, { verbose: true })

    recordDiagnosticEvent({
      level: 'debug',
      source: 'diagnostics',
      event: 'test.debug',
      message: 'should-keep'
    })
    await flushWriteQueue()
    expect(countRows(h.eventsDb)).toBe(2) // setConfig records db.mutation too
  })

  // 8. queue cap drops are surfaced via diag.dropped event
  test('queue cap drops surfaced as diag.dropped event (count=1000)', async () => {
    // Drain any residue from prior tests, then reset verbose=false and drain
    // the setConfig noise so test 8 starts with a clean queue.
    await flushWriteQueue()
    const setConfig = h.ipcMain.handlers.get('diagnostics:setConfig')!
    await setConfig({}, { verbose: false })
    await flushWriteQueue()
    h.reset() // wipe eventsDb rows

    // Close the events DB so the queue accumulates. The batch-size flushes this
    // loop kicks off are async and only drain after the rebind below.
    h.eventsDb.close()

    const OVERFLOW = 6_000 // 1000 over the 5000 cap
    for (let i = 0; i < OVERFLOW; i++) {
      recordDiagnosticEvent({
        level: 'info',
        source: 'diagnostics',
        event: 'test.overflow',
        message: `o-${i}`
      })
    }

    // Re-open eventsDb and rewire so flush has somewhere to write.
    const fresh = new Database(':memory:')
    fresh.exec(DIAG_SCHEMA)
    registerDiagnosticsHandlers(h.ipcMain as never, createSlayzoneDbAdapter(fresh), {
      clientRoot,
      blobDir: path.join(clientRoot, 'diagnostics')
    })

    await flushWriteQueue()

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

    // Stop while `fresh` is still open so the final flush has somewhere to write.
    await stopDiagnostics()
    fresh.close()
  })
})
