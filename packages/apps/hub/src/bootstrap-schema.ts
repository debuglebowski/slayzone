import type Database from 'better-sqlite3'
import { runMigrations } from '@slayzone/db-migrations'
import { normalizeProjectStatusData } from '@slayzone/projects/db'
import { syncTerminalModes } from '@slayzone/terminal/db'

/**
 * The schema boot sequence minus host-specific steps (pre-migration backup).
 * Idempotent. Migrations live in `@slayzone/db-migrations` (below every domain);
 * the two steps after them are runtime boot work owned by their domains, so the
 * DB owner composes them here rather than the migrations package importing them.
 */
export function bootstrapSchema(db: Database.Database): void {
  runMigrations(db)
  normalizeProjectStatusData(db)
  syncTerminalModes(db)
}
