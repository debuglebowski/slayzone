/**
 * v185: Codex chat tasks follow the user's default permission mode.
 * A boot backfill tagged every Codex chat entry without a `chatMode` 'bypass' —
 * not a Codex mode, and on every start, so a task that never picked a mode lost
 * the default (Settings → Providers) at the next restart. The tags go; a mode the
 * Codex picker offers stays, and so does every other provider's entry.
 *
 * Run with: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron node_modules/vitest/vitest.mjs run \
 *   --config packages/shared/test-utils/vitest.harness.config.ts packages/shared/db-migrations/src/v185-codex-chat-mode-tags-migration.test.ts
 */
import Database from 'better-sqlite3'
import { describe, expect, test } from 'vitest'
import { migrations, runMigrations } from './index'

function dbUpTo(maxVersion: number): Database.Database {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  for (const m of migrations) {
    if (m.version > maxVersion) break
    db.transaction(() => {
      m.up(db)
      db.pragma(`user_version = ${m.version}`)
    })()
  }
  return db
}

function seed(db: Database.Database, rows: Record<string, string>): void {
  db.prepare(`INSERT INTO projects (id, name, color) VALUES ('p1', 'P', '#000')`).run()
  const ins = db.prepare(
    `INSERT INTO tasks (id, project_id, title, status, provider_config) VALUES (?, 'p1', ?, 'todo', ?)`
  )
  for (const [id, cfg] of Object.entries(rows)) ins.run(id, id, cfg)
}

const cfgOf = (db: Database.Database, id: string): string =>
  (
    db.prepare('SELECT provider_config FROM tasks WHERE id = ?').get(id) as {
      provider_config: string
    }
  ).provider_config

describe('v185 Codex chat mode tags migration', () => {
  test('backfill bypass tags go; picked Codex modes and other providers stay', () => {
    const db = dbUpTo(184)
    seed(db, {
      tagged: JSON.stringify({
        'codex-chat': { flags: '', chatMode: 'bypass', chatConversationId: 'c1' },
        'claude-chat': { chatMode: 'bypass' }
      }),
      picked: JSON.stringify({ 'codex-chat': { chatMode: 'full-access' } }),
      untouched: JSON.stringify({ 'codex-chat': { flags: '' } }),
      broken: '{not json'
    })
    runMigrations(db)
    expect(JSON.parse(cfgOf(db, 'tagged'))).toEqual({
      'codex-chat': { flags: '', chatConversationId: 'c1' },
      'claude-chat': { chatMode: 'bypass' }
    })
    expect(JSON.parse(cfgOf(db, 'picked'))).toEqual({ 'codex-chat': { chatMode: 'full-access' } })
    expect(JSON.parse(cfgOf(db, 'untouched'))).toEqual({ 'codex-chat': { flags: '' } })
    expect(cfgOf(db, 'broken')).toBe('{not json')
  })
})
