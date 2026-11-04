/**
 * Worker-thread entry for the hub's DIAGNOSTICS database
 * (`slayzone[.dev].diagnostics.sqlite`), bundled as `dist/diag-worker.cjs` beside
 * `bin.cjs`. `openServerDiagnosticsDatabase()` (db.ts) spawns it.
 *
 * Its own worker, never folded into the data DB worker: diagnostics writes must
 * not share a connection or a queue with task/settings data (the isolation the
 * v41 migration established — see the desktop app's `diag-worker.ts`), and a burst
 * of diagnostic writes must not delay a task query.
 *
 * Repair (`selfHealDiagnosticsDb`) is deliberately NOT run here: rotating a file
 * the desktop host may hold open is the hazard, so the host owns repair and starts
 * first. Serves no named transactions.
 */
import Database from 'better-sqlite3'
import { DB_PRAGMAS } from '@slayzone/platform'
import { serveSqliteWorker } from '@slayzone/platform/sqlite-worker-host'
import { applyDiagnosticsPragmas, createDiagnosticsSchema } from '@slayzone/diagnostics/schema'
import type { HubDiagnosticsDbWorkerData } from './db'

serveSqliteWorker<HubDiagnosticsDbWorkerData>({
  label: 'the hub diagnostics DB worker',
  open: (data) => {
    const db = new Database(data.dbPath)
    try {
      // ONE schema definition, shared with the desktop host's diag worker
      // (diagnostics/server/schema.ts): both processes open this file, so two
      // divergent CREATE TABLEs meant whichever got there first decided the
      // other's indexes — and auto_vacuum, which cannot be set afterwards.
      applyDiagnosticsPragmas(db)
      for (const pragma of DB_PRAGMAS) db.pragma(pragma)
      createDiagnosticsSchema(db)
    } catch (err) {
      db.close()
      throw err
    }
    return db
  }
})
