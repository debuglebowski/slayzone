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

/**
 * Persistence seam for the process manager. The manager never touches the DB
 * directly; it talks to this interface. The default impl
 * (`createDbProcessPersistence`) runs the exact SQL the manager used to run
 * inline — zero behavior change. A future runner-side impl can forward these
 * calls to the hub instead.
 */
export interface ProcessPersistence {
  loadAll(): Promise<ProcessRow[]>
  insert(p: PersistedProcess): Promise<void>
  update(p: PersistedProcess): Promise<void>
  remove(id: string): Promise<void>
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
      return db
        .prepare('DELETE FROM processes WHERE id = ?')
        .run(id)
        .then(() => undefined)
    }
  }
}
