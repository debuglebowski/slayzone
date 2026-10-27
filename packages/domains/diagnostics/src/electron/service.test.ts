/**
 * Diagnostics service handler contract tests
 */
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { createTestHarness } from '../../../../shared/test-utils/ipc-harness.js'
import { registerDiagnosticsHandlers, stopDiagnostics } from './service.js'
import { dialog } from 'electron'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'

// Diagnostics config is client-local now; point it at a throwaway dir so the test
// never reads or writes the developer's real ~/.slayzone.
const testClientRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'slay-diag-client-'))

const h = await createTestHarness()
// The diagnostics events table lives in a SEPARATE diagnostics DB in prod, so
// the harness migrations don't create it — set it up here (matches the sibling
// diagnostics suites' DIAG_SCHEMA). h.db doubles as both settings + events DB.
h.db.exec(`
  CREATE TABLE IF NOT EXISTS diagnostics_events (
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
  CREATE INDEX IF NOT EXISTS idx_diag_ts ON diagnostics_events(ts_ms);
`)
// Pass the async `SlayzoneDb` adapter (not the raw better-sqlite3 handle): the
// store moved to the worker-thread DB interface and drains events via
// `diagnosticsDb.batchTxn(...)`, which the raw handle doesn't expose (the insert
// would throw + get swallowed → 0 events persisted). slayDb wraps the SAME
// in-memory connection the schema above was created on.
registerDiagnosticsHandlers(h.ipcMain as never, h.slayDb, {
  clientRoot: testClientRoot,
  blobDir: path.join(testClientRoot, 'diagnostics')
})

// instrumentIpcMain wraps handlers as async, so all invoke() calls return Promises.
// vitest runs this file's tests sequentially in declaration order; later ones
// depend on the config earlier ones wrote.

describe('diagnostics:getConfig', () => {
  test('returns default config', async () => {
    const config = (await h.invoke('diagnostics:getConfig')) as {
      enabled: boolean
      verbose: boolean
      includePtyOutput: boolean
      retentionDays: number
    }
    expect(config.enabled).toBe(true)
    expect(config.verbose).toBe(false)
    expect(config.includePtyOutput).toBe(false)
    expect(config.retentionDays).toBe(14)
  })
})

describe('diagnostics:setConfig', () => {
  test('updates partial config', async () => {
    const config = (await h.invoke('diagnostics:setConfig', { verbose: true })) as {
      enabled: boolean
      verbose: boolean
      retentionDays: number
    }
    expect(config.verbose).toBe(true)
    expect(config.enabled).toBe(true)
    expect(config.retentionDays).toBe(14)
  })
  test('updates retention days', async () => {
    const config = (await h.invoke('diagnostics:setConfig', { retentionDays: 7 })) as {
      retentionDays: number
    }
    expect(config.retentionDays).toBe(7)
  })
  test('roundtrips full config', async () => {
    await h.invoke('diagnostics:setConfig', {
      enabled: false,
      verbose: false,
      includePtyOutput: true,
      retentionDays: 30
    })
    const config = (await h.invoke('diagnostics:getConfig')) as {
      enabled: boolean
      verbose: boolean
      includePtyOutput: boolean
      retentionDays: number
    }
    expect(config.enabled).toBe(false)
    expect(config.verbose).toBe(false)
    expect(config.includePtyOutput).toBe(true)
    expect(config.retentionDays).toBe(30)
  })
})

describe('diagnostics:recordClientError', () => {
  test('does not throw', async () => {
    await h.invoke('diagnostics:setConfig', { enabled: true })
    await h.invoke('diagnostics:recordClientError', {
      type: 'error',
      message: 'Test error',
      stack: 'Error: Test\n  at test.ts:1'
    })
  })
})

describe('diagnostics:recordClientEvent', () => {
  test('does not throw', async () => {
    await h.invoke('diagnostics:recordClientEvent', {
      event: 'test.event',
      level: 'info',
      message: 'Test event message'
    })
  })
})

describe('diagnostics:export', () => {
  // The per-invoke IPC instrumentation records its diagnostic events
  // fire-and-forget AFTER the handler returns, and the batched write queue
  // drains to the DB on a timer — a fixed sleep raced both under full-suite
  // load. Poll the DB (load-independent) until the events land, then assert.
  beforeAll(async () => {
    for (let i = 0; i < 200; i++) {
      const { c } = h.db.prepare('SELECT COUNT(*) AS c FROM diagnostics_events').get() as {
        c: number
      }
      if (c > 0) break
      await new Promise((r) => setTimeout(r, 20))
    }
  })

  test('returns canceled when dialog dismissed', async () => {
    // Test canceled export
    const canceled = (await h.invoke('diagnostics:export', {
      fromTsMs: 0,
      toTsMs: Date.now() + 10000
    })) as { success: boolean; canceled?: boolean }
    expect(canceled.success).toBe(false)
    expect(canceled.canceled).toBe(true)
  })
  test('exports bundle to file', async () => {
    // Patch dialog to return a real tmp file path
    const tmpFile = path.join(testClientRoot, `slayzone-diag-test-${Date.now()}.json`)
    const original = dialog.showSaveDialog
    // The stub answers only the one overload the exporter calls, so the slot is
    // re-typed as `unknown` rather than electron's full overloaded signature.
    const dialogSlot = dialog as unknown as { showSaveDialog: unknown }
    dialogSlot.showSaveDialog = async () => ({ canceled: false, filePath: tmpFile })

    try {
      const result = (await h.invoke('diagnostics:export', {
        fromTsMs: 0,
        toTsMs: Date.now() + 10000
      })) as { success: boolean; path?: string; eventCount?: number }
      expect(result.success).toBe(true)
      expect(result.eventCount).toBeGreaterThan(0)

      // Verify file was written with valid JSON
      const bundle = JSON.parse(fs.readFileSync(tmpFile, 'utf-8'))
      expect(bundle.meta).toBeTruthy()
      expect(bundle.events).toBeTruthy()
      expect(bundle.summary).toBeTruthy()
      expect(bundle.summary.total).toBeGreaterThan(0)

      // Cleanup
      fs.unlinkSync(tmpFile)
    } finally {
      dialogSlot.showSaveDialog = original
    }
  })
})

afterAll(async () => {
  await new Promise((r) => setTimeout(r, 50))
  stopDiagnostics()
  h.cleanup()
  fs.rmSync(testClientRoot, { recursive: true, force: true })
})
