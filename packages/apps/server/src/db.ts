import Database from 'better-sqlite3'
import path from 'node:path'
import { DB_PRAGMAS, getDbName, getStateDir, type SlayzoneDb } from '@slayzone/platform'

/**
 * Resolves the SQLite path the side-car should open.
 *
 * Supervised (`SLAYZONE_SUPERVISED=1`): the Electron host already resolved its
 * DB path once and passes that exact absolute string as `SLAYZONE_DB_PATH`.
 * We open it verbatim — no dir/name/dev recombination. If it is missing we
 * hard-error rather than guess: divergence becomes a loud crash, never a
 * silent two-DB split.
 *
 * Standalone: resolve from dir + name like the CLI does.
 */
export function getDatabasePathFromEnv(): string {
  if (process.env.SLAYZONE_SUPERVISED === '1') {
    const p = process.env.SLAYZONE_DB_PATH
    if (!p) {
      throw new Error(
        '[slayzone-server] supervised but SLAYZONE_DB_PATH unset — refusing to guess a DB path'
      )
    }
    return p
  }
  if (process.env.SLAYZONE_DB_PATH) return process.env.SLAYZONE_DB_PATH
  const dir = process.env.SLAYZONE_STORE_DIR ?? process.env.SLAYZONE_DB_DIR ?? getStateDir()
  const name = process.env.SLAYZONE_DB_NAME ?? getDbName(process.env.SLAYZONE_DEV !== '1')
  return path.join(dir, name)
}

export function openServerDatabase(): SlayzoneDb {
  const db = new Database(getDatabasePathFromEnv())
  for (const pragma of DB_PRAGMAS) db.pragma(pragma)
  return db
}
