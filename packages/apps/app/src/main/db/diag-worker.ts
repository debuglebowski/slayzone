import Database from 'better-sqlite3'
import { selfHealDiagnosticsDb, scheduleSalvageMergeForAll } from '@slayzone/diagnostics/self-heal'
import { createDiagnosticsSchema, applyDiagnosticsPragmas } from '@slayzone/diagnostics/schema'
import { serveSqliteWorker } from '@slayzone/platform/sqlite-worker-host'
import type { DiagWorkerData } from './diag-bridge'

/**
 * Diagnostics SQLite worker. Owns the connection to the separate diagnostics DB
 * (`slayzone[.dev].diagnostics.sqlite`); the request loop is the shared one
 * (`@slayzone/platform/sqlite-worker-host`, also serving the hub's two DBs).
 *
 * Kept in its own worker — not folded into the main DB worker — to preserve the
 * isolation the v41 migration established: diagnostics writes must never share a
 * transaction queue or connection with task/settings data, which is what
 * prevents the CLI-notify → tasks:changed → diagnostic-write → notify loop.
 *
 * Startup (self-heal rotate → open → pragmas → schema → schedule background
 * salvage merge) runs before `ready`. Imports only the pure
 * `@slayzone/diagnostics/self-heal` and `/schema` entries — never the `/main`
 * barrel, which pulls Electron via the diagnostics service. Serves no named
 * transactions.
 */
serveSqliteWorker<DiagWorkerData>({
  label: 'the desktop diagnostics DB worker',
  open: (data) => {
    selfHealDiagnosticsDb(data.dbPath)
    const db = new Database(data.dbPath)
    // auto_vacuum MUST be set before any table exists. No-op for pre-existing DBs.
    // ONE schema definition, shared with the hub — see diagnostics/server/schema.ts.
    // Both processes open this file; two divergent CREATE TABLEs meant whichever got
    // there first decided the other's indexes and auto_vacuum.
    applyDiagnosticsPragmas(db)
    createDiagnosticsSchema(db)
    // Repair stays HERE and only here: the host starts before the side-car, and
    // rotating a file a peer holds open is exactly the hazard this whole task is about.
    scheduleSalvageMergeForAll(() => db, data.dbPath)
    return db
  }
})
