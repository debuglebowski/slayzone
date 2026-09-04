import type { SlayzoneDb } from '@slayzone/platform'

/** Raw row shape of the `processes` table (snake_case, SQLite integer booleans). */
export interface ProcessRow {
  id: string
  task_id: string | null
  project_id: string | null
  label: string
  command: string
  cwd: string
  auto_restart: number
  pid: number | null
}

/** The persisted slice of a process — what the manager hands to insert/update. */
export interface PersistedProcess {
  id: string
  taskId: string | null
  projectId: string | null
  label: string
  command: string
  cwd: string
  autoRestart: boolean
}

/** One leader pid this app has itself observed spawning for a process row. */
export interface PidHistoryEntry {
  pid: number
  spawnedAt: string
}

/**
 * Persistence seam for the process manager. The manager never touches the DB
 * directly; it talks to this interface. The default impl
 * (`createDbProcessPersistence`) runs the exact SQL the manager used to run
 * inline — zero behavior change. A future computer-side impl can forward these
 * calls to the hub instead.
 */
export interface ProcessPersistence {
  loadAll(): Promise<ProcessRow[]>
  insert(p: PersistedProcess): Promise<void>
  update(p: PersistedProcess): Promise<void>
  remove(id: string): Promise<void>
  /** Records the pid of the current spawn attempt (or clears it to null on exit/stop) —
   *  written separately from `update()` since it changes on every spawn/exit, not on
   *  config edits, and is read back on the next boot to reap a leftover process that
   *  survived an uncontrolled app exit. */
  updatePid(id: string, pid: number | null): Promise<void>
  /** Durably records `pid` as a leader this row has spawned, in addition to (never
   *  instead of) `updatePid`'s single current-value column — see process_pids (v168).
   *  Never overwrites a previous entry, so an older spawn attempt's pid survives being
   *  superseded by a newer one and can still be found and reaped later. */
  recordPid(processId: string, pid: number): Promise<void>
  /** Every leader pid ever recorded for this row that hasn't been pruned yet. */
  listPidHistory(processId: string): Promise<PidHistoryEntry[]>
  /** Drops one history entry once it's confirmed safe to forget (reaped, already dead,
   *  or confirmed no longer this app's own process). */
  removePidHistory(processId: string, pid: number): Promise<void>
}

/**
 * Default local-DB impl — identical SQL to the pre-seam inline statements.
 *
 * Methods are deliberately NOT `async`: `db.prepare()` can throw synchronously
 * (the sidecar's SyncSlayzoneDb wraps better-sqlite3's sync prepare), and the
 * pre-seam inline `void db?.prepare(...).run(...)` surfaced that throw
 * synchronously to the caller. An `async` wrapper would turn it into a floating
 * unhandled rejection instead — a behavior change this seam must not make.
 */
export function createDbProcessPersistence(db: SlayzoneDb): ProcessPersistence {
  return {
    loadAll(): Promise<ProcessRow[]> {
      return db.prepare('SELECT * FROM processes ORDER BY created_at').all<ProcessRow>()
    },
    insert(p: PersistedProcess): Promise<void> {
      return db
        .prepare(
          'INSERT INTO processes (id, project_id, task_id, label, command, cwd, auto_restart) VALUES (?, ?, ?, ?, ?, ?, ?)'
        )
        .run(p.id, p.projectId, p.taskId, p.label, p.command, p.cwd, p.autoRestart ? 1 : 0)
        .then(() => undefined)
    },
    update(p: PersistedProcess): Promise<void> {
      return db
        .prepare(
          `
    UPDATE processes SET
      project_id = ?, task_id = ?, label = ?, command = ?, cwd = ?, auto_restart = ?
    WHERE id = ?
  `
        )
        .run(p.projectId, p.taskId, p.label, p.command, p.cwd, p.autoRestart ? 1 : 0, p.id)
        .then(() => undefined)
    },
    remove(id: string): Promise<void> {
      // Explicit history cleanup rather than an FK CASCADE — `PRAGMA foreign_keys`
      // is toggled on/off per-connection elsewhere in this codebase (see
      // reset-for-test-txn.ts, export-import-txns.ts), so a cascade can't be
      // relied on to actually fire here.
      return db
        .prepare('DELETE FROM process_pids WHERE process_id = ?')
        .run(id)
        .then(() => db.prepare('DELETE FROM processes WHERE id = ?').run(id))
        .then(() => undefined)
    },
    updatePid(id: string, pid: number | null): Promise<void> {
      return db
        .prepare('UPDATE processes SET pid = ? WHERE id = ?')
        .run(pid, id)
        .then(() => undefined)
    },
    recordPid(processId: string, pid: number): Promise<void> {
      return db
        .prepare('INSERT OR REPLACE INTO process_pids (process_id, pid) VALUES (?, ?)')
        .run(processId, pid)
        .then(() => undefined)
    },
    listPidHistory(processId: string): Promise<PidHistoryEntry[]> {
      return db
        .prepare(
          'SELECT pid, spawned_at as spawnedAt FROM process_pids WHERE process_id = ? ORDER BY spawned_at'
        )
        .all<PidHistoryEntry>(processId)
    },
    removePidHistory(processId: string, pid: number): Promise<void> {
      return db
        .prepare('DELETE FROM process_pids WHERE process_id = ? AND pid = ?')
        .run(processId, pid)
        .then(() => undefined)
    }
  }
}
