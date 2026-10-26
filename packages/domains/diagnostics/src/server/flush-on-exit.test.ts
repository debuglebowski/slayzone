/**
 * The periodic write-queue flush timer must never keep a process alive, and an
 * event still queued when the process exits naturally must not be lost.
 *
 * Runs itself as a child: the child binds a file-backed diagnostics DB, records
 * one info event (queued behind the 2s flush timer) and returns. The parent
 * asserts the child exited well before that timer, and that the row landed.
 *
 * Run with: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron --import tsx/esm --experimental-loader ./packages/shared/test-utils/loader.ts packages/domains/diagnostics/src/server/flush-on-exit.test.ts
 */
import Database from 'better-sqlite3'
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { expect, createSlayzoneDbAdapter } from '../../../../shared/test-utils/ipc-harness.js'
import { bindDiagnosticsDbs, recordDiagnosticEvent } from './index.js'

const CHILD_DB_ENV = 'SLAYZONE_TEST_DIAG_EXIT_DB_PATH'

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
`

const childDbPath = process.env[CHILD_DB_ENV]

if (childDbPath) {
  const raw = new Database(childDbPath)
  bindDiagnosticsDbs({
    diagnosticsDb: createSlayzoneDbAdapter(raw),
    blobDir: path.join(path.dirname(childDbPath), 'blobs')
  })
  recordDiagnosticEvent({
    level: 'info',
    source: 'diagnostics',
    event: 'test.exit',
    message: 'queued'
  })
  // Nothing else: the process must now exit on its own, flushing first.
} else {
  console.log('\nwrite-queue flush on exit')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slay-diag-exit-'))
  try {
    const dbPath = path.join(dir, 'diagnostics.sqlite')
    const setup = new Database(dbPath)
    setup.exec(DIAG_SCHEMA)
    setup.close()

    const started = Date.now()
    const child = spawnSync(process.execPath, [...process.execArgv, import.meta.filename], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', [CHILD_DB_ENV]: dbPath },
      encoding: 'utf8',
      timeout: 15_000
    })
    const elapsed = Date.now() - started
    if (child.status !== 0) console.error(child.stdout, child.stderr)
    expect(child.status).toBe(0)

    // Baseline: the child's own startup (tsx + loader) with the timer cleared.
    // The 2s timer holding the loop pushes it past startup + 2000ms.
    const baseline = spawnSync(process.execPath, [...process.execArgv, '-e', ''], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      timeout: 15_000
    })
    expect(baseline.status).toBe(0)
    const startupMs = Date.now() - started - elapsed
    if (elapsed >= startupMs + 1500) {
      throw new Error(`child took ${elapsed}ms vs ~${startupMs}ms startup: the flush timer held it`)
    }
    console.log(
      `  ✓ queued event does not hold the process open (${elapsed}ms, startup ~${startupMs}ms)`
    )

    const check = new Database(dbPath, { readonly: true })
    const rows = check.prepare(`SELECT message FROM diagnostics_events`).all() as {
      message: string
    }[]
    check.close()
    expect(rows.length).toBe(1)
    expect(rows[0].message).toBe('queued')
    console.log('  ✓ event queued at natural exit is flushed, not lost')
  } catch (e) {
    console.error(`  ✗ ${e}`)
    if (e instanceof Error && e.stack) console.error(e.stack)
    process.exitCode = 1
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
  console.log('\nDone')
}
