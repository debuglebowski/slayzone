/**
 * v177 (chat composer): `chat_cli_command_details` — the chat CLI's command
 * descriptions + argument hints per project + mode; `chat_tab_state` — a chat
 * tab's draft (text + attached files) and scroll position.
 *
 * Run with: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron node_modules/vitest/vitest.mjs run \
 *   --config packages/shared/test-utils/vitest.harness.config.ts packages/shared/db-migrations/src/v177-chat-composer-migration.test.ts
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
  db.prepare(`INSERT INTO tasks (id, project_id, title) VALUES ('t1', 'p1', 'T')`).run()
  db.prepare(
    `INSERT INTO terminal_tabs (id, task_id, label, mode, is_main, position) VALUES ('tab1', 't1', 'Chat', 'claude-chat', 1, 0)`
  ).run()
  return db
}

describe('v177 chat composer migration', () => {
  test('comes right after v176 (project folders)', () => {
    const versions = migrations.map((m) => m.version)
    expect(versions.indexOf(177)).toBe(versions.indexOf(176) + 1)
  })

  test('chat_cli_command_details: one row per (project, mode), gone with the project', () => {
    const db = freshDb()
    try {
      expect(columns(db, 'chat_cli_command_details')).toEqual([
        'project_id',
        'mode',
        'details',
        'observed_at'
      ])
      const insert = (mode: string): void => {
        db.prepare(
          `INSERT INTO chat_cli_command_details (project_id, mode, details, observed_at) VALUES ('p1', ?, '{}', 1)`
        ).run(mode)
      }
      insert('claude-chat')
      expect(() => insert('claude-chat')).toThrow(/UNIQUE|PRIMARY KEY/)
      db.prepare(`DELETE FROM projects WHERE id = 'p1'`).run()
      expect(db.prepare('SELECT count(*) AS n FROM chat_cli_command_details').get()).toEqual({
        n: 0
      })
    } finally {
      db.close()
    }
  })

  test('chat_tab_state: one row per tab, gone with the tab', () => {
    const db = freshDb()
    try {
      expect(columns(db, 'chat_tab_state')).toEqual([
        'tab_id',
        'draft_text',
        'draft_attachments',
        'scroll_anchor',
        'rev',
        'updated_at'
      ])
      db.prepare(`INSERT INTO chat_tab_state (tab_id, updated_at) VALUES ('tab1', 1)`).run()
      expect(db.prepare(`SELECT draft_text, rev FROM chat_tab_state`).get()).toEqual({
        draft_text: '',
        rev: 0
      })
      expect(() =>
        db.prepare(`INSERT INTO chat_tab_state (tab_id, updated_at) VALUES ('nope', 1)`).run()
      ).toThrow(/FOREIGN KEY/)
      db.prepare(`DELETE FROM terminal_tabs WHERE id = 'tab1'`).run()
      expect(db.prepare('SELECT count(*) AS n FROM chat_tab_state').get()).toEqual({ n: 0 })
    } finally {
      db.close()
    }
  })
})
