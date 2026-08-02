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
    // Enrolled runners must SURVIVE the reset.
    //
    // Agents, terminals and git work all run on runners now, so a wiped `runners`
    // table means the worker's app can no longer execute anything. And it does not
    // self-heal: the runner still holds valid on-disk credentials, so it sends
    // `hello`, the hub (having forgotten it) rejects with -32002, and the re-enroll
    // fallback fails because its join token was single-use — the runner then exits
    // fatally for the rest of the worker's life. Every spec calls resetApp() in
    // beforeAll, so this silently disabled exec for whole spec files.
    //
    // Snapshot + restore rather than skipping the DROP: the reset's contract is a
    // full schema rebuild (it re-runs migrations from user_version 0), and runner
    // rows carry no test-visible state, so re-inserting them keeps isolation while
    // preserving the connection.
    let runners: Record<string, unknown>[] = []
    try {
      runners = db.prepare('SELECT * FROM runners').all() as Record<string, unknown>[]
    } catch {
      // Table absent (fresh DB / pre-v149 schema) — nothing to preserve.
    }

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

    for (const row of runners) {
      const cols = Object.keys(row)
      if (cols.length === 0) continue
      try {
        db.prepare(
          `INSERT OR REPLACE INTO runners (${cols.map((c) => `"${c}"`).join(', ')})
           VALUES (${cols.map(() => '?').join(', ')})`
        ).run(...cols.map((c) => row[c] as never))
      } catch {
        // A column set that no longer matches the rebuilt schema is not worth
        // failing the reset over — the runner will re-enroll on next boot.
      }
    }
    return null
  }
}

declare module '@slayzone/platform' {
  interface TxnRegistry extends TxnSigOf<typeof resetForTestTxns> {}
}
