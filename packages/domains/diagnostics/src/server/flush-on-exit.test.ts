/**
 * The periodic write-queue flush timer must never keep a process alive, and an
 * event still queued when the process exits naturally must not be lost.
 *
 * Runs itself as a child: the child binds a file-backed diagnostics DB, records
 * one info event (queued behind the 2s flush timer) and returns. The child then
 * reports the DB row count at two lifecycle points, read synchronously:
 *   - the FIRST `beforeExit` (the event loop drained) — must be 0: the event is
 *     still queued, i.e. the armed timer did not keep the loop alive. A ref'd
 *     timer holds the loop until it fires and flushes, so the row would already
 *     be there by the time the loop first drains.
 *   - `exit` — must be 1: the beforeExit flush landed before the process exited.
 * Lifecycle ordering, not wall-clock: holds however slow the host is.
 *
 * The child runs under plain Electron-as-node + tsx (not vitest), so it gets
 * explicit tsx + loader flags rather than this worker's `process.execArgv`.
 */
import Database from 'better-sqlite3'
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import { createRequire } from 'node:module'
import * as os from 'node:os'
import * as path from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, describe, expect, test } from 'vitest'
import { createSlayzoneDbAdapter } from '../../../../shared/test-utils/ipc-harness.js'
import { bindDiagnosticsDbs, recordDiagnosticEvent } from './index.js'

const CHILD_DB_ENV = 'SLAYZONE_TEST_DIAG_EXIT_DB_PATH'
const CHILD_REPORT_ENV = 'SLAYZONE_TEST_DIAG_EXIT_REPORT_PATH'

/** What the child observed about its own exit; written synchronously at `exit`. */
interface ChildExitReport {
  /** Rows on disk when the event loop FIRST drained (`beforeExit`), before any listener ran. */
  rowsAtFirstBeforeExit: number | null
  beforeExitCount: number
  /** Rows on disk at `exit`. */
  rowsAtExit: number
  /** Enqueue → first `beforeExit` / `exit`, child-side. Failure context only, never asserted. */
  msToFirstBeforeExit: number | null
  msToExit: number
}

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
  const reportPath = process.env[CHILD_REPORT_ENV]
  if (!reportPath) throw new Error(`${CHILD_REPORT_ENV} not set`)
  const raw = new Database(childDbPath)
  const countRows = (): number =>
    (raw.prepare(`SELECT COUNT(*) AS n FROM diagnostics_events`).get() as { n: number }).n
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
  const enqueuedAt = performance.now()
  let rowsAtFirstBeforeExit: number | null = null
  let msToFirstBeforeExit: number | null = null
  let beforeExitCount = 0
  // Prepended: runs before the store's own beforeExit flush, so it sees the DB
  // exactly as the drained event loop left it.
  process.prependListener('beforeExit', () => {
    if (beforeExitCount++ === 0) {
      rowsAtFirstBeforeExit = countRows()
      msToFirstBeforeExit = Math.round(performance.now() - enqueuedAt)
    }
  })
  process.on('exit', () => {
    const report: ChildExitReport = {
      rowsAtFirstBeforeExit,
      beforeExitCount,
      rowsAtExit: countRows(),
      msToFirstBeforeExit,
      msToExit: Math.round(performance.now() - enqueuedAt)
    }
    fs.writeFileSync(reportPath, JSON.stringify(report))
  })
  // Nothing else: the process must now exit on its own, flushing first.
} else {
  // The child's runtime flags: tsx for the .ts sources plus the same mock loader
  // the old runner used, both resolved to absolute paths (cwd-independent).
  const require = createRequire(import.meta.url)
  const CHILD_EXEC_ARGV = [
    '--import',
    pathToFileURL(require.resolve('tsx/esm')).href,
    '--experimental-loader',
    pathToFileURL(path.resolve(import.meta.dirname, '../../../../shared/test-utils/loader.ts')).href
  ]

  describe('write-queue flush on exit', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slay-diag-exit-'))
    const dbPath = path.join(dir, 'diagnostics.sqlite')
    const reportPath = path.join(dir, 'exit-report.json')

    afterAll(() => {
      fs.rmSync(dir, { recursive: true, force: true })
    })

    test('queued event does not hold the process open', () => {
      const setup = new Database(dbPath)
      setup.exec(DIAG_SCHEMA)
      setup.close()

      const child = spawnSync(process.execPath, [...CHILD_EXEC_ARGV, import.meta.filename], {
        env: {
          ...process.env,
          ELECTRON_RUN_AS_NODE: '1',
          [CHILD_DB_ENV]: dbPath,
          [CHILD_REPORT_ENV]: reportPath
        },
        encoding: 'utf8',
        // Absolute backstop only (a hung child); the proof is the ordering below.
        timeout: 60_000
      })
      expect(child.status, `${child.stdout}\n${child.stderr}`).toBe(0)

      const report = JSON.parse(fs.readFileSync(reportPath, 'utf8')) as ChildExitReport
      const context = JSON.stringify(report)
      expect(
        report.beforeExitCount,
        `child never drained its event loop: ${context}`
      ).toBeGreaterThan(0)
      expect(
        report.rowsAtFirstBeforeExit,
        `event already flushed when the loop first drained — the flush timer held the process open until it fired: ${context}`
      ).toBe(0)
      expect(report.rowsAtExit, `beforeExit flush did not land before exit: ${context}`).toBe(1)
    })

    test('event queued at natural exit is flushed, not lost', () => {
      const check = new Database(dbPath, { readonly: true })
      const rows = check.prepare(`SELECT message FROM diagnostics_events`).all() as {
        message: string
      }[]
      check.close()
      expect(rows.length).toBe(1)
      expect(rows[0].message).toBe('queued')
    })
  })
}
