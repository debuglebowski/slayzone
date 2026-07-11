import Database from 'better-sqlite3'
import { DB_PRAGMAS, type SlayzoneDb } from '@slayzone/platform'
import { createSlayzoneDbAdapter } from '@slayzone/test-utils'
import { runMigrations } from '@slayzone/transport/db-bootstrap'

export interface TestDb {
  /** Raw synchronous handle — fixture setup + schema introspection. */
  raw: Database.Database
  /** Async `SlayzoneDb` over the SAME connection — what the store expects. */
  db: SlayzoneDb
  close(): void
}

/** Fresh in-memory DB with the FULL production migration chain applied. */
export function createMigratedDb(): TestDb {
  const raw = new Database(':memory:')
  for (const pragma of DB_PRAGMAS) raw.pragma(pragma)
  runMigrations(raw)
  return { raw, db: createSlayzoneDbAdapter(raw), close: () => raw.close() }
}

/** Insert a minimal project + task pair for binding-helper tests. */
export function seedProjectAndTask(raw: Database.Database, projectId: string, taskId: string): void {
  raw
    .prepare(`INSERT INTO projects (id, name, color) VALUES (?, ?, ?)`)
    .run(projectId, 'P', '#000')
  raw
    .prepare(`INSERT INTO tasks (id, project_id, title) VALUES (?, ?, ?)`)
    .run(taskId, projectId, 'T')
}
