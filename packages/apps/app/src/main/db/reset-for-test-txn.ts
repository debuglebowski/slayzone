import type { Database } from 'better-sqlite3'
import type { TxnSigOf } from '@slayzone/platform'
import { ensureIntegrationSchemaSync } from '@slayzone/integrations/db'
import { syncTerminalModes } from '@slayzone/terminal/db'
import { runMigrations } from '@slayzone/transport/db-bootstrap'
import { normalizeProjectStatusData } from '@slayzone/transport/db-bootstrap'

/**
 * Playwright-only full schema rebuild, run inside the DB worker.
 *
 * Mirrors the original main-thread "drop all tables → re-migrate" block: it must
 * run against the live synchronous connection (the worker's), and it toggles
 * `PRAGMA foreign_keys` / sets `user_version`, which SQLite ignores inside a
 * transaction — so it is NOT wrapped in `db.transaction(...)`. The worker invokes
 * named transactions directly, so that ordering is preserved.
 */
export const resetForTestTxns = {
  'db:reset-for-test': (db: Database): null => {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
      .all() as { name: string }[]
    db.exec('PRAGMA foreign_keys = OFF')
    for (const { name } of tables) db.exec(`DROP TABLE IF EXISTS "${name}"`)
    db.exec('PRAGMA foreign_keys = ON')
    db.pragma('user_version = 0')
    runMigrations(db)
    ensureIntegrationSchemaSync(db)
    normalizeProjectStatusData(db)
    syncTerminalModes(db)
    return null
  }
}

declare module '@slayzone/platform' {
  interface TxnRegistry extends TxnSigOf<typeof resetForTestTxns> {}
}
