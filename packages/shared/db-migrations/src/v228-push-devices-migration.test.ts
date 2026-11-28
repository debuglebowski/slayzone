/**
 * v228: the phones each user signed in with for push notifications (`push_devices`).
 * One row per user and device; a token is held by one row at most.
 *
 * Run with: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron node_modules/vitest/vitest.mjs run \
 *   --config packages/shared/test-utils/vitest.harness.config.ts \
 *   packages/shared/db-migrations/src/v228-push-devices-migration.test.ts
 */
import Database from 'better-sqlite3'
import { expect, test } from 'vitest'
import { migrations } from './index'

function runRange(db: Database.Database, from: number, to: number): void {
  for (const m of migrations)
    if (m.version > from && m.version <= to)
      db.transaction(() => {
        m.up(db)
        db.pragma(`user_version = ${m.version}`)
      })()
}

test('creates push_devices with both kinds on by default; a token is held once', () => {
  const db = new Database(':memory:')
  try {
    runRange(db, 0, 228)
    db.prepare(
      `INSERT INTO push_devices (user_id, device_id, token, hub_ref) VALUES ('u', 'd1', 'ExponentPushToken[a]', 'h')`
    ).run()
    const row = db.prepare('SELECT * FROM push_devices').get() as Record<string, unknown>
    expect(row).toMatchObject({ notify_ready: 1, notify_errors: 1, last_ok_at: null })
    expect(typeof row.created_at).toBe('string')
    expect(() =>
      db
        .prepare(
          `INSERT INTO push_devices (user_id, device_id, token, hub_ref) VALUES ('v', 'd2', 'ExponentPushToken[a]', 'h')`
        )
        .run()
    ).toThrow(/UNIQUE/)
  } finally {
    db.close()
  }
})
