/**
 * Downgrade guard: an older build must refuse a DB migrated by a newer one.
 * Run with: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron node_modules/vitest/vitest.mjs run \
 *   --config packages/shared/test-utils/vitest.harness.config.ts packages/shared/transport/src/db-bootstrap/schema-too-new.test.ts
 */
import Database from 'better-sqlite3'
import { describe, expect, test } from 'vitest'
import { LATEST_MIGRATION_VERSION, runMigrations, SchemaTooNewError } from './index'

describe('schema too new', () => {
  test('refuses a DB newer than the latest migration, without touching it', () => {
    const db = new Database(':memory:')
    try {
      db.pragma(`user_version = ${LATEST_MIGRATION_VERSION + 1}`)
      let thrown: unknown
      try {
        runMigrations(db)
      } catch (err) {
        thrown = err
      }
      expect(thrown).toBeInstanceOf(SchemaTooNewError)
      const msg = (thrown as Error).message
      // message names the DB version and the build version
      expect(msg).toContain(`v${LATEST_MIGRATION_VERSION + 1}`)
      expect(msg).toContain(`v${LATEST_MIGRATION_VERSION}`)
      const tables = db
        .prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table'")
        .get() as {
        n: number
      }
      // no tables created
      expect(tables.n).toBe(0)
      const v = db.pragma('user_version', { simple: true })
      // user_version untouched
      expect(v).toBe(LATEST_MIGRATION_VERSION + 1)
    } finally {
      db.close()
    }
  })

  test('accepts a DB at exactly the latest version (no-op)', () => {
    const db = new Database(':memory:')
    try {
      runMigrations(db)
      runMigrations(db)
      const v = db.pragma('user_version', { simple: true })
      expect(v).toBe(LATEST_MIGRATION_VERSION)
    } finally {
      db.close()
    }
  })
})
