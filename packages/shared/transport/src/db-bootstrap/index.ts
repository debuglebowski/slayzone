import type Database from 'better-sqlite3'
import { syncTerminalModes } from '@slayzone/terminal/db'
import { runMigrations } from './migrations'
import { normalizeProjectStatusData } from './status-normalization'

/**
 * Schema bootstrap shared by both DB owners: the Electron app's DB worker
 * (which adds legacy-path migration + pre-migration backup around it) and the
 * standalone @slayzone/server opening a fresh store. Moved out of apps/app in
 * slice 6 so the server package can run migrations without Electron.
 */

export { migrations, LATEST_MIGRATION_VERSION, runMigrations } from './migrations'
export { createPreMigrationBackup } from './pre-migration-backup'
export { normalizeProjectStatusData } from './status-normalization'

/**
 * The worker-startup schema sequence minus host-specific steps (legacy path
 * migration, pre-migration backup — Electron-app concerns). Idempotent.
 */
export function bootstrapSchema(db: Database.Database): void {
  runMigrations(db)
  normalizeProjectStatusData(db)
  syncTerminalModes(db)
}
