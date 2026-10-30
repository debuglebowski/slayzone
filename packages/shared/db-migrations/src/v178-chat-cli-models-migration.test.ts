/**
 * v178 (Codex chat): `chat_cli_models` — the models a chat CLI offers the
 * account (Codex `model/list`) per project + mode, for the model picker.
 *
 * Run with: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron node_modules/vitest/vitest.mjs run \
 *   --config packages/shared/test-utils/vitest.harness.config.ts packages/shared/db-migrations/src/v178-chat-cli-models-migration.test.ts
 */
import Database from 'better-sqlite3'
import { describe, expect, test } from 'vitest'
import { migrations, runMigrations } from './index'

const columns = (db: Database.Database, table: string): string[] =>
  (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name)

describe('v178 chat CLI models migration', () => {
  test('comes right after v177 (chat composer)', () => {
    const versions = migrations.map((m) => m.version)
    expect(versions.indexOf(178)).toBe(versions.indexOf(177) + 1)
  })

  test('chat_cli_models: one row per (project, mode), gone with the project', () => {
    const db = new Database(':memory:')
    try {
      db.pragma('foreign_keys = ON')
      runMigrations(db)
      db.prepare(`INSERT INTO projects (id, name, color) VALUES ('p1', 'P', '#000')`).run()
      expect(columns(db, 'chat_cli_models')).toEqual([
        'project_id',
        'mode',
        'models',
        'observed_at'
      ])
      const insert = (mode: string): void => {
        db.prepare(
          `INSERT INTO chat_cli_models (project_id, mode, models, observed_at) VALUES ('p1', ?, '[]', 1)`
        ).run(mode)
      }
      insert('codex-chat')
      expect(() => insert('codex-chat')).toThrow(/UNIQUE|PRIMARY KEY/)
      db.prepare(`DELETE FROM projects WHERE id = 'p1'`).run()
      expect(db.prepare('SELECT count(*) AS n FROM chat_cli_models').get()).toEqual({ n: 0 })
    } finally {
      db.close()
    }
  })
})
