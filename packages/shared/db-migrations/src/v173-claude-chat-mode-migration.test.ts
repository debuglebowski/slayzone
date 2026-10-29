/**
 * v173: Claude chat tasks run in the mode their pill shows (bug N2).
 *  - Task create used to copy the claude-chat terminal mode's default flags
 *    (`--allow-dangerously-skip-permissions`) into provider_config, where they
 *    beat the chat mode: those seeded flags are removed (a task's other flags
 *    are kept as extras).
 *  - A boot backfill tagged every Claude chat entry 'bypass', which never really
 *    bypassed (and now would): moved to the new-task default 'auto-accept'.
 * Codex chat and terminal modes are untouched.
 *
 * Run with: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron node_modules/vitest/vitest.mjs run \
 *   --config packages/shared/test-utils/vitest.harness.config.ts packages/shared/db-migrations/src/v173-claude-chat-mode-migration.test.ts
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

const cfgOf = (db: Database.Database, id: string): unknown =>
  JSON.parse(
    (
      db.prepare('SELECT provider_config FROM tasks WHERE id = ?').get(id) as {
        provider_config: string
      }
    ).provider_config
  )

describe('v173 Claude chat mode migration', () => {
  test('seeded flags go, bypass tags become auto-accept, everything else stays', () => {
    const db = dbUpTo(172)
    seed(db, {
      seeded: JSON.stringify({
        'claude-chat': {
          flags: '--allow-dangerously-skip-permissions',
          chatMode: 'bypass',
          chatModel: 'sonnet'
        },
        'claude-code': { flags: '--allow-dangerously-skip-permissions' },
        'codex-chat': { chatMode: 'bypass', flags: '' }
      }),
      padded: JSON.stringify({
        'claude-chat': { flags: '  --allow-dangerously-skip-permissions ' }
      }),
      extras: JSON.stringify({ 'claude-chat': { flags: '--add-dir ../shared', chatMode: 'plan' } }),
      empty: '{}',
      broken: '{not json'
    })
    runMigrations(db)
    expect(cfgOf(db, 'seeded')).toEqual({
      'claude-chat': { chatMode: 'auto-accept', chatModel: 'sonnet' },
      'claude-code': { flags: '--allow-dangerously-skip-permissions' },
      'codex-chat': { chatMode: 'bypass', flags: '' }
    })
    expect(cfgOf(db, 'padded')).toEqual({ 'claude-chat': {} })
    expect(cfgOf(db, 'extras')).toEqual({
      'claude-chat': { flags: '--add-dir ../shared', chatMode: 'plan' }
    })
    expect(cfgOf(db, 'empty')).toEqual({})
    expect(
      (
        db.prepare(`SELECT provider_config FROM tasks WHERE id = 'broken'`).get() as {
          provider_config: string
        }
      ).provider_config
    ).toBe('{not json')
  })

  test('flags equal to a customised claude-chat default are seeded too', () => {
    const db = dbUpTo(172)
    // terminal_modes rows are seeded at runtime; a real DB has this one.
    db.prepare(
      `INSERT OR REPLACE INTO terminal_modes (id, label, type, default_flags, is_builtin)
       VALUES ('claude-chat', 'Claude Chat', 'claude-code', '--verbose', 1)`
    ).run()
    seed(db, { custom: JSON.stringify({ 'claude-chat': { flags: '--verbose' } }) })
    runMigrations(db)
    expect(cfgOf(db, 'custom')).toEqual({ 'claude-chat': {} })
  })
})
