/**
 * Review regressions, migrations (round 5 K4, round 7 N2): main added its own v194
 * while the branch had a v194 too — two migrations of one version, and a DB already
 * at main's 194 would have skipped the branch's. Part of the ONE review-regression
 * suite (`pnpm test:review-regressions`).
 *
 *   - versions are unique and strictly increasing, in array order (runMigrations
 *     applies them in that order and skips any at or below the DB's version);
 *   - a DB that main's v194 left (computers.disabled_at, the old usage cursors, a
 *     legacy chat tab) reaches the latest version with every row kept.
 *
 * Run with: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron node_modules/vitest/vitest.mjs run \
 *   --config packages/shared/test-utils/vitest.harness.config.ts \
 *   packages/shared/db-migrations/src/review-regressions-migrations.test.ts
 */
import Database from 'better-sqlite3'
import { describe, expect, test } from 'vitest'
import { LATEST_MIGRATION_VERSION, migrations, runMigrations } from './index'

describe('K4: migration versions', () => {
  test('unique and strictly increasing, in the order they are applied', () => {
    const versions = migrations.map((m) => m.version)
    expect(new Set(versions).size, 'unique').toBe(versions.length)
    for (let i = 1; i < versions.length; i++) {
      expect(versions[i], `after ${versions[i - 1]}`).toBeGreaterThan(versions[i - 1] as number)
    }
    expect(LATEST_MIGRATION_VERSION).toBe(versions.at(-1))
  })
})

describe('K4: a DB already at main’s v194 reaches the latest version', () => {
  test('195 and 196 apply, every row kept', () => {
    const db = new Database(':memory:')
    for (const m of migrations) {
      if (m.version > 194) break
      m.up(db)
      db.pragma(`user_version = ${m.version}`)
    }
    expect(db.pragma('user_version', { simple: true })).toBe(194)
    // main's 194 column is there; what the branch's 195/196 carry over is seeded.
    const cols = db.prepare('PRAGMA table_info(computers)').all() as Array<{ name: string }>
    expect(cols.map((c) => c.name)).toContain('disabled_at')
    const hasOldCursors = !!db
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='usage_parse_state'")
      .get()
    // At 194 the cursors are still the hub's own, keyed by file alone.
    expect(hasOldCursors).toBe(true)
    if (hasOldCursors) {
      db.prepare(
        'INSERT INTO usage_parse_state (file_path, last_offset, last_modified_ms) VALUES (?, ?, ?)'
      ).run('/home/u/.claude/projects/x.jsonl', 42, 7)
    }
    const hasLegacyChat = !!db
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='chat_workspace_changes'")
      .get()

    runMigrations(db)

    expect(db.pragma('user_version', { simple: true })).toBe(LATEST_MIGRATION_VERSION)
    const cursorCols = db.prepare('PRAGMA table_info(usage_parse_state)').all() as Array<{
      name: string
    }>
    expect(cursorCols.map((c) => c.name)).toEqual(
      expect.arrayContaining(['computer_id', 'file_path', 'last_offset', 'last_modified_ms'])
    )
    if (hasOldCursors) {
      expect(db.prepare('SELECT * FROM usage_parse_state').all()).toEqual([
        {
          computer_id: '',
          file_path: '/home/u/.claude/projects/x.jsonl',
          last_offset: 42,
          last_modified_ms: 7
        }
      ])
    }
    expect(
      db
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type='table' AND name='chat_legacy_tab_computers'"
        )
        .get(),
      `chat_legacy_tab_computers (legacy chat tables present: ${hasLegacyChat})`
    ).toBeTruthy()
    // Re-running is a no-op.
    runMigrations(db)
    expect(db.pragma('user_version', { simple: true })).toBe(LATEST_MIGRATION_VERSION)
    db.close()
  })
})
