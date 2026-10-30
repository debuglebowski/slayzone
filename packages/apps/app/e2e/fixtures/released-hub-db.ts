/**
 * A hub database exactly as a released build left it: the real migration chain,
 * run up to that release's last version, then seeded with that release's rows.
 * For upgrade specs — the app under test boots on it and migrates the rest.
 *
 * Built with Node's own `node:sqlite`, not better-sqlite3: the test process runs
 * on Node, and better-sqlite3 here is compiled for Electron. Migrations up to the
 * 0.36 line only use `exec` and `prepare().run/get/all`, which both share.
 */
import { DatabaseSync } from 'node:sqlite'
import { migrations } from '@slayzone/db-migrations'

/** The last migration each release shipped (`git show <tag>:…/migrations.ts`). */
export const RELEASED_SCHEMA = { 'v0.36.2': 171 } as const

export function writeReleasedHubDb(
  file: string,
  release: keyof typeof RELEASED_SCHEMA,
  seed: (db: DatabaseSync) => void
): void {
  const version = RELEASED_SCHEMA[release]
  const db = new DatabaseSync(file)
  try {
    for (const m of migrations) {
      if (m.version > version) break
      db.exec('BEGIN')
      m.up(db as never)
      db.exec(`PRAGMA user_version = ${m.version}`)
      db.exec('COMMIT')
    }
    db.exec('BEGIN')
    seed(db)
    db.exec('COMMIT')
  } finally {
    db.close()
  }
}
