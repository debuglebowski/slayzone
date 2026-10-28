/**
 * The hub's schema boot sequence (migrations + domain boot steps), on a fresh DB.
 * Moved here from the v169 migration suite when the boot sequence moved out of
 * the migrations package: it checks the composed boot, not one migration.
 *
 * Run with: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron node_modules/vitest/vitest.mjs run \
 *   --config packages/shared/test-utils/vitest.harness.config.ts packages/apps/hub/src/bootstrap-schema.test.ts
 */
import Database from 'better-sqlite3'
import { describe, expect, test } from 'vitest'
import { settingScope } from '@slayzone/settings/server'
import { bootstrapSchema } from './bootstrap-schema'

describe('bootstrapSchema', () => {
  test('every settings row a fresh database is seeded with is a hub key', () => {
    // A seeded per-user key would not be a default for everyone on a login hub:
    // users never fall back to a global row, and the boot backfill hands it to the
    // first admin. Seed per-user defaults in the client instead.
    const db = new Database(':memory:')
    try {
      bootstrapSchema(db)
      const keys = (db.prepare('SELECT key FROM settings').all() as { key: string }[]).map(
        (r) => r.key
      )
      // something is seeded
      expect(keys.length).toBeGreaterThan(0)
      const notHub = keys.filter((k) => settingScope(k) !== 'hub')
      // seeded keys that are not hub-scoped
      expect(notHub).toEqual([])
    } finally {
      db.close()
    }
  })
})
