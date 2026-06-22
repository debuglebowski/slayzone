/**
 * Diagnostics service handler contract tests
 * Run with: ELECTRON_RUN_AS_NODE=1 npx electron --import tsx/esm --loader ./packages/shared/test-utils/loader.ts packages/domains/diagnostics/src/main/service.test.ts
 */
import {
  createTestHarness,
  test,
  expect,
  describe
} from '../../../../shared/test-utils/ipc-harness.js'
import { registerDiagnosticsHandlers, stopDiagnostics } from './service.js'
// Import via the SAME specifier service.ts uses ('../server') so we share its
// module instance — hence the same write-queue the handler fills.
import { flushWriteQueue } from '../server'
import { dialog } from 'electron'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'

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
registerDiagnosticsHandlers(h.ipcMain as never, h.db, h.db)

// instrumentIpcMain wraps handlers as async, so all invoke() calls return Promises.
// Run tests sequentially via top-level await to avoid ordering issues.

async function run() {
  console.log('\ndiagnostics:getConfig')
  {
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
    console.log('  \u2713 returns default config')
  }

  console.log('\ndiagnostics:setConfig')
  {
    const config = (await h.invoke('diagnostics:setConfig', { verbose: true })) as {
      enabled: boolean
      verbose: boolean
      retentionDays: number
    }
    expect(config.verbose).toBe(true)
    expect(config.enabled).toBe(true)
    expect(config.retentionDays).toBe(14)
    console.log('  \u2713 updates partial config')
  }
  {
    const config = (await h.invoke('diagnostics:setConfig', { retentionDays: 7 })) as {
      retentionDays: number
    }
    expect(config.retentionDays).toBe(7)
    console.log('  \u2713 updates retention days')
  }
  {
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
    console.log('  \u2713 roundtrips full config')
  }

  console.log('\ndiagnostics:recordClientError')
  {
    await h.invoke('diagnostics:setConfig', { enabled: true })
    await h.invoke('diagnostics:recordClientError', {
      type: 'error',
      message: 'Test error',
      stack: 'Error: Test\n  at test.ts:1'
    })
    console.log('  \u2713 does not throw')
  }

  console.log('\ndiagnostics:recordClientEvent')
  {
    await h.invoke('diagnostics:recordClientEvent', {
      event: 'test.event',
      level: 'info',
      message: 'Test event message'
    })
    console.log('  \u2713 does not throw')
  }

  // The per-invoke IPC instrumentation records its diagnostic events
  // fire-and-forget AFTER the handler returns, so let them settle, THEN drain
  // the batched write queue to the DB deterministically (a bare flush raced the
  // not-yet-queued instrumentation; a bare sleep raced the batch flush under
  // full-suite load → export read 0 events).
  await new Promise((r) => setTimeout(r, 50))
  await flushWriteQueue()

  console.log('\ndiagnostics:export')
  {
    // Test canceled export
    const canceled = (await h.invoke('diagnostics:export', {
      fromTsMs: 0,
      toTsMs: Date.now() + 10000
    })) as { success: boolean; canceled?: boolean }
    expect(canceled.success).toBe(false)
    expect(canceled.canceled).toBe(true)
    console.log('  \u2713 returns canceled when dialog dismissed')
  }
  {
    // Patch dialog to return a real tmp file path
    const tmpFile = path.join(os.tmpdir(), `slayzone-diag-test-${Date.now()}.json`)
    const original = dialog.showSaveDialog
    ;(dialog as any).showSaveDialog = async () => ({ canceled: false, filePath: tmpFile })

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
      console.log('  \u2713 exports bundle to file')

      // Cleanup
      fs.unlinkSync(tmpFile)
    } finally {
      ;(dialog as any).showSaveDialog = original
    }
  }
}

try {
  await run()
} catch (e) {
  console.error(`  \u2717 ${e}`)
  process.exitCode = 1
}

await new Promise((r) => setTimeout(r, 50))
stopDiagnostics()
h.cleanup()
console.log('\nDone')
