import type { Database } from 'better-sqlite3'

/** SQLite PRAGMAs required for all connections to the SlayZone database. */
export const DB_PRAGMAS = [
  'journal_mode = WAL',
  'foreign_keys = ON',
  'synchronous = NORMAL',
  'cache_size = -8000',
  'busy_timeout = 5000'
] as const

/**
 * The SlayZone DB handle type. Aliased here so the engine choice lives in one
 * place — a future swap (e.g. node:sqlite) redefines this single line rather
 * than every consumer. No structural interface: designed from evidence once
 * real procedures exist (slice 4+).
 */
export type SlayzoneDb = Database

/**
 * The DB filename for a given build. `packaged` Electron uses the production
 * file; everything else uses the dev file. Single source of truth so the
 * Electron host and a standalone side-car never disagree on which file to open.
 */
export function getDbName(packaged: boolean): string {
  return packaged ? 'slayzone.sqlite' : 'slayzone.dev.sqlite'
}
