import Database from 'better-sqlite3'
import { join } from 'node:path'
import { mkdirSync } from 'node:fs'
import { DB_PRAGMAS, getDataRoot } from '@slayzone/platform'

export interface OpenServerDatabaseOpts {
  dataRoot?: string
  /** When true, opens slayzone.dev.sqlite. Defaults to NODE_ENV !== 'production'. */
  dev?: boolean
}

export function openServerDatabase(opts: OpenServerDatabaseOpts = {}): Database.Database {
  const root = opts.dataRoot ?? getDataRoot()
  mkdirSync(root, { recursive: true })
  const isDev = opts.dev ?? process.env.NODE_ENV !== 'production'
  const dbName = isDev ? 'slayzone.dev.sqlite' : 'slayzone.sqlite'
  const db = new Database(join(root, dbName))
  for (const pragma of DB_PRAGMAS) db.pragma(pragma)
  return db
}
