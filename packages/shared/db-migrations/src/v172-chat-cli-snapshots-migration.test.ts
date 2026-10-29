/**
 * v172: `chat_cli_snapshots` — the last slash-command list a chat CLI advertised,
 * per project + chat mode, so the composer's `/` menu works before a session's
 * first turn.
 *
 * Run with: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron node_modules/vitest/vitest.mjs run \
 *   --config packages/shared/test-utils/vitest.harness.config.ts packages/shared/db-migrations/src/v172-chat-cli-snapshots-migration.test.ts
 */
import Database from 'better-sqlite3'
import { describe, expect, test } from 'vitest'
import { migrations, runMigrations } from './index'

const columns = (db: Database.Database, table: string): string[] =>
  (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name)

function freshDb(): Database.Database {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  runMigrations(db)
  db.prepare(`INSERT INTO projects (id, name, color) VALUES ('p1', 'P', '#000')`).run()
  return db
}

const insert = (db: Database.Database, projectId: string, mode: string): void => {
  db.prepare(
    `INSERT INTO chat_cli_snapshots
       (project_id, mode, slash_commands, terminal_slash_commands, skills, cli_version, observed_at)
     VALUES (?, ?, '["compact"]', '[]', '[]', '2.1.312', 1)`
  ).run(projectId, mode)
}

describe('v172 chat CLI snapshots migration', () => {
  test('directly follows v171', () => {
    const versions = migrations.map((m) => m.version)
    expect(versions.indexOf(172)).toBe(versions.indexOf(171) + 1)
  })

  test('creates the table keyed by (project, mode)', () => {
    const db = freshDb()
    try {
      expect(columns(db, 'chat_cli_snapshots')).toEqual([
        'project_id',
        'mode',
        'slash_commands',
        'terminal_slash_commands',
        'skills',
        'cli_version',
        'observed_at'
      ])
      insert(db, 'p1', 'claude-chat')
      expect(() => insert(db, 'p1', 'claude-chat')).toThrow(/UNIQUE|PRIMARY KEY/)
      insert(db, 'p1', 'codex-chat')
    } finally {
      db.close()
    }
  })

  test('rows go with their project', () => {
    const db = freshDb()
    try {
      insert(db, 'p1', 'claude-chat')
      db.prepare(`DELETE FROM projects WHERE id = 'p1'`).run()
      expect(db.prepare('SELECT count(*) AS n FROM chat_cli_snapshots').get()).toEqual({ n: 0 })
    } finally {
      db.close()
    }
  })
})
