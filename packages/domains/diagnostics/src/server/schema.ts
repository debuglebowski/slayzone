/**
 * The diagnostics-events schema — ONE definition, both owners.
 *
 * This file exists because there were two. The Electron host's diag worker created
 * `diagnostics_events` with four indexes and `auto_vacuum = INCREMENTAL`; the hub's
 * `openServerDiagnosticsDatabase` created the same table with two indexes and no
 * auto_vacuum. Both open the same file, so whichever process reached it first
 * decided what the other lived with — and `auto_vacuum` is unrecoverable after the
 * fact, since it must be set before any table exists.
 *
 * That is the same class of defect as the shared DB's two writers, just quieter:
 * nothing errors, you simply get whichever schema won the race.
 *
 * REPAIR IS DELIBERATELY NOT HERE. `selfHealDiagnosticsDb` rotates a corrupt file,
 * which is not safe to do to a path a peer process holds open. The Electron host
 * runs it, alone, before it spawns the side-car; the hub opens without repairing.
 */
import type Database from 'better-sqlite3'

/** Pragmas that must be applied before any table is created. */
export function applyDiagnosticsPragmas(db: Database.Database): void {
  // MUST precede table creation — a no-op on a database that already has tables,
  // which is why the two-owner race above was not recoverable.
  db.pragma('auto_vacuum = INCREMENTAL')
  db.pragma('journal_mode = WAL')
}

/** Idempotent table + index creation. Safe for either owner to call. */
export function createDiagnosticsSchema(db: Database.Database): void {
  db.exec(`
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
    CREATE INDEX IF NOT EXISTS idx_diag_level_ts ON diagnostics_events(level, ts_ms);
    CREATE INDEX IF NOT EXISTS idx_diag_trace ON diagnostics_events(trace_id);
    CREATE INDEX IF NOT EXISTS idx_diag_source_event_ts ON diagnostics_events(source, event, ts_ms);
  `)
}
