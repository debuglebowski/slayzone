/**
 * The periodic write-queue flush timer must never keep a process alive, and an
 * event still queued when the process exits naturally must not be lost.
 *
 * Runs itself as a child: the child binds a file-backed diagnostics DB, records
 * one info event (queued behind the 2s flush timer) and returns. The parent
 * asserts the child exited well before that timer, and that the row landed.
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

    afterAll(() => {
      fs.rmSync(dir, { recursive: true, force: true })
    })

    test('queued event does not hold the process open', () => {
      const setup = new Database(dbPath)
      setup.exec(DIAG_SCHEMA)
      setup.close()

      const started = Date.now()
      const child = spawnSync(process.execPath, [...CHILD_EXEC_ARGV, import.meta.filename], {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', [CHILD_DB_ENV]: dbPath },
        encoding: 'utf8',
        timeout: 15_000
      })
      const elapsed = Date.now() - started
      expect(child.status, `${child.stdout}\n${child.stderr}`).toBe(0)

      // Baseline: the child's own startup (tsx + loader) with the timer cleared.
      // The 2s timer holding the loop pushes it past startup + 2000ms.
      const baseline = spawnSync(process.execPath, [...CHILD_EXEC_ARGV, '-e', ''], {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        timeout: 15_000
      })
      expect(baseline.status).toBe(0)
      const startupMs = Date.now() - started - elapsed
      expect(
        elapsed,
        `child took ${elapsed}ms vs ~${startupMs}ms startup: the flush timer held it`
      ).toBeLessThan(startupMs + 1500)
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
