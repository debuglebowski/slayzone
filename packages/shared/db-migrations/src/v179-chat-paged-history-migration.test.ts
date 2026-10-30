/**
 * v179 (paged chat history): `chat_events.saved_at` — when an event was saved;
 * `chat_timeline_checkpoints` + `chat_timeline_pages` — the hub's derived
 * timeline projection, gone with its tab.
 *
 * Run with: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron node_modules/vitest/vitest.mjs run \
 *   --config packages/shared/test-utils/vitest.harness.config.ts packages/shared/db-migrations/src/v179-chat-paged-history-migration.test.ts
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

describe('v179 paged chat history migration', () => {
  test('is migration 179, in order (after v178: Codex engine)', () => {
    const versions = migrations.map((m) => m.version)
    const at = versions.indexOf(179)
    expect(at).toBeGreaterThan(0)
    expect(versions[at - 1]).toBeLessThan(179)
    expect(versions.every((v, i) => i === 0 || v > versions[i - 1])).toBe(true)
  })

  test('chat_events.saved_at: optional, so rows saved before keep only created_at', () => {
    const db = freshDb()
    try {
      expect(columns(db, 'chat_events')).toContain('saved_at')
      db.prepare(`INSERT INTO chat_events (tab_id, seq, event) VALUES ('tab1', 0, '{}')`).run()
      db.prepare(
        `INSERT INTO chat_events (tab_id, seq, event, saved_at) VALUES ('tab1', 1, '{}', 1793376000123)`
      ).run()
      const rows = db
        .prepare(`SELECT seq, saved_at, created_at FROM chat_events ORDER BY seq`)
        .all() as Array<{ seq: number; saved_at: number | null; created_at: string }>
      expect(rows[0].saved_at).toBeNull()
      expect(rows[0].created_at).toMatch(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/)
      expect(rows[1].saved_at).toBe(1793376000123)
    } finally {
      db.close()
    }
  })

  test('checkpoint (one per tab) and pages (one per tab + page) are gone with their tab', () => {
    const db = freshDb()
    try {
      expect(columns(db, 'chat_timeline_checkpoints')).toEqual([
        'tab_id',
        'version',
        'seq',
        'data',
        'updated_at'
      ])
      expect(columns(db, 'chat_timeline_pages')).toEqual([
        'tab_id',
        'page',
        'start_row',
        'end_row',
        'rows',
        'summary',
        'search_text'
      ])
      const checkpoint = (): void => {
        db.prepare(
          `INSERT INTO chat_timeline_checkpoints (tab_id, version, seq, data, updated_at) VALUES ('tab1', 'v', 9, '{}', 1)`
        ).run()
      }
      const page = (n: number): void => {
        db.prepare(
          `INSERT INTO chat_timeline_pages (tab_id, page, start_row, end_row, rows, summary, search_text) VALUES ('tab1', ?, 0, 1, '[]', '{}', '')`
        ).run(n)
      }
      checkpoint()
      expect(checkpoint).toThrow(/UNIQUE|PRIMARY KEY/)
      page(0)
      page(1)
      expect(() => page(1)).toThrow(/UNIQUE|PRIMARY KEY/)
      db.prepare(`DELETE FROM terminal_tabs WHERE id = 'tab1'`).run()
      const count = (t: string) =>
        (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n
      expect([count('chat_timeline_checkpoints'), count('chat_timeline_pages')]).toEqual([0, 0])
    } finally {
      db.close()
    }
  })
})
